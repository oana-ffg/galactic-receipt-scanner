"""Synthetic independent-inference boundary and failure preservation checks."""
import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image
import receipt_qwen as qwen
from receipt_api import ClientError


class QwenTests(unittest.TestCase):
    def test_all_pages_are_sent_without_other_readings(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            paths=[root/'one.png',root/'two.png']
            for i,path in enumerate(paths): Image.new('RGB',(5,7),(i,30,50)).save(path)
            response={'model':qwen.MODEL,'done':True,'done_reason':'stop','message':{'content':'{"vendor":null}'}}
            before={'model_digest':'a'*64,'runtime_version':'0.34.0'}
            with patch.object(qwen,'preflight',return_value=before),patch.object(qwen,'request',return_value=response) as request:
                result=qwen.extract(paths,qwen.describe_images(paths),'b'*64,root/'raw.json')
            route,payload=request.call_args.args
            self.assertEqual(route,'/api/chat')
            self.assertEqual(len(payload['messages']),1)
            message=payload['messages'][0]
            self.assertEqual([base64.b64decode(v) for v in message['images']],[p.read_bytes() for p in paths])
            self.assertEqual(message['content'],(Path(qwen.__file__).parent/'receipt_confirmation_prompt.txt').read_text(encoding='utf-8'))
            self.assertEqual(result['images'],qwen.describe_images(paths))
            self.assertEqual(json.loads((root/'raw.json').read_text()),response)

    def test_truncated_response_is_preserved_and_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);page=root/'one.png';Image.new('RGB',(5,7)).save(page)
            response={'model':qwen.MODEL,'done':True,'done_reason':'length','message':{'content':'000000'}}
            with patch.object(qwen,'preflight',return_value={}),patch.object(qwen,'request',return_value=response):
                with self.assertRaisesRegex(ClientError,'incomplete'):
                    qwen.extract([page],qwen.describe_images([page]),'b'*64,root/'raw.json')
            self.assertEqual(json.loads((root/'raw.json').read_text()),response)

    def test_changed_pixels_fail_before_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);page=root/'one.png';Image.new('RGB',(5,7)).save(page)
            expected=qwen.describe_images([page]);Image.new('RGB',(5,7),'white').save(page)
            with patch.object(qwen,'request',side_effect=AssertionError('No network allowed')):
                with self.assertRaisesRegex(ClientError,'pixels changed'):
                    qwen.extract([page],expected,'b'*64,root/'raw.json')


if __name__=='__main__': unittest.main()
