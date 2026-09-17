"""Synthetic geometry, invisible text and provenance checks; no OCR inference/network."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from receipt_api import matches_prepared_ocr
from receipt_ppocr import artifact, original_point, PPBackend


class PPTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('RECEIPT_PP_SMOKE_PROFILE'), 'Opt-in installed-runtime OCR smoke')
    def test_installed_runtime_reads_synthetic_crop(self):
        from PIL import Image, ImageDraw, ImageFont
        profile = Path(os.environ['RECEIPT_PP_SMOKE_PROFILE']).resolve()
        settings = json.loads(profile.read_text(encoding='utf-8'))['ppocr']
        backend = PPBackend(profile, settings)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'receipt.png'
            image = Image.new('RGB', (600, 300), 'white')
            draw = ImageDraw.Draw(image)
            font = ImageFont.load_default(size=35)
            draw.text((25, 30), 'SYNTHETIC SHOP', font=font, fill='black')
            draw.text((25, 100), 'TOTAL DKK 12.34', font=font, fill='black')
            image.save(path)
            source = dict(path=str(path), capture_id='synthetic', sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                          crop=[10, 10, 590, 290], rotation=0)
            manifest, output = root / 'source.json', root / 'ocr.json'
            manifest.write_text(json.dumps(source))
            backend.run(manifest, output)
            value = json.loads(output.read_text(encoding='utf-8'))
            self.assertIn('SYNTHETIC', value['text'])
            self.assertIn('12.34', value['text'])
            self.assertEqual(value['source']['sha256'], source['sha256'])
            self.assertEqual(value['provenance']['engine'], 'PP-OCRv6')

    @unittest.skipUnless(importlib.util.find_spec('pymupdf'), 'Prepared PDF test runtime is required')
    def test_invisible_unicode_text_stays_in_original_crop_for_every_rotation(self):
        import pymupdf
        for rotation in (0,90,180,270):
            with self.subTest(rotation=rotation):
                source=dict(capture_id='synthetic',sha256='a'*64)
                result=dict(rec_texts=['Æble Ørsted'],rec_scores=[0.99],
                            rec_polys=[[[10,10],[90,10],[90,30],[10,30]]])
                value=artifact(source,(300,400),[50,70,250,370],rotation,result,{'engine':'PP-OCRv6'})
                layer=value['text_only_pdf_layers'][0]
                data=base64.b64decode(layer['base64'])
                self.assertEqual(hashlib.sha256(data).hexdigest(),layer['sha256'])
                pdf=pymupdf.open(stream=data,filetype='pdf')
                self.assertEqual(pdf[0].rect,pymupdf.Rect(0,0,300,400))
                self.assertIn('Æble',pdf[0].get_text())
                self.assertTrue(all(v==255 for v in pdf[0].get_pixmap().samples))
                boxes=pdf[0].get_text('blocks')
                self.assertTrue(boxes)
                for block in boxes:
                    self.assertTrue(pymupdf.Rect(50,70,250,370).contains(pymupdf.Rect(*block[:4])))
                box=value['lines'][0]['box']
                for point in result['rec_polys'][0]:
                    x,y=original_point(*point,200,300,rotation)
                    self.assertTrue(box['x0']<=x+50<=box['x1'])
                    self.assertTrue(box['y0']<=y+70<=box['y1'])

    def test_same_engine_region_rotation_contract_for_cached_and_generated_artifacts(self):
        value=dict(text='Synthetic',source=dict(captureId='id',sha256='a'*64,pixels=[20,30],
            region=dict(left=0,top=0,width=20,height=30),rotation=90),provenance=dict(engine='PP-OCRv6'),
            text_only_pdf_layers=[dict(base64='c3ludGhldGlj',sha256='b'*64)])
        backend=SimpleNamespace(engine='PP-OCRv6')
        self.assertTrue(matches_prepared_ocr(value,'id','a'*64,[0,0,20,30],backend,90))
        self.assertFalse(matches_prepared_ocr(value,'id','a'*64,[0,0,20,30],backend,0))
        self.assertFalse(matches_prepared_ocr(value,'id','a'*64,[0,0,20,30],None,90))
        value['provenance']['engine']='tesseract.js synthetic'
        self.assertFalse(matches_prepared_ocr(value,'id','a'*64,[0,0,20,30],backend,90))
        self.assertFalse(matches_prepared_ocr(value,'id','a'*64,[0,0,20,30],None,90))


if __name__=='__main__': unittest.main()
