"""Independent, bounded Qwen vision confirmation using an installed loopback model."""
import base64
import hashlib
import json
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, ProxyHandler, build_opener
from PIL import Image
from receipt_api import ClientError, write_new_file
from receipt_ollama import NoRedirect

ENDPOINT = "http://127.0.0.1:11434"
MODEL = "qwen3-vl:8b-instruct"
OPTIONS = {"temperature": 0, "num_predict": 6000}

def request(route, payload=None, timeout=15):
    if route not in {"/api/version", "/api/tags", "/api/show", "/api/chat"}:
        raise ClientError("Unsupported local confirmation operation.")
    data = json.dumps(payload).encode() if payload is not None else None
    try:
        with build_opener(ProxyHandler({}), NoRedirect()).open(Request(ENDPOINT+route, data=data, headers={"Content-Type":"application/json"}), timeout=timeout) as response:
            raw = response.read(2*1024*1024+1)
            if len(raw)>2*1024*1024:
                raise ClientError("Local confirmation response exceeds the limit.")
            return json.loads(raw)
    except HTTPError as error:
        raise ClientError(f"Local Qwen HTTP {error.code}; no fallback attempted.") from None
    except (URLError, ValueError, TimeoutError):
        raise ClientError("Local Qwen confirmation unavailable or invalid; preserve the attempt.") from None

def preflight():
    row=next((m for m in request('/api/tags')['models'] if m['name']==MODEL),None)
    details=request('/api/show',{'model':MODEL})
    if not row or row.get('size',0)<=0 or 'vision' not in details.get('capabilities',[]) or details.get('remote_host') or details.get('remote_model'):
        raise ClientError("The configured local Qwen vision model must already be installed.")
    return {'model_digest':row['digest'], 'runtime_version':request('/api/version')['version']}

def describe_images(paths):
    result=[]
    if not 0<len(paths)<=100:
        raise ClientError("Confirm every page of one bounded document.")
    total=0
    for name in paths:
        path=Path(name)
        total+=path.stat().st_size
        if total>128*1024*1024:
            raise ClientError("Frozen document exceeds local inference image limit.")
        raw=path.read_bytes()
        with Image.open(path) as img:
            result.append({'sha256':hashlib.sha256(raw).hexdigest(),'pixels':list(img.size)})
    return result

def extract(paths, expected_images, pdf_hash, output):
    if describe_images(paths)!=expected_images:
        raise ClientError("Frozen Qwen pixels changed.")
    before=preflight()
    root=Path(__file__).parent
    prompt=(root/'receipt_confirmation_prompt.txt').read_text(encoding='utf-8')
    schema_text=(root/'receipt_confirmation_schema.json').read_text(encoding='utf-8')
    schema=json.loads(schema_text)
    payload={'model':MODEL,'messages':[{'role':'user','content':prompt,'images':[base64.b64encode(Path(p).read_bytes()).decode() for p in paths]}], 'format':schema,'options':OPTIONS,'stream':False,'keep_alive':'5m'}
    started=time.monotonic()
    response=request('/api/chat',payload,timeout=240)
    write_new_file(Path(output),json.dumps(response,ensure_ascii=False).encode('utf-8'))
    if response.get('model')!=MODEL or not response.get('done') or response.get('done_reason')!='stop' or preflight()!=before:
        raise ClientError("Qwen generation incomplete or model/runtime changed; raw response retained.")
    try:
        extraction=json.loads(response['message']['content'])
    except (ValueError,KeyError):
        raise ClientError("Qwen returned invalid structured extraction; raw response retained.") from None
    return {'model':MODEL,**before,'prompt_sha256':hashlib.sha256(prompt.encode()).hexdigest(),
            'schema_sha256':hashlib.sha256(schema_text.encode()).hexdigest(), 'pixel_pdf_sha256':pdf_hash,
            'images':expected_images,'options':OPTIONS,'extraction':extraction,'done_reason':'stop','elapsed_seconds':time.monotonic()-started}
