CREATE VIRTUAL TABLE document_search USING fts5(payload, tokenize='trigram');
--> statement-breakpoint
INSERT INTO document_search(rowid,payload)
SELECT h.rowid,v.payload FROM document_heads h
JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision;
--> statement-breakpoint
CREATE TRIGGER document_search_head_insert AFTER INSERT ON document_heads BEGIN
  INSERT INTO document_search(rowid,payload)
  SELECT NEW.rowid,v.payload FROM document_versions v
  WHERE v.document_id=NEW.id AND v.revision=NEW.revision;
END;
--> statement-breakpoint
CREATE TRIGGER document_search_head_update AFTER UPDATE OF revision ON document_heads BEGIN
  DELETE FROM document_search WHERE rowid=NEW.rowid;
  INSERT INTO document_search(rowid,payload)
  SELECT NEW.rowid,v.payload FROM document_versions v
  WHERE v.document_id=NEW.id AND v.revision=NEW.revision;
END;
