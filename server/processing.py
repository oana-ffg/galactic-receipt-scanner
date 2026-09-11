import hashlib
import json
import shutil
import subprocess
import tempfile

import cv2
import img2pdf

from server.storage import Store, atomic_write
from server.vision import Detector, crop_document, decode_image


def process_capture(store: Store, detector: Detector, capture_id: str, data: bytes, source: dict):
    image, extension = decode_image(data)
    previous = store.save_raw(capture_id, data, extension, source)
    if previous["status"] in {"accepted", "rejected"}:
        # Same bytes after a lost acknowledgement: do not repeat processing or create duplicates.
        return previous
    quality = detector.analyze(image, full_resolution=True)
    metadata = {
        **source,
        "quality": quality,
        "sourcePixels": [image.shape[1], image.shape[0]],
        "pipelineVersion": "0.1.0",
        "ocrVerified": False,
    }
    if not quality["ok"]:
        return store.finish(capture_id, "rejected", metadata)
    crop = crop_document(image, quality["quad"])
    encoded, buffer = cv2.imencode(
        ".jpg",
        crop,
        [
            cv2.IMWRITE_JPEG_QUALITY,
            95,
            cv2.IMWRITE_JPEG_SAMPLING_FACTOR,
            cv2.IMWRITE_JPEG_SAMPLING_FACTOR_444,
        ],
    )
    if not encoded:
        raise OSError("Could not encode the processed receipt.")
    derivative = buffer.tobytes()
    image_path = store.root / "processed" / f"{capture_id}.jpg"
    atomic_write(image_path, derivative, replace=True)
    pdf = img2pdf.convert(derivative, layout_fun=img2pdf.get_fixed_dpi_layout_fun((300, 300)))
    atomic_write(store.root / "pdfs" / f"{capture_id}.pdf", pdf, replace=True)
    metadata["derivativeSha256"] = hashlib.sha256(derivative).hexdigest()
    return store.finish(capture_id, "accepted", metadata)


def run_ocr(store: Store, capture_id: str, tessdata) -> None:
    executable = shutil.which("tesseract")
    if not executable:
        store.ocr_update(capture_id, "unavailable", "Install Tesseract, then retry OCR.")
        return
    store.ocr_update(capture_id, "running")
    try:
        # Bounded process, private temporary files, one worker. Source bytes are never modified.
        with tempfile.TemporaryDirectory(dir=store.root, prefix=".ocr-") as folder:
            from pathlib import Path

            output = Path(folder) / capture_id
            command = [
                executable,
                str(store.file(capture_id, "image")),
                str(output),
                "--tessdata-dir",
                str(tessdata),
                "-l",
                "dan+eng",
                "--dpi",
                "300",
                "-c",
                "tessedit_create_txt=1",
                "-c",
                "tessedit_create_tsv=1",
                "-c",
                "tessedit_create_pdf=1",
            ]
            result = subprocess.run(
                command, capture_output=True, text=True, timeout=90, check=False
            )
            if result.returncode != 0:
                raise RuntimeError(result.stderr.strip()[-1500:] or "Tesseract failed.")
            for extension in ("txt", "tsv", "pdf"):
                content = output.with_suffix(f".{extension}").read_bytes()
                destination = store.root / ("pdfs" if extension == "pdf" else "ocr")
                atomic_write(destination / f"{capture_id}.{extension}", content, replace=True)
            version = subprocess.run(
                [executable, "--version"], capture_output=True, text=True, timeout=5, check=True
            ).stdout.splitlines()[0]
            atomic_write(
                store.root / "ocr" / f"{capture_id}.json",
                json.dumps(
                    {
                        "engine": version,
                        "languages": ["dan", "eng"],
                        "verified": False,
                        "source": f"processed/{capture_id}.jpg",
                        "note": "Unverified OCR. Check financial values against the original.",
                    },
                    indent=2,
                ).encode(),
                replace=True,
            )
        store.ocr_update(capture_id, "done")
    except Exception as error:
        store.ocr_update(capture_id, "error", str(error))
