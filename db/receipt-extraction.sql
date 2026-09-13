-- Private, local extraction workspace. Originals remain in capture storage.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS extraction_sources (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  original_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS extraction_runs (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS extraction_results (
  run_id TEXT NOT NULL REFERENCES extraction_runs(id),
  source_id TEXT NOT NULL REFERENCES extraction_sources(id),
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  document_type TEXT NOT NULL,
  not_invoice INTEGER CHECK (not_invoice IN (0, 1)),
  has_handwriting INTEGER CHECK (has_handwriting IN (0, 1)),
  vendor TEXT,
  receipt_date TEXT,
  currency TEXT,
  printed_total_minor INTEGER,
  computed_total_minor INTEGER,
  difference_minor INTEGER,
  arithmetic_status TEXT NOT NULL,
  processing_status TEXT NOT NULL,
  filename TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, source_id),
  UNIQUE (run_id, filename)
);
CREATE TABLE IF NOT EXISTS extraction_evidence (
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (run_id, source_id),
  FOREIGN KEY (run_id, source_id) REFERENCES extraction_results(run_id, source_id)
);
CREATE TABLE IF NOT EXISTS extraction_run_config (
  run_id TEXT PRIMARY KEY REFERENCES extraction_runs(id),
  config_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS extraction_attempts (
  run_id TEXT NOT NULL REFERENCES extraction_runs(id),
  source_id TEXT NOT NULL REFERENCES extraction_sources(id),
  raw_path TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  config_sha256 TEXT NOT NULL,
  PRIMARY KEY (run_id, source_id)
);
