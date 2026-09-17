"""Prepared local PP-OCRv6 backend and invisible search-layer adapter. No downloads."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from receipt_api import ClientError, write_new_file, artifact_directory


class PPBackend:
    engine = "PP-OCRv6"

    def __init__(self, profile_path, settings):
        self.profile = str(Path(profile_path).resolve(strict=True))
        self.python = Path(settings['python'])
        if (not self.python.is_absolute() or not self.python.is_file() or
                self.python.is_symlink() or self.python.is_junction() or self.python.name.lower() not in {'python', 'python.exe', 'python3'}):
            raise ClientError('PP OCR needs a prepared absolute Python executable.')
        self.script = str(Path(__file__).resolve())
        self.timeout = settings.get('timeout_seconds', 600)
        if type(self.timeout) is not int or not 60 <= self.timeout <= 7200:
            raise ClientError('PP timeout_seconds must be an integer from 60 to 7200.')

    def call(self, arguments, timeout):
        result = subprocess.run([str(self.python), '-X', 'utf8', '-B', '-I', self.script,
                                 '--profile', self.profile, *arguments], capture_output=True, timeout=timeout)
        if result.returncode:
            # Paddle diagnostics can contain recognized source text; keep them private.
            directory = Path(__file__).resolve().parent.parent / '.local' / 'receipt-ppocr'
            artifact_directory(directory)
            log = directory / ('failure-' + os.urandom(8).hex() + '.log')
            write_new_file(log, result.stdout + b'\n' + result.stderr)
            raise ClientError(f'Prepared PP OCR failed; diagnostics preserved at {log}.')

    def preflight(self):
        self.call(['--check'], 120)

    def run(self, manifest, output):
        self.call(['--source', str(manifest), '--output', str(output)], self.timeout)


def original_point(x, y, width, height, rotation):
    if rotation == 90:
        return y, height - x
    if rotation == 180:
        return width - x, height - y
    if rotation == 270:
        return width - y, x
    return x, y


def artifact(source, image_size, crop, rotation, result, provenance):
    """Map rotated crop OCR to the immutable original and its full-canvas PDF layer."""
    import pymupdf
    left, top, right, bottom = crop
    width, height = right-left, bottom-top
    rotated_size = (height, width) if rotation in (90, 270) else (width, height)
    text_pdf = pymupdf.open()
    page = text_pdf.new_page(width=rotated_size[0], height=rotated_size[1])
    font = pymupdf.Font('cjk')
    page.insert_font(fontname='ocr', fontbuffer=font.buffer)
    lines = []
    for text, score, polygon in zip(result['rec_texts'], result['rec_scores'], result['rec_polys'], strict=True):
        points = [(float(x), float(y)) for x, y in polygon]
        x0, y0 = min(x for x, y in points), min(y for x, y in points)
        x1, y1 = max(x for x, y in points), max(y for x, y in points)
        if not text.strip() or x1 <= x0 or y1 <= y0:
            continue
        size = min((y1-y0)*0.8, (x1-x0)/max(font.text_length(text, fontsize=1), 0.01))
        page.insert_text((x0, y1-(y1-y0)*0.15), text, fontsize=max(0.1, size),
                         fontname='ocr', render_mode=3)
        mapped = [original_point(x, y, width, height, rotation) for x, y in points]
        box = dict(x0=min(x for x,y in mapped)+left, y0=min(y for x,y in mapped)+top,
                   x1=max(x for x,y in mapped)+left, y1=max(y for x,y in mapped)+top)
        lines.append(dict(text=text, confidence=float(score)*100, box=box, words=[],
                          polygon=[[x+left,y+top] for x,y in mapped]))
    full = pymupdf.open()
    target = full.new_page(width=image_size[0], height=image_size[1])
    if lines:
        target.show_pdf_page(pymupdf.Rect(*crop), text_pdf, 0, rotate=rotation)
    # A blank OCR result is preserved as empty search text, never fabricated content.
    full.subset_fonts()
    pdf_bytes = full.tobytes(garbage=4, deflate=True)
    full.close()
    text_pdf.close()
    return dict(schemaVersion=2, verified=False, text='\n'.join(line['text'] for line in lines),
        language=['da', 'en'], source=dict(captureId=source['capture_id'], sha256=source['sha256'],
        pixels=list(image_size), coordinates='original image pixels; top-left origin',
        region=dict(left=left,top=top,width=width,height=height), rotation=rotation),
        provenance=provenance, confidence=sum(line['confidence'] for line in lines)/max(1,len(lines)),
        lines=lines, text_only_pdf_layers=[dict(base64=base64.b64encode(pdf_bytes).decode(),
        sha256=hashlib.sha256(pdf_bytes).hexdigest())], uncertainties=[line for line in lines if line['confidence']<85],
        handwriting=dict(status='unchecked',method='requires visual inspection'),
        review=dict(required=True,notes=['OCR is unverified evidence and search text. Original pixels decide.']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--source')
    parser.add_argument('--output')
    args = parser.parse_args()
    settings = json.loads(Path(args.profile).read_text(encoding='utf-8'))['ppocr']
    models = Path(settings['models'])
    if not models.is_absolute() or models.is_symlink() or models.is_junction():
        raise ClientError('Use a prepared regular PP model directory.')
    hashes = {}
    for kind in ('det','rec'):
        directory = models / f'PP-OCRv6_medium_{kind}_infer'
        for name in ('inference.json','inference.pdiparams'):
            path = directory/name
            if not path.is_file() or path.is_symlink():
                raise ClientError('PP model files are missing; no downloads attempted.')
            hashes[f'{kind}/{name}'] = hashlib.sha256(path.read_bytes()).hexdigest()
    device = settings['device']
    if device not in ('cpu','gpu:0'):
        raise ClientError('Use the prepared CPU or first GPU device.')
    os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    from paddleocr import PaddleOCR
    import paddle
    if device == 'gpu:0' and (not paddle.is_compiled_with_cuda() or paddle.device.cuda.device_count()<1):
        raise ClientError('Configured PP GPU runtime is unavailable; no CPU fallback attempted.')
    engine = PaddleOCR(text_detection_model_name='PP-OCRv6_medium_det',
        text_recognition_model_name='PP-OCRv6_medium_rec',
        text_detection_model_dir=str(models/'PP-OCRv6_medium_det_infer'),
        text_recognition_model_dir=str(models/'PP-OCRv6_medium_rec_infer'),
        use_doc_orientation_classify=False, use_doc_unwarping=False,
        use_textline_orientation=False, device=device, cpu_threads=4, enable_mkldnn=False)
    if args.check:
        return
    if not args.source or not args.output:
        raise ClientError('Provide a source and new output artifact.')
    import numpy as np
    from PIL import Image
    source = json.loads(Path(args.source).read_text(encoding='utf-8'))
    raw = Path(source['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != source['sha256']:
        raise ClientError('Original checksum mismatch.')
    with Image.open(source['path']) as image:
        image = image.convert('RGB')
        pixels = image.size
        crop = source.get('crop') or [0,0,*pixels]
        rotation = source.get('rotation',0)
        if (rotation not in (0,90,180,270) or len(crop)!=4 or
            any(type(v) is not int for v in crop) or not
            (0<=crop[0]<crop[2]<=pixels[0] and 0<=crop[1]<crop[3]<=pixels[1])):
            raise ClientError('Invalid source crop or rotation.')
        selected = image.crop(crop).rotate(-rotation,expand=True)
        started = time.monotonic()
        results = list(engine.predict(np.asarray(selected)[:,:,::-1].copy()))
    if len(results)!=1:
        raise ClientError('Expected one PP OCR page result.')
    result = results[0].json
    result = result.get('res',result)
    import importlib.metadata
    provenance = dict(engine='PP-OCRv6',models=hashes,device=device,
        paddleVersion=paddle.__version__,paddleocrVersion=importlib.metadata.version('paddleocr'),
        elapsedSeconds=time.monotonic()-started,createdAt=datetime.now(timezone.utc).isoformat())
    value = artifact(source,pixels,crop,rotation,result,provenance)
    write_new_file(Path(args.output),json.dumps(value,ensure_ascii=False).encode('utf-8'))


if __name__ == '__main__':
    # Isolated invocation still imports only this checkout's sibling client.
    main()
