"""Synthetic-only tests for immutable local extraction results."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("extraction", Path(__file__).with_name("receipt_extraction.py"))
extraction = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extraction)


class ExtractionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = extraction.connect(self.root / "test.sqlite")
        self.addCleanup(self.db.close)
        original = self.root / "synthetic.txt"
        original.write_bytes(b"SYNTHETIC DOCUMENT. Shop 2026-01-02. 10 + 20 - 5 = 25.")
        self.digest = extraction.sha(original.read_bytes())
        self.manifest = {"samples": [{"captureId": "synthetic-1", "sha256": self.digest,
            "original": str(original), "scanned_at": "2026-09-01T12:00:00Z", "source_pixels": [100, 200]}]}
        extraction.add_sources(self.db, self.manifest)
        extraction.add_run(self.db, "run", "codex", "synthetic-model", "test-v1")
        self.result = {"source_id": "synthetic-1", "sha256": self.digest,
            "document_type": "receipt", "not_invoice": False, "has_handwriting": False,
            "vendor": "Synthetic Shop", "receipt_date": "2026-01-02", "currency": "DKK",
            "reference": None, "printed_total_minor": 2500, "charged_total_minor": None,
            "included_tax_minor": None, "payment_adjustments": [],
            "line_items": [{"description": "A", "quantity": None, "unit_price_minor": None, "amount_minor": 1000},
                           {"description": "B", "quantity": None, "unit_price_minor": None, "amount_minor": 2000}],
            "adjustments": [{"label": "Printed discount", "amount_minor": -500}],
            "arithmetic_basis": "gross", "completeness": "complete", "uncertainties": [],
            "handwritten_notes": [], "evidence": "Synthetic printed amounts."}

    def save(self, result=None):
        extraction.import_results(self.db, "run", [result or self.result])
        return self.db.execute("SELECT * FROM extraction_results").fetchone()

    def test_receipt_arithmetic_filename_and_scan_time(self):
        row = self.save()
        self.assertEqual((row["computed_total_minor"], row["difference_minor"]), (2500, 0))
        self.assertEqual(row["filename"], "2026-01-02_synthetic_shop.pdf")
        self.assertEqual(row["processing_status"], "extracted")
        self.assertEqual(self.db.execute("SELECT scanned_at FROM extraction_sources").fetchone()[0], "2026-09-01T12:00:00Z")

    def test_net_tax_and_credit_signs(self):
        self.result.update(document_type="credit_note", arithmetic_basis="net-plus-tax", printed_total_minor=-1250,
                           line_items=[{"description": "Returned item", "quantity": None, "unit_price_minor": None, "amount_minor": -1000}],
                           adjustments=[{"label": "VAT", "amount_minor": -250}])
        self.assertEqual(self.save()["arithmetic_status"], "matched")

    def test_mismatch_requires_processing_not_false_verified_or_broken(self):
        self.result["printed_total_minor"] = 2400
        row = self.save()
        self.assertEqual((row["arithmetic_status"], row["difference_minor"], row["processing_status"]),
                         ("mismatch", 100, "needs_processing"))

    def test_fragment_waits_without_inventing_missing_total(self):
        self.result.update(completeness="fragment", printed_total_minor=None, receipt_date=None)
        row = self.save()
        self.assertEqual((row["processing_status"], row["computed_total_minor"], row["filename"]),
                         ("awaiting_pages", None, None))

    def test_card_fee_is_separate_from_purchase_total_and_included_tax(self):
        self.result.update(charged_total_minor=2525, included_tax_minor=500,
                           payment_adjustments=[{"label": "Printed card fee", "amount_minor": 25}])
        self.assertEqual(extraction.payment_arithmetic(self.result), 0)
        self.assertEqual(self.save()["computed_total_minor"], 2500)
        self.result["charged_total_minor"] = 2600
        self.assertEqual(extraction.processing_status(self.result, "matched"), "needs_processing")

    def test_noninvoice_no_arithmetic_requirement(self):
        self.result.update(document_type="voucher", not_invoice=True, receipt_date=None,
                           printed_total_minor=None, line_items=[], adjustments=[])
        self.assertEqual(self.save()["arithmetic_status"], "not_applicable")

    def test_invalid_or_uncertain_schema_not_silently_fixed(self):
        for change in ({"receipt_date": "2026-02-30"}, {"not_invoice": True},
                       {"has_handwriting": "false"}, {"printed_total_minor": 25.25},
                       {"arithmetic_basis": "gross/net-plus-tax"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                extraction.validate(self.result | change)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM extraction_results").fetchone()[0], 0)

    def test_handwriting_presence_does_not_require_transcription(self):
        self.result.update(has_handwriting=True, handwritten_notes=[])
        from receipt_extraction import validate
        validate(self.result)

    def test_handwriting_null_and_unclear_note_need_processing(self):
        self.result.update(has_handwriting=True, handwritten_notes=[{"text": None, "uncertain": True, "box": [1, 1, 10, 10]}])
        self.assertEqual(self.save()["processing_status"], "needs_processing")

    def test_same_result_is_idempotent_conflicts_preserve_history(self):
        self.save(); self.save()
        changed = self.result | {"printed_total_minor": 2600}
        with self.assertRaises(ValueError):
            self.save(changed)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM extraction_results").fetchone()[0], 1)
        extraction.add_run(self.db, "correction", "codex", "synthetic-model", "test-v2")
        extraction.import_results(self.db, "correction", [changed])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM extraction_results").fetchone()[0], 2)

    def test_sources_cannot_be_overwritten_or_wrong_hash_imported(self):
        changed = copy.deepcopy(self.manifest)
        changed["samples"][0]["scanned_at"] = "2026-09-02T00:00:00Z"
        with self.assertRaises(ValueError): extraction.add_sources(self.db, changed)
        with self.assertRaises(ValueError): self.save(self.result | {"sha256": "0" * 64})

    def test_atomic_batch_and_collision_names(self):
        second = copy.deepcopy(self.manifest)
        second["samples"][0]["captureId"] = "synthetic-2"
        extraction.add_sources(self.db, second)
        invalid = self.result | {"source_id": "synthetic-2", "receipt_date": "bad"}
        with self.assertRaises(ValueError): extraction.import_results(self.db, "run", [self.result, invalid])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM extraction_results").fetchone()[0], 0)
        extraction.import_results(self.db, "run", [self.result, self.result | {"source_id": "synthetic-2"}])
        self.assertEqual([r[0] for r in self.db.execute("SELECT filename FROM extraction_results ORDER BY source_id")],
                         ["2026-01-02_synthetic_shop.pdf", "2026-01-02_synthetic_shop_2.pdf"])

    def test_missing_and_unexpected_fields_are_rejected(self):
        for key in extraction.SCHEMA['required']:
            value = copy.deepcopy(self.result)
            del value[key]
            with self.subTest(key=key), self.assertRaises(ValueError):
                extraction.validate(value)
        for target in [self.result, self.result['line_items'][0], self.result['adjustments'][0]]:
            target['unexpected'] = 1
            with self.assertRaises(ValueError): extraction.validate(self.result)
            del target['unexpected']
        del self.result['line_items'][0]['quantity']
        with self.assertRaises(ValueError): extraction.validate(self.result)

    def test_unknown_charged_total_with_fee_requires_processing(self):
        self.result['payment_adjustments'] = [{'label': 'Card fee', 'amount_minor': 25}]
        self.assertEqual(self.save()['processing_status'], 'needs_processing')

    def test_original_dimensions_and_handwriting_bounds(self):
        for dimensions in [None, [], [0, 100], [True, 100], [100, '200'], [100, 200, 3]]:
            invalid = copy.deepcopy(self.manifest)
            invalid['samples'][0]['source_pixels'] = dimensions
            with self.subTest(dimensions=dimensions), self.assertRaises(ValueError):
                extraction.add_sources(self.db, invalid)
        self.result.update(has_handwriting=True, handwritten_notes=[{'text':'Test', 'uncertain':False, 'box':[0,0,101,200]}])
        with self.assertRaises(ValueError): self.save()
        self.result['handwritten_notes'][0]['box'] = None
        with self.assertRaises(ValueError): self.save()
        self.result['handwritten_notes'][0]['uncertain'] = True
        self.result['uncertainties'] = ['Note location needs a closer inspection.']
        self.assertEqual(self.save()['processing_status'], 'needs_processing')

    def test_three_printed_discount_layouts(self):
        item = self.result['line_items'][0]
        self.result.update(line_items=[item | {'amount_minor':2500}], adjustments=[])
        self.assertEqual(extraction.arithmetic(self.result), ('matched',2500,0))
        self.result['line_items'] = [item | {'amount_minor':3000}, item | {'description':'Item discount','amount_minor':-500}]
        self.assertEqual(extraction.arithmetic(self.result), ('matched',2500,0))
        self.result.update(line_items=[item | {'amount_minor':3000}], adjustments=[{'label':'Document discount','amount_minor':-500}])
        self.assertEqual(extraction.arithmetic(self.result), ('matched',2500,0))

    def test_atomic_files_preserve_truncation_and_concurrent_conflicts(self):
        from concurrent.futures import ThreadPoolExecutor
        from unittest.mock import patch
        path = self.root / 'raw.json'
        path.write_bytes(b'{truncated')
        with self.assertRaises(ValueError): extraction.save_immutable(path, {'ok':1})
        self.assertEqual(path.read_bytes(), b'{truncated')
        fresh = self.root / 'fresh.json'
        with patch.object(extraction.os, 'link', side_effect=OSError('synthetic failure')):
            with self.assertRaises(OSError): extraction.save_immutable(fresh, {'ok':1})
        self.assertFalse(fresh.exists())
        self.assertEqual(list(self.root.glob('.pending-*')), [])
        def publish(n):
            try:
                extraction.save_immutable(fresh, {'writer':n})
                return n
            except ValueError:
                return None
        with ThreadPoolExecutor(max_workers=4) as pool:
            winners = [v for v in pool.map(publish, range(4)) if v is not None]
        self.assertEqual(len(winners), 1)
        self.assertEqual(json.loads(fresh.read_text()), {'writer':winners[0]})

    def test_audit_includes_failed_attempts_and_rejects_unknown_run(self):
        with self.assertRaises(ValueError): extraction.audit_run(self.db, 'typo')
        self.db.execute("INSERT INTO extraction_attempts VALUES(?,?,?,?,?)", ('run','synthetic-1','private/raw.json','a'*64,'b'*64))
        audit = extraction.audit_run(self.db, 'run')
        self.assertEqual((audit['registered_sources'], audit['imported_results'], audit['pending_results']), (1,0,1))
        self.assertEqual(len(audit['attempts_without_result']),1)
        self.save()
        self.assertEqual(extraction.audit_run(self.db, 'run')['attempts_without_result'], [])


if __name__ == "__main__":
    unittest.main()
