"""Synthetic geometry, invisible text and provenance checks; no OCR inference/network."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from receipt_api import matches_prepared_ocr
from receipt_ppocr import artifact, original_point, PPBackend


class PPTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('RECEIPT_PP_SMOKE_PROFILE'), 'Opt-in installed-runtime OCR smoke')
    def test_installed_runtime_reads_synthetic_crop(self):
        import cv2
        import numpy as np
        from PIL import Image, ImageDraw, ImageFont
        profile = Path(os.environ['RECEIPT_PP_SMOKE_PROFILE']).resolve()
        settings = json.loads(profile.read_text(encoding='utf-8'))['ppocr']
        backend = PPBackend(profile, settings)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'receipt.png'
            receipt = Image.new('RGB', (600, 900), 'white')
            draw = ImageDraw.Draw(receipt)
            font = ImageFont.load_default(size=35)
            draw.text((25, 30), 'SYNTHETIC SHOP', font=font, fill='black')
            draw.text((25, 100), 'TOTAL DKK 12.34', font=font, fill='black')
            source_size = (900, 1200)
            quad = [[120, 70], [790, 120], [730, 1080], [150, 1010]]
            source_corners = np.float32([[0, 0], [599, 0], [599, 899], [0, 899]])
            transform = cv2.getPerspectiveTransform(source_corners, np.float32(quad))
            source_pixels = cv2.warpPerspective(
                np.asarray(receipt), transform, source_size,
                borderValue=(35, 55, 210), flags=cv2.INTER_CUBIC,
            )
            image = Image.fromarray(source_pixels)
            image.save(path)
            layout_result = subprocess.run(
                ['node', 'scripts/receipt_layout.mjs'],
                input=json.dumps({'pixels': list(source_size), 'quad': [[x/source_size[0], y/source_size[1]] for x,y in quad]}),
                text=True, capture_output=True, cwd=Path(__file__).resolve().parent.parent, timeout=30,
            )
            self.assertEqual(layout_result.returncode, 0, layout_result.stderr)
            layout = json.loads(layout_result.stdout)
            source = dict(path=str(path), capture_id='synthetic', sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                          sourcePixels=list(source_size),
                          crop=layout['crop'], rotation=0, quad=[[x/source_size[0], y/source_size[1]] for x,y in quad],
                          geometry=layout['rectification'])
            manifest, output = root / 'source.json', root / 'ocr.json'
            manifest.write_text(json.dumps(source))
            backend.run(manifest, output)
            value = json.loads(output.read_text(encoding='utf-8'))
            self.assertIn('SYNTHETIC', value['text'])
            self.assertIn('12.34', value['text'])
            self.assertEqual(value['source']['sha256'], source['sha256'])
            self.assertEqual(value['provenance']['engine'], 'PP-OCRv6')
            self.assertEqual(value['source']['geometryVersion'], 1)
            self.assertEqual(value['source']['rectification'], source['geometry'])
            self.assertEqual(value['source']['pixels'], source['geometry']['outputPixels'])
            self.assertEqual(value['source']['sourcePixels'], source['sourcePixels'])

    @unittest.skipUnless(importlib.util.find_spec('pymupdf'), 'Prepared PDF test runtime is required')
    def test_invisible_unicode_text_stays_in_rectified_canvas_for_every_rotation(self):
        import pymupdf
        for rotation in (0,90,180,270):
            with self.subTest(rotation=rotation):
                source=dict(capture_id='synthetic',sha256='a'*64,sourcePixels=[200,300],
                            crop=[0,0,200,300])
                result=dict(rec_texts=['Æble Ørsted'],rec_scores=[0.99],
                            rec_polys=[[[10,10],[90,10],[90,30],[10,30]]])
                value=artifact(source,(200,300),rotation,result,{'engine':'PP-OCRv6'})
                layer=value['text_only_pdf_layers'][0]
                data=base64.b64decode(layer['base64'])
                self.assertEqual(hashlib.sha256(data).hexdigest(),layer['sha256'])
                pdf=pymupdf.open(stream=data,filetype='pdf')
                self.assertEqual(pdf[0].rect,pymupdf.Rect(0,0,200,300))
                self.assertIn('Æble',pdf[0].get_text())
                self.assertTrue(all(v==255 for v in pdf[0].get_pixmap().samples))
                boxes=pdf[0].get_text('blocks')
                self.assertTrue(boxes)
                for block in boxes:
                    self.assertTrue(pymupdf.Rect(0,0,200,300).contains(pymupdf.Rect(*block[:4])))
                box=value['lines'][0]['box']
                for point in result['rec_polys'][0]:
                    x,y=original_point(*point,200,300,rotation)
                    self.assertTrue(box['x0']<=x<=box['x1'])
                    self.assertTrue(box['y0']<=y<=box['y1'])

    def test_same_engine_region_rotation_contract_for_cached_and_generated_artifacts(self):
        layout=dict(pixels=[20,30],crop=[0,0,20,30],rectification=None)
        value=dict(text='Synthetic',source=dict(captureId='id',sha256='a'*64,pixels=[20,30],
            sourcePixels=[20,30],sourceCrop=[0,0,20,30],region=dict(left=0,top=0,width=20,height=30),rotation=90,geometryVersion=1,
            rectification=None),provenance=dict(engine='PP-OCRv6'),
            text_only_pdf_layers=[dict(base64='c3ludGhldGlj',sha256='b'*64)])
        backend=SimpleNamespace(engine='PP-OCRv6')
        self.assertTrue(matches_prepared_ocr(value,'id','a'*64,layout,backend,90))
        self.assertFalse(matches_prepared_ocr(value,'id','a'*64,layout,backend,0))
        self.assertFalse(matches_prepared_ocr(value,'id','a'*64,layout,None,90))
        value['provenance']['engine']='tesseract.js synthetic'
        self.assertFalse(matches_prepared_ocr(value,'id','a'*64,layout,backend,90))
        self.assertFalse(matches_prepared_ocr(value,'id','a'*64,layout,None,90))
        value['source']['geometryVersion']=0
        self.assertFalse(matches_prepared_ocr(value,'id','a'*64,layout,backend,90))


if __name__=='__main__': unittest.main()
