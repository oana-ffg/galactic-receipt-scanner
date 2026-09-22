const effectiveStatus = (alias: string) =>
  `(CASE WHEN ${alias}.status='rejected' AND EXISTS(SELECT 1 FROM capture_keeps k WHERE k.capture_id=${alias}.id) THEN 'manual-review' ELSE ${alias}.status END)`;

const currentStatus = effectiveStatus("captures");
const newerStatus = effectiveStatus("newer");
const acceptedStatus = effectiveStatus("accepted");

export const currentTake = `${currentStatus} IN ('accepted','manual-review') AND NOT EXISTS (SELECT 1 FROM captures newer WHERE (newer.receipt_id=COALESCE(captures.receipt_id,captures.id) OR newer.id=COALESCE(captures.receipt_id,captures.id)) AND ${newerStatus} IN ('accepted','manual-review') AND ((${newerStatus}='accepted' AND ${currentStatus}='manual-review') OR (${newerStatus}=${currentStatus} AND newer.take_number>captures.take_number)))`;

export const receiptCount = `SELECT COUNT(DISTINCT COALESCE(receipt_id,id)) FROM captures WHERE ${currentStatus} IN ('accepted','manual-review')`;

export const captureSelection = `SELECT captures.*, ${currentStatus} AS effective_status, (${currentTake}) AS is_current,
  (SELECT json_object('source_sha256',k.source_sha256,'reason',k.reason,'created_at',k.created_at) FROM capture_keeps k WHERE k.capture_id=captures.id) AS kept,
  (SELECT id FROM captures accepted WHERE (accepted.receipt_id=COALESCE(captures.receipt_id,captures.id) OR accepted.id=COALESCE(captures.receipt_id,captures.id)) AND ${acceptedStatus} IN ('accepted','manual-review') ORDER BY (${acceptedStatus}='accepted') DESC,accepted.take_number DESC LIMIT 1) AS current_capture_id,
  EXISTS(SELECT 1 FROM artifacts WHERE capture_id=captures.id AND kind='ocr') AS ocr_available,
  EXISTS(SELECT 1 FROM artifacts WHERE capture_id=captures.id AND kind='image') AS image_available,
  EXISTS(SELECT 1 FROM artifacts WHERE capture_id=captures.id AND kind='pdf') AS pdf_available`;
