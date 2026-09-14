"""Synthetic geometry, invisible text and provenance checks; no OCR inference/network."""
import base64
import hashlib
import importlib.util
import unittest
from types import SimpleNamespace
from receipt_api import matches_prepared_ocr
from receipt_ppocr import artifact, original_point


class PPTests(unittest.TestCase):
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
