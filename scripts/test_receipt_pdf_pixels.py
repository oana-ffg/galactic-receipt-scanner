"""Real PDF/Poppler verification on generated synthetic pages, without scanner access."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
import zlib

from receipt_worker import Worker, ClientError


def test_image(red):
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    rows = b"".join(b"\0" + b"".join(bytes((red, x * 7, y * 7)) for x in range(32)) for y in range(32))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 32, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


GENERATE = r'''
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PDFDocument, StandardFonts, setTextRenderingMode, TextRenderingMode} from 'pdf-lib';
import {addReceiptPage} from './web/receipt-pdf.ts';
const directory=process.argv[1];
const layer=await PDFDocument.create();
const page=layer.addPage([32,32]);
page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
page.drawText('Synthetic OCR', {x:2,y:12,size:3,font:await layer.embedFont(StandardFonts.Helvetica)});
const textBytes=await layer.save();
const ocr={source:{pixels:[32,32]},text_only_pdf_layers:[{
  base64:Buffer.from(textBytes).toString('base64'),sha256:createHash('sha256').update(textBytes).digest('hex')}]};
for (const name of ['draft','searchable','reordered','cropped','rotated','visible']) {
  const pdf=await PDFDocument.create();
  for (const index of name==='reordered' ? [1,0] : [0,1]) {
    await addReceiptPage(pdf,await readFile(join(directory,`source-${index}.png`)), 'image/png',
      name==='rotated'?90:0, name==='cropped'?[2,2,28,28]:[1,1,31,31],
      name==='draft'?undefined:ocr, undefined, name==='draft');
  }
  if(name==='visible') pdf.getPage(0).drawText('VISIBLE', {x:18,y:25,size:5});
  await writeFile(join(directory,`${name}.pdf`),await pdf.save());
}
'''


class PdfPixelsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node, cls.renderer = shutil.which("node"), shutil.which("pdftoppm")
        if not cls.node or not cls.renderer:
            raise unittest.SkipTest("Prepared Node/Poppler required for PDF integration tests")
        cls.repo = Path(__file__).resolve().parent.parent

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        for i, red in enumerate((0, 255)):
            (self.work / f"source-{i}.png").write_bytes(test_image(red))
        program = ("import {build} from 'esbuild'; const built=await build({stdin:{contents:"
                   + json.dumps(GENERATE) + ",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});"
                   "await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));")
        result = subprocess.run([self.node, "--input-type=module", "-e", program, str(self.work)],
                                cwd=self.repo, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        worker = self.worker = Worker.__new__(Worker)
        worker.work, worker.repo, worker.renderer, worker.env = self.work, self.repo, self.renderer, os.environ.copy()
        worker.checkpoint = lambda: None
        def record(label, value):
            path = self.work / (label + ".json")
            path.write_text(json.dumps(value), encoding="utf-8")
            return path.name
        worker.record = record
        draft = self.pdf("draft")
        renders = worker.render_pages(draft["path"], 2, 300, "draft-page", "png")
        worker.state = {"draft": {"pixel_pdf": draft, "rendered": renders,
            "images": [{"sha256": self.sha(path)} for path in renders]},
            "layout_approval": {"sha256": draft["sha256"]}, "document": {"pages": [{}, {}]}}

    def sha(self, path):
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()

    def pdf(self, name):
        path = self.work / (name + ".pdf")
        return {"path": str(path), "sha256": self.sha(path), "pages": 2}

    def compare(self, name):
        self.worker.state["pdf"] = self.pdf(name)
        self.worker.render(300)
        return self.worker.compare_pdf_pixels()

    def test_real_invisible_ocr_preserves_identical_ordered_approved_renders(self):
        proof = self.compare("searchable")
        self.assertTrue(proof["identical"])
        self.assertEqual(proof["dpi"], 300)
        self.assertEqual(len(proof["final_render_sha256"]), 2)

    def test_page_order_crop_rotation_and_visible_overlay_never_auto_pass(self):
        for name in ("reordered", "cropped", "rotated", "visible"):
            with self.subTest(name=name):
                self.assertFalse(self.compare(name)["identical"])

    def test_modified_inspected_render_is_not_accepted_as_baseline(self):
        Path(self.worker.state["draft"]["rendered"][0]).write_bytes(b"modified")
        with self.assertRaisesRegex(ClientError, "Inspected draft render changed"):
            self.compare("searchable")


if __name__ == "__main__":
    unittest.main()
