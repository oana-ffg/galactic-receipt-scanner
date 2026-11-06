import { expect } from "vitest";
import { origin, ownerHeaders } from "./test-runtime.mjs";
export async function saveCapture(mf, retakeOf) {
  const id = crypto.randomUUID();
  const response = await mf.dispatchFetch(`${origin}/api/captures/${id}`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "X-Capture-Status": "accepted",
      ...(retakeOf ? { "X-Retake-Of": retakeOf } : {}),
      "X-Capture-Metadata": JSON.stringify({
        sourcePixels: [1000, 1600],
        quality: { ok: true, receiptPixels: [1000, 1600] },
      }),
    },
    body: new Uint8Array([255, 216, 255, 17]),
  });
  expect(response.status).toBe(200);
  const capture = await response.json();
  // Most Jev tests exercise historical backlog; fresh scans are set explicitly
  // in the settling-window tests.
  const settledAt = new Date(Date.now() - 31 * 60_000).toISOString();
  await (
    await mf.getD1Database("DB")
  )
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind(settledAt, capture.id)
    .run();
  return { ...capture, created_at: settledAt };
}
async function sha256(bytes) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function seedHistoricalOcr(
  mf,
  capture,
  text,
  createdAt,
  region = { left: 0, top: 0, width: 1000, height: 1600 },
) {
  const artifact = {
    source: {
      captureId: capture.id,
      sha256: capture.sha256,
      pixels: [1000, 1600],
      rotation: 0,
      region,
    },
    provenance: { engine: "PP-OCRv6" },
    text,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(artifact));
  const digest = await sha256(bytes);
  const key = `ocr/${capture.id}/${digest}`;
  const db = await mf.getD1Database("DB");
  await (await mf.getR2Bucket("BUCKET")).put(key, bytes);
  await db
    .prepare(
      "INSERT INTO artifacts(key,capture_id,kind,sha256,created_at,content_type) VALUES(?,?,'ocr',?,?,'application/json')",
    )
    .bind(key, capture.id, digest, createdAt)
    .run();
  return digest;
}
export async function processingTokenHash(token) {
  return sha256(new TextEncoder().encode(token));
}
export async function runBackfill(mf, processingToken) {
  const response = await mf.dispatchFetch(`${origin}/api/jev/backfill`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
      Authorization: `Bearer ${processingToken}`,
    },
    body: "{}",
  });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
}
export async function drainBackfill(mf, processingToken, limit = 200) {
  const results = [];
  let complete = false;
  for (let index = 0; index < limit; index += 1) {
    const result = await runBackfill(mf, processingToken);
    results.push(result);
    if (result.remaining === 0) {
      if (complete) return { result, results };
      complete = true;
      continue;
    }
    complete = false;
    expect(result.busy, JSON.stringify(result)).not.toBe(true);
  }
  throw new Error(`Jev backfill did not finish after ${limit} steps.`);
}
export async function paymentJevResponse(request, relationship) {
  const body = await request.json();
  const text = JSON.stringify(body.state);
  const answers = Object.fromEntries(
    Object.entries(body.questions).map(([name, question]) => {
      const choices = Object.keys(question.criteria);
      const selected =
        name === "page_role"
          ? text.includes("BANK STATEMENT")
            ? "account_record"
            : text.includes("PAYMENT SLIP")
              ? "payment_evidence"
              : "receipt"
          : name === "document_role"
            ? text.includes("BANK STATEMENT")
              ? "account_record"
              : text.includes("PAYMENT SLIP") && !text.includes("SHOP RECEIPT")
                ? "payment_evidence_only"
                : "purchase_document"
            : name === "purchase_category"
              ? "unresolved"
              : relationship;
      return [
        name,
        {
          type: "choice",
          choice: selected,
          probabilities: Object.fromEntries(
            choices.map((choice) => [choice, choice === selected ? 1 : 0]),
          ),
          confidence: 1,
        },
      ];
    }),
  );
  return Response.json({ model: "jev-1.13.0", answers });
}
export async function matchingPaymentJevResponse(request) {
  return paymentJevResponse(request, "payment_match");
}
export async function unrelatedPaymentJevResponse(request) {
  return paymentJevResponse(request, "unrelated");
}
export function relationshipOcr(state) {
  return typeof state.current === "string"
    ? { current: state.next, candidate: state.current }
    : {
        current: state.current.ocr,
        candidate: state.candidate.ocr,
      };
}
export async function syntheticJevResponse(request) {
  const body = await request.json();
  const text = JSON.stringify(body.state);
  const answers = Object.fromEntries(
    Object.entries(body.questions).map(([name, question]) => {
      const choices = Object.keys(question.criteria);
      const selected =
        name === "page_role"
          ? "receipt"
          : name === "document_role"
            ? "purchase_document"
            : name === "purchase_category"
              ? "unresolved"
              : name === "decision"
                ? text.includes("TOTAL")
                  ? "yes"
                  : "missing_total"
                : "unrelated";
      return [
        name,
        {
          type: "choice",
          choice: selected,
          probabilities: Object.fromEntries(
            choices.map((choice) => [choice, choice === selected ? 1 : 0]),
          ),
          confidence: 1,
        },
      ];
    }),
  );
  return Response.json({ model: "jev-1.13.0", answers });
}
