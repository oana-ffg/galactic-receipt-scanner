"""Perspective-rectified, searchable multi-page PDF integration coverage."""
import io
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from PIL import Image, ImageDraw


GENERATE = r'''
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PDFDocument, StandardFonts, setTextRenderingMode, TextRenderingMode} from 'pdf-lib';
import {addReceiptPage} from './web/receipt-pdf.ts';
import {receiptRectification} from './web/receipt-rectification.ts';
import {cropPdfImage} from './scripts/pdf_image.mjs';
const root=process.argv[1], pdf=await PDFDocument.create();
for(let i=0;i<3;i++){
  const path=`${root}/source-${i}.png`, bytes=await readFile(path);
  const quad=[[40/260,30/320],[220/260,45/320],[205/260,290/320],[25/260,270/320]];
  const geometry=receiptRectification([260,320],quad);
  const layer=await PDFDocument.create(), [w,h]=geometry.outputPixels;
  const textPage=layer.addPage([w,h]);
  textPage.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
  textPage.drawText(`PAGE ${i+1} TOTAL 12.34`,{x:8,y:h-24,size:12,font:await layer.embedFont(StandardFonts.Helvetica)});
  const layerBytes=await layer.save();
  const ocr={source:{captureId:`source-${i}`,sha256:createHash('sha256').update(bytes).digest('hex'),
    pixels:[w,h],sourcePixels:[260,320],sourceCrop:[0,0,260,320],rotation:0,region:{left:0,top:0,width:w,height:h},geometryVersion:1,rectification:geometry},
    text_only_pdf_layers:[{base64:Buffer.from(layerBytes).toString('base64'),sha256:createHash('sha256').update(layerBytes).digest('hex')}]};
  await addReceiptPage(pdf,bytes,'image/png',0,[0,0,260,320],ocr,quad,false,cropPdfImage);
}
await writeFile(`${root}/rectified.pdf`,await pdf.save());
'''


class RectifiedPdfTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("Prepared Node runtime required")
        cls.repo = Path(__file__).resolve().parent.parent

    def test_perspective_pages_keep_edges_order_and_searchable_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            quad = [(40, 30), (220, 45), (205, 290), (25, 270)]
            for index, marker in enumerate(((255, 0, 0), (0, 255, 0), (255, 255, 0))):
                image = Image.new("RGB", (260, 320), (20, 40, 220))
                ImageDraw.Draw(image).polygon(quad, fill="white")
                ImageDraw.Draw(image).rectangle((100, 120, 140, 160), fill=marker)
                image.save(root / f"source-{index}.png")
            result = subprocess.run(
                [self.node, "--input-type=module", "-e", GENERATE, str(root)],
                cwd=self.repo,
                capture_output=True,
                text=True,
                timeout=90,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

            import pymupdf

            document = pymupdf.open(root / "rectified.pdf")
            self.assertEqual(document.page_count, 3)
            for index, page in enumerate(document):
                with self.subTest(page=index + 1):
                    text = page.get_text()
                    self.assertIn(f"PAGE {index + 1}", text)
                    self.assertIn("TOTAL 12.34", text)
                    self.assertEqual(len(page.get_images()), 1)
                    image_data = document.extract_image(page.get_images()[0][0])["image"]
                    image = Image.open(io.BytesIO(image_data)).convert("RGB")
                    self.assertLess(image.width, 200)
                    self.assertLess(image.height, 200)
                    # The output corners are paper white; the blue desk outside the
                    # saved quadrilateral must never leak into the exported crop.
                    for x, y in ((3, 3), (image.width - 4, 3),
                                 (image.width - 4, image.height - 4), (3, image.height - 4)):
                        pixel = image.getpixel((x, y))
                        self.assertGreater(min(pixel), 175, (index, x, y, pixel))
            self.assertEqual(
                [f"PAGE {i} TOTAL 12.34" for i in range(1, 4)],
                [" ".join(page.get_text().split()) for page in document],
            )


if __name__ == "__main__":
    unittest.main()
