import { afterEach, beforeEach, expect, it } from "vitest";
import { origin, ownerHeaders, runtime } from "../scripts/test-runtime.mjs";
import { newDocument } from "../web/documents";
import { jevOpenTailDocumentId, jevSummary } from "./jev";
import {
  saveCapture,
  seedHistoricalOcr,
  processingTokenHash,
  runBackfill,
  drainBackfill,
  paymentJevResponse,
  matchingPaymentJevResponse,
  unrelatedPaymentJevResponse,
  relationshipOcr,
  syntheticJevResponse,
} from "../scripts/jev-test-fixtures.mjs";

let mf: Awaited<ReturnType<typeof runtime>>;

beforeEach(async () => {
  mf = await runtime();
}, 30_000);

afterEach(async () => mf?.dispose());

it("backfills a historical receipt before its later matching payment slip", async () => {
  const processingToken = `rsc_${"c".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: matchingPaymentJevResponse,
  });
  const receipt = await saveCapture(mf);
  const payment = await saveCapture(mf);
  const db = await mf.getD1Database("DB");
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:00.000Z", receipt.id)
    .run();
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:01.000Z", payment.id)
    .run();
  await seedHistoricalOcr(
    mf,
    receipt,
    "SHOP RECEIPT\nTOTAL 12.34",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    mf,
    payment,
    "PAYMENT SLIP\nTOTAL 12.34",
    "2026-01-01T00:00:01.000Z",
  );
  const { result } = await drainBackfill(mf, processingToken);
  expect(result).toMatchObject({ remaining: 0, blocked: 0 });
  const response = await mf.dispatchFetch(`${origin}/api/documents`, {
    headers: ownerHeaders,
  });
  const catalog = await response.json<any>();
  expect(response.status, JSON.stringify(catalog)).toBe(200);
  const active = catalog.documents.filter(
    (document: any) => !document.mergedInto && !document.duplicateOf,
  );
  expect(active).toHaveLength(1);
  expect(active[0].pages.map((page: any) => page.captureId)).toEqual([
    receipt.id,
    payment.id,
  ]);
});

it("skips an excluded duplicate when matching the next receipt page", async () => {
  const processingToken = `rsc_${"d".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: (request: Request) =>
      paymentJevResponse(request, "continuation"),
  });
  const captures = [
    await saveCapture(mf),
    await saveCapture(mf),
    await saveCapture(mf),
  ];
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of captures.entries()) {
    const at = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(at, capture.id)
      .run();
    await seedHistoricalOcr(mf, capture, `SHOP RECEIPT SECTION ${index}`, at);
  }
  const retained = newDocument(captures[0]);
  const duplicate = newDocument(captures[1]);
  duplicate.duplicateOf = retained.id;
  duplicate.evidence = "Synthetic duplicate of the first section.";
  const saved = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documents: [retained, duplicate] }),
  });
  expect(saved.status).toBe(200);
  await drainBackfill(mf, processingToken);
  const catalog = await (
    await mf.dispatchFetch(`${origin}/api/documents`, { headers: ownerHeaders })
  ).json<any>();
  expect(
    catalog.documents
      .find((item: any) => item.id === retained.id)
      .pages.map((page: any) => page.captureId),
  ).toEqual([captures[0].id, captures[2].id]);
  expect(
    catalog.documents.find((item: any) => item.id === duplicate.id),
  ).toMatchObject({
    duplicateOf: retained.id,
    pages: [{ captureId: captures[1].id }],
  });
});

it("rechecks a changed page and its successor without replaying the later tail", async () => {
  const processingToken = `rsc_${"e".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: unrelatedPaymentJevResponse,
  });
  const captures = [
    await saveCapture(mf),
    await saveCapture(mf),
    await saveCapture(mf),
    await saveCapture(mf),
  ];
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of captures.entries()) {
    const at = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(at, capture.id)
      .run();
    await seedHistoricalOcr(mf, capture, `SHOP RECEIPT SECTION ${index}`, at);
  }
  await drainBackfill(mf, processingToken);
  const assessments = async () =>
    (await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jev_assessments WHERE task='document-relationship-scan-v1'",
      )
      .first<{ count: number }>())!.count;
  expect(await assessments()).toBe(3);
  await db.prepare("DELETE FROM jev_continuity_edges").run();
  expect((await runBackfill(mf, processingToken)).remaining).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jev_continuity_edges WHERE relationship='verified-history'",
      )
      .first(),
  ).toEqual({ count: 4 });
  await db
    .prepare(
      "UPDATE jev_continuity_edges SET processed_at=? WHERE capture_id=?",
    )
    .bind("2000-01-01T00:00:00.000Z", captures[3].id)
    .run();
  await seedHistoricalOcr(
    mf,
    captures[1],
    "SHOP RECEIPT SECTION 1 WITH CORRECTED OCR",
    "2026-02-01T00:00:00.000Z",
  );
  await drainBackfill(mf, processingToken);
  expect(await assessments()).toBe(5);
  expect(
    await db
      .prepare(
        "SELECT processed_at FROM jev_continuity_edges WHERE capture_id=?",
      )
      .bind(captures[3].id)
      .first(),
  ).toEqual({ processed_at: "2000-01-01T00:00:00.000Z" });
});

it("waits for an active old step but reclaims an expired one without replaying", async () => {
  const processingToken = `rsc_${"z".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: unrelatedPaymentJevResponse,
  });
  const capture = await saveCapture(mf);
  const db = await mf.getD1Database("DB");
  const now = "2030-01-01T00:00:00.000Z";
  await db
    .prepare(
      "INSERT INTO jev_pipeline_runs(id,version,phase,snapshot_created_at,snapshot_capture_id,cursor,step_token,step_started_at,created_at,updated_at) VALUES(?,7,'group',?,?,NULL,?,?,?,?)",
    )
    .bind("old-run", now, capture.id, "active-token", now, now, now)
    .run();
  expect(await runBackfill(mf, processingToken)).toMatchObject({ busy: true });
  await db
    .prepare(
      "UPDATE jev_pipeline_runs SET step_started_at=? WHERE id='old-run'",
    )
    .bind("2020-01-01T00:00:00.000Z")
    .run();
  await runBackfill(mf, processingToken);
  expect(
    await db
      .prepare(
        "SELECT version,step_token FROM jev_pipeline_runs WHERE id='old-run'",
      )
      .first(),
  ).toEqual({ version: 7, step_token: null });
});

it("finishes a version-eight group run with an empty cursor using its original document order", async () => {
  const processingToken = `rsc_${"o".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: (request: Request) =>
      paymentJevResponse(request, "unrelated"),
  });
  const db = await mf.getD1Database("DB");
  const captures = [];
  for (let index = 0; index < 2; index += 1) {
    const capture = await saveCapture(mf);
    captures.push(capture);
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(mf, capture, `SHOP RECEIPT ${index}`, createdAt);
  }
  await drainBackfill(mf, processingToken);
  await db.prepare("DELETE FROM jev_continuity_edges").run();
  await db
    .prepare(
      "INSERT INTO jev_pipeline_runs(id,version,phase,snapshot_created_at,snapshot_capture_id,cursor,created_at,updated_at) VALUES(?,8,'group',?,?,NULL,?,?)",
    )
    .bind(
      "old-group-run",
      "2026-01-01T00:00:01.000Z",
      captures[1].id,
      "2030-01-01T00:00:00.000Z",
      "2030-01-01T00:00:00.000Z",
    )
    .run();
  const step = await runBackfill(mf, processingToken);
  expect(step).toMatchObject({
    phase: "group",
    result: { status: "boundary" },
  });
  const saved = await db
    .prepare("SELECT cursor FROM jev_pipeline_runs WHERE id='old-group-run'")
    .first<{ cursor: string }>();
  expect(JSON.parse(saved!.cursor)).toEqual({
    finalize_id: captures[0].id,
    next_id: captures[1].id,
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM jev_continuity_edges")
      .first(),
  ).toEqual({ count: 0 });
  expect((await drainBackfill(mf, processingToken)).result.phase).toBe(
    "complete",
  );
});

it("does not replay saved continuity just because the pipeline version changed", async () => {
  const processingToken = `rsc_${"v".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const first = await saveCapture(mf);
  const second = await saveCapture(mf);
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of [first, second].entries()) {
    const at = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(at, capture.id)
      .run();
    await seedHistoricalOcr(mf, capture, `SHOP RECEIPT SECTION ${index}`, at);
  }
  await drainBackfill(mf, processingToken);
  const assessment = await db
    .prepare(
      "SELECT id,payload FROM jev_assessments WHERE task='document-relationship-scan-v1'",
    )
    .first<{ id: string; payload: string }>();
  expect(assessment).not.toBeNull();
  const payload = JSON.parse(assessment!.payload);
  payload.response.answers.relationship = {
    type: "choice",
    choice: "continuation",
    probabilities: {
      continuation: 0.4,
      payment_match: 0.22,
      duplicate: 0,
      unrelated: 0.38,
    },
    confidence: 0.09,
  };
  await db
    .prepare("UPDATE jev_assessments SET payload=? WHERE id=?")
    .bind(JSON.stringify(payload), assessment!.id)
    .run();
  await db
    .prepare("UPDATE jev_pipeline_runs SET version=5 WHERE phase='complete'")
    .run();
  await drainBackfill(mf, processingToken);
  const catalog = await (
    await mf.dispatchFetch(`${origin}/api/documents`, { headers: ownerHeaders })
  ).json<any>();
  const active = catalog.documents.filter(
    (document: any) => !document.mergedInto && !document.duplicateOf,
  );
  expect(active).toHaveLength(2);
  expect(active.map((document: any) => document.id).sort()).toEqual(
    [first.id, second.id].sort(),
  );
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jev_assessments WHERE task='document-relationship-scan-v1'",
      )
      .first(),
  ).toEqual({ count: 1 });
});

it("does not let an older completed artifact hide a newer unqueued PP artifact", async () => {
  const processingToken = `rsc_${"d".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const capture = await saveCapture(mf);
  const older = await seedHistoricalOcr(
    mf,
    capture,
    "",
    "2026-01-01T00:00:00.000Z",
  );
  await drainBackfill(mf, processingToken);
  const newer = await seedHistoricalOcr(
    mf,
    capture,
    " ",
    "2026-01-01T00:00:01.000Z",
  );
  expect(newer).not.toBe(older);
  const db = await mf.getD1Database("DB");
  expect(
    (
      await db
        .prepare(
          "SELECT artifact.capture_id,artifact.sha256 FROM artifacts artifact WHERE artifact.kind='ocr' AND NOT EXISTS (SELECT 1 FROM artifacts newer WHERE newer.capture_id=artifact.capture_id AND newer.kind='ocr' AND (newer.created_at>artifact.created_at OR (newer.created_at=artifact.created_at AND newer.key>artifact.key))) AND NOT EXISTS (SELECT 1 FROM jev_jobs job WHERE job.capture_id=artifact.capture_id AND job.ocr_sha256=artifact.sha256)",
        )
        .all()
    ).results,
  ).toEqual([{ capture_id: capture.id, sha256: newer }]);
  const resumed = await runBackfill(mf, processingToken);
  expect(resumed).toMatchObject({ remaining: 1, phase: "pages" });
  expect((await drainBackfill(mf, processingToken)).result).toMatchObject({
    remaining: 0,
    phase: "complete",
  });
  expect(
    (
      await db
        .prepare(
          "SELECT ocr_sha256,status FROM jev_jobs WHERE capture_id=? ORDER BY created_at,id",
        )
        .bind(capture.id)
        .all()
    ).results,
  ).toEqual([
    { ocr_sha256: older, status: "complete" },
    { ocr_sha256: newer, status: "complete" },
  ]);
  expect(
    await db
      .prepare("SELECT ocr_sha256 FROM jev_page_heads WHERE capture_id=?")
      .bind(capture.id)
      .first(),
  ).toEqual({ ocr_sha256: newer });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_jobs").first(),
  ).toEqual({ count: 2 });
});

it("defers PP refreshes during grouping and reruns the complete pipeline", async () => {
  const processingToken = `rsc_${"k".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const capture = await saveCapture(mf);
  const older = await seedHistoricalOcr(
    mf,
    capture,
    "",
    "2026-01-01T00:00:00.000Z",
  );
  let step: any;
  for (let index = 0; index < 20; index += 1) {
    step = await runBackfill(mf, processingToken);
    if (step.phase === "group") break;
  }
  expect(step.phase).toBe("group");
  const refresh = await mf.dispatchFetch(
    `${origin}/api/captures/${capture.id}/artifacts/ocr`,
    {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: {
          captureId: capture.id,
          sha256: capture.sha256,
          pixels: [1000, 1600],
          rotation: 0,
          region: { left: 0, top: 0, width: 1000, height: 1600 },
        },
        provenance: { engine: "PP-OCRv6" },
        text: " ",
      }),
    },
  );
  const saved = await refresh.json<any>();
  expect(refresh.status, JSON.stringify(saved)).toBe(200);
  expect(saved.jev.status).toBe("pending");
  expect(saved.sha256).not.toBe(older);
  await drainBackfill(mf, processingToken);
  const db = await mf.getD1Database("DB");
  expect(
    await db
      .prepare("SELECT ocr_sha256 FROM jev_page_heads WHERE capture_id=?")
      .bind(capture.id)
      .first(),
  ).toEqual({ ocr_sha256: saved.sha256 });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_jobs").first(),
  ).toEqual({ count: 2 });
  expect(
    (
      await db
        .prepare("SELECT DISTINCT status FROM jev_jobs ORDER BY status")
        .all()
    ).results,
  ).toEqual([{ status: "complete" }]);
});

it("retires classified work when its capture is superseded mid-pipeline", async () => {
  const processingToken = `rsc_${"l".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const original = await saveCapture(mf);
  await seedHistoricalOcr(mf, original, "", "2026-01-01T00:00:00.000Z");
  expect(await runBackfill(mf, processingToken)).toMatchObject({
    result: { status: "classified" },
    phase: "pages",
  });
  await saveCapture(mf, original.id);
  const { result } = await drainBackfill(mf, processingToken);
  expect(result).toMatchObject({ remaining: 0, phase: "complete" });
  const db = await mf.getD1Database("DB");
  expect(
    await db
      .prepare(
        "SELECT status,ineligible_reason FROM jev_jobs WHERE capture_id=?",
      )
      .bind(original.id)
      .first(),
  ).toEqual({
    status: "ineligible",
    ineligible_reason: "capture_not_current",
  });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jev_pipeline_runs WHERE phase!='complete'",
      )
      .first(),
  ).toEqual({ count: 0 });
});

it("groups forward once per adjacent document and preserves the first boundary", async () => {
  const processingToken = `rsc_${"e".repeat(43)}`;
  const relationshipPairs: { current: string; candidate: string }[] = [];
  let firstScanRequest: any;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      let relationship: "continuation" | "unrelated" = "unrelated";
      if (body.questions.relationship) {
        if (typeof body.state.current === "string" && !firstScanRequest)
          firstScanRequest = body;
        const { current, candidate } = relationshipOcr(body.state);
        const indexOf = (text: string) =>
          text.includes("PAYMENT SLIP")
            ? 0
            : Number(text.match(/SHOP RECEIPT (\d)/)?.[1]);
        const currentIndex = indexOf(current);
        const candidateIndex = indexOf(candidate);
        relationshipPairs.push({
          current: captures[currentIndex].id,
          candidate: captures[candidateIndex].id,
        });
        if (currentIndex === 2 && candidateIndex === 1)
          relationship = "continuation";
      }
      return paymentJevResponse(request, relationship);
    },
  });
  const captures = [];
  const db = await mf.getD1Database("DB");
  for (let index = 0; index < 3; index += 1) {
    const capture = await saveCapture(mf);
    captures.push(capture);
    const createdAt = `2026-01-01T00:00:${index.toString().padStart(2, "0")}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(
      mf,
      capture,
      index === 0
        ? "PAYMENT SLIP\nTOTAL 12.34"
        : `SHOP RECEIPT ${index}\nTOTAL 12.34`,
      createdAt,
    );
  }
  const { result } = await drainBackfill(mf, processingToken);
  expect(result).toMatchObject({
    remaining: 0,
    blocked: 0,
    phase: "complete",
  });
  expect(firstScanRequest.state).toEqual({
    current: "Page 1:\nPAYMENT SLIP\nTOTAL 12.34",
    next: "Page 1:\nSHOP RECEIPT 1\nTOTAL 12.34",
  });
  expect(firstScanRequest.questions.relationship).toMatchObject({
    instructions:
      "The user is scanning receipts. Your job is to determine if the next page is likely a new page, part of the same receipt as current, or the first page of a new receipt.",
    criteria: {
      continuation:
        "The next page is part of the same receipt as the one we currently have",
      payment_match: "The next page is a payment slip for the current receipt",
      duplicate:
        "The next page is a duplicate, containing only the exact same information we already have in the current receipt",
      unrelated:
        "The next page is the start of a new receipt, not part of the same transaction as the current one",
    },
  });
  expect(relationshipPairs).toEqual([
    { current: captures[1].id, candidate: captures[0].id },
    { current: captures[2].id, candidate: captures[1].id },
    { current: captures[1].id, candidate: captures[0].id },
  ]);
  expect(
    await db
      .prepare(
        "SELECT COUNT(DISTINCT candidate_id) AS count,MIN(candidate_id) AS candidate_id FROM jev_assessments WHERE task='document-relationship-scan-v1' AND subject_id=?",
      )
      .bind(captures[2].id)
      .first(),
  ).toEqual({ count: 1, candidate_id: captures[1].id });
  const catalog = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  expect(
    catalog.documents.find((document: any) => document.id === captures[1].id)
      .pages,
  ).toHaveLength(2);
});

it("persists the forward grouping cursor between requests", async () => {
  const processingToken = `rsc_${"w".repeat(43)}`;
  const relationshipPairs: string[] = [];
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      if (body.questions.relationship) {
        const { current, candidate } = relationshipOcr(body.state);
        const currentIndex = Number(current.match(/SHOP RECEIPT (\d)/)?.[1]);
        const candidateIndex = Number(
          candidate.match(/SHOP RECEIPT (\d)/)?.[1],
        );
        relationshipPairs.push(
          `${captures[currentIndex].id}|${captures[candidateIndex].id}`,
        );
      }
      return paymentJevResponse(request, "unrelated");
    },
  });
  const captures = [
    await saveCapture(mf),
    await saveCapture(mf),
    await saveCapture(mf),
  ];
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of captures.entries()) {
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(
      mf,
      capture,
      `SHOP RECEIPT ${index} 19.09.2026`,
      createdAt,
    );
  }
  let step: any;
  for (let index = 0; index < 10; index += 1) {
    step = await runBackfill(mf, processingToken);
    if (step.phase === "group") break;
  }
  expect(step.phase).toBe("group");
  expect(relationshipPairs).toEqual([]);

  expect(await runBackfill(mf, processingToken)).toMatchObject({
    result: { status: "boundary", current_document_id: captures[0].id },
    phase: "group",
  });
  expect(relationshipPairs).toEqual([]);
  const firstCursor = await db
    .prepare(
      "SELECT cursor FROM jev_pipeline_runs WHERE phase='group' ORDER BY created_at DESC LIMIT 1",
    )
    .first<{ cursor: string }>();
  expect(JSON.parse(firstCursor!.cursor)).toEqual({
    last_created_at: "2026-01-01T00:00:00.000Z",
    last_capture_id: captures[0].id,
  });

  await runBackfill(mf, processingToken);
  expect(relationshipPairs).toEqual([`${captures[1].id}|${captures[0].id}`]);
  const finalized = await db
    .prepare(
      "SELECT cursor FROM jev_pipeline_runs WHERE phase='group' ORDER BY created_at DESC LIMIT 1",
    )
    .first<{ cursor: string }>();
  expect(JSON.parse(finalized!.cursor)).toEqual({
    last_created_at: "2026-01-01T00:00:01.000Z",
    last_capture_id: captures[1].id,
  });
  await runBackfill(mf, processingToken);
  expect(relationshipPairs).toEqual([
    `${captures[1].id}|${captures[0].id}`,
    `${captures[2].id}|${captures[1].id}`,
  ]);
  expect(
    (
      await db
        .prepare(
          "SELECT capture_id,previous_capture_id FROM jev_continuity_edges ORDER BY scan_created_at,capture_id",
        )
        .all()
    ).results,
  ).toEqual([
    { capture_id: captures[0].id, previous_capture_id: null },
    { capture_id: captures[1].id, previous_capture_id: captures[0].id },
    { capture_id: captures[2].id, previous_capture_id: captures[1].id },
  ]);
});

it("seeds verified continuity once and checks only a newly scanned page", async () => {
  const processingToken = `rsc_${"v".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: (request: Request) =>
      paymentJevResponse(request, "unrelated"),
  });
  const db = await mf.getD1Database("DB");
  const captures = [];
  for (let index = 0; index < 2; index += 1) {
    const capture = await saveCapture(mf);
    captures.push(capture);
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(mf, capture, `SHOP RECEIPT ${index}`, createdAt);
  }
  expect((await drainBackfill(mf, processingToken)).result.phase).toBe(
    "complete",
  );
  const scanCount = async () =>
    (await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jev_assessments WHERE task='document-relationship-scan-v1'",
      )
      .first<{ count: number }>())!.count;
  expect(await scanCount()).toBe(1);

  // Simulate adopting the new marker after an already completed Jev replay.
  await db.prepare("DELETE FROM jev_continuity_edges").run();
  expect(await runBackfill(mf, processingToken)).toMatchObject({
    phase: "complete",
    remaining: 0,
  });
  expect(
    (await db
      .prepare("SELECT COUNT(*) AS count FROM jev_continuity_edges")
      .first<{ count: number }>())!.count,
  ).toBe(2);
  expect(await scanCount()).toBe(1);
  const status = await (
    await mf.dispatchFetch(`${origin}/api/jev/status`, {
      headers: { ...ownerHeaders, Authorization: `Bearer ${processingToken}` },
    })
  ).json<any>();
  expect(status).toMatchObject({
    current_captures_continuity_processed: 2,
    current_captures_continuity_pending: 0,
  });

  const capture = await saveCapture(mf);
  const createdAt = "2026-01-01T00:00:02.000Z";
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind(createdAt, capture.id)
    .run();
  await seedHistoricalOcr(mf, capture, "SHOP RECEIPT 2", createdAt);
  expect((await drainBackfill(mf, processingToken)).result.phase).toBe(
    "complete",
  );
  expect(await scanCount()).toBe(2);
  const newEdge = await db
    .prepare(
      "SELECT previous_capture_id,relationship FROM jev_continuity_edges WHERE capture_id=?",
    )
    .bind(capture.id)
    .first<{ previous_capture_id: string; relationship: string }>();
  expect(newEdge).toMatchObject({
    previous_capture_id: captures[1].id,
    relationship: "unrelated",
  });
});

it("seeds completed scan markers without advancing an active later pipeline", async () => {
  const processingToken = `rsc_${"s".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: (request: Request) =>
      paymentJevResponse(request, "unrelated"),
  });
  const db = await mf.getD1Database("DB");
  const captures = [await saveCapture(mf), await saveCapture(mf)];
  for (const [index, capture] of captures.entries()) {
    const at = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(at, capture.id)
      .run();
    await seedHistoricalOcr(mf, capture, `SHOP RECEIPT ${index}`, at);
  }
  expect((await drainBackfill(mf, processingToken)).result.phase).toBe(
    "complete",
  );
  const beforeAssessments = await db
    .prepare("SELECT COUNT(*) AS count FROM jev_assessments")
    .first<{ count: number }>();
  await db.prepare("DELETE FROM jev_continuity_edges").run();
  await db
    .prepare("UPDATE jev_jobs SET status='classified' WHERE capture_id=?")
    .bind(captures[1].id)
    .run();
  await db
    .prepare(
      `INSERT INTO jev_pipeline_runs(id,version,phase,snapshot_created_at,snapshot_capture_id,created_at,updated_at)
     SELECT 'later-run',8,'group',snapshot_created_at,snapshot_capture_id,
       '2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z'
     FROM jev_pipeline_runs WHERE phase='complete' LIMIT 1`,
    )
    .run();
  const response = await mf.dispatchFetch(
    `${origin}/api/jev/seed-completed-continuity`,
    {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "Content-Type": "application/json",
        Authorization: `Bearer ${processingToken}`,
      },
      body: "{}",
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ seeded: 2 });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM jev_continuity_edges")
      .first(),
  ).toEqual({ count: 2 });
  const again = await mf.dispatchFetch(
    `${origin}/api/jev/seed-completed-continuity`,
    {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "Content-Type": "application/json",
        Authorization: `Bearer ${processingToken}`,
      },
      body: "{}",
    },
  );
  expect(await again.json()).toEqual({ seeded: 0 });
  expect(
    await db
      .prepare("SELECT phase FROM jev_pipeline_runs WHERE id='later-run'")
      .first(),
  ).toEqual({ phase: "group" });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_assessments").first(),
  ).toEqual(beforeAssessments);
});

it("leaves a changed OCR page and its successor pending during historical seeding", async () => {
  const processingToken = `rsc_${"h".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: (request: Request) =>
      paymentJevResponse(request, "unrelated"),
  });
  const db = await mf.getD1Database("DB");
  const captures = [
    await saveCapture(mf),
    await saveCapture(mf),
    await saveCapture(mf),
  ];
  for (const [index, capture] of captures.entries()) {
    const at = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(at, capture.id)
      .run();
    await seedHistoricalOcr(mf, capture, `SHOP RECEIPT ${index}`, at);
  }
  expect((await drainBackfill(mf, processingToken)).result.phase).toBe(
    "complete",
  );
  await db.prepare("DELETE FROM jev_continuity_edges").run();
  const changedOcr = await seedHistoricalOcr(
    mf,
    captures[0],
    "SHOP RECEIPT REVISED OCR",
    "2026-02-01T00:00:00.000Z",
  );
  await db
    .prepare(
      `INSERT INTO jev_assessments(id,task,subject_id,subject_revision,candidate_id,candidate_revision,model,input_sha256,payload,created_at)
     SELECT 'later-role',task,subject_id,subject_revision,candidate_id,candidate_revision,
       model,'later-input',json_set(payload,'$.input.ocr_sha256',?),
       '2099-01-01T00:00:00.000Z'
     FROM jev_assessments WHERE id=(SELECT assessment_id FROM jev_page_heads WHERE capture_id=?)`,
    )
    .bind(changedOcr, captures[0].id)
    .run();
  await db
    .prepare(
      "UPDATE jev_page_heads SET ocr_sha256=?,assessment_id='later-role' WHERE capture_id=?",
    )
    .bind(changedOcr, captures[0].id)
    .run();
  await db
    .prepare(
      "UPDATE jev_jobs SET ocr_sha256=?,status='classified' WHERE capture_id=?",
    )
    .bind(changedOcr, captures[0].id)
    .run();
  const response = await mf.dispatchFetch(
    `${origin}/api/jev/seed-completed-continuity`,
    {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "Content-Type": "application/json",
        Authorization: `Bearer ${processingToken}`,
      },
      body: "{}",
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ seeded: 1 });
  expect(
    (
      await db
        .prepare("SELECT capture_id FROM jev_continuity_edges")
        .all<{ capture_id: string }>()
    ).results,
  ).toEqual([{ capture_id: captures[2].id }]);
  const status = await (
    await mf.dispatchFetch(`${origin}/api/jev/status`, {
      headers: { ...ownerHeaders, Authorization: `Bearer ${processingToken}` },
    })
  ).json<any>();
  expect(status.current_captures_continuity_pending).toBe(2);
  expect(
    status.pending_continuity.map(
      (page: { capture_id: string }) => page.capture_id,
    ),
  ).toEqual([captures[0].id, captures[1].id]);

  // A later saved scan replay can establish just these two outstanding pages.
  await db
    .prepare(
      "UPDATE jev_assessments SET created_at='2026-01-15T00:00:00.000Z' WHERE task='page-role' AND id!='later-role'",
    )
    .run();
  await db
    .prepare(
      "UPDATE jev_assessments SET created_at='2026-03-01T00:00:00.000Z' WHERE id='later-role'",
    )
    .run();
  await db
    .prepare(
      "UPDATE jev_pipeline_runs SET created_at='2026-01-01T00:00:00.000Z',updated_at='2026-02-01T00:00:00.000Z' WHERE phase='complete'",
    )
    .run();
  await db
    .prepare(
      `INSERT INTO jev_pipeline_runs(id,version,phase,snapshot_created_at,snapshot_capture_id,created_at,updated_at)
     SELECT 'later-run',8,'group',snapshot_created_at,snapshot_capture_id,
       '2026-02-02T00:00:00.000Z','2026-04-01T00:00:00.000Z'
     FROM jev_pipeline_runs WHERE phase='complete' LIMIT 1`,
    )
    .run();
  const replay = await mf.dispatchFetch(
    `${origin}/api/jev/seed-completed-continuity`,
    {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "Content-Type": "application/json",
        Authorization: `Bearer ${processingToken}`,
      },
      body: JSON.stringify({
        replay_completed_at: "2026-03-15T00:00:00.000Z",
        capture_ids: [captures[0].id, captures[1].id],
      }),
    },
  );
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ seeded: 2 });
  const after = await (
    await mf.dispatchFetch(`${origin}/api/jev/status`, {
      headers: { ...ownerHeaders, Authorization: `Bearer ${processingToken}` },
    })
  ).json<any>();
  expect(after.current_captures_continuity_pending).toBe(0);
  expect(after.pipeline.phase).toBe("group");
});

it("leaves the open tail unclassified until the following raw capture has PP OCR", async () => {
  const processingToken = `rsc_${"o".repeat(43)}`;
  const relationshipPairs: string[] = [];
  let captures: any[] = [];
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      let relationship: "continuation" | "unrelated" = "unrelated";
      if (body.questions.relationship) {
        const { current, candidate } = relationshipOcr(body.state);
        const indexOf = (text: string) =>
          text.includes("SECOND SHOP RECEIPT PAGE 2")
            ? 2
            : text.includes("FIRST SHOP RECEIPT")
              ? 0
              : text.includes("SECOND SHOP RECEIPT")
                ? 1
                : 2;
        const currentIndex = indexOf(current);
        const candidateIndex = indexOf(candidate);
        relationshipPairs.push(
          `${captures[currentIndex].id}|${captures[candidateIndex].id}`,
        );
        if (currentIndex === 2 && candidateIndex === 1)
          relationship = "continuation";
      }
      return paymentJevResponse(request, relationship);
    },
  });
  captures = [
    await saveCapture(mf),
    await saveCapture(mf),
    await saveCapture(mf),
  ];
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of captures.entries())
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(`2026-01-01T00:00:0${index}.000Z`, capture.id)
      .run();
  await seedHistoricalOcr(
    mf,
    captures[0],
    "FIRST SHOP RECEIPT\nTOTAL 10.00",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    mf,
    captures[1],
    "SECOND SHOP RECEIPT PAGE 1",
    "2026-01-01T00:00:01.000Z",
  );

  const first = await drainBackfill(mf, processingToken);
  expect(
    first.results.some(
      (step) => step.result?.status === "waiting-for-ocr" && step.waiting,
    ),
  ).toBe(true);
  expect(relationshipPairs).toEqual([`${captures[1].id}|${captures[0].id}`]);
  expect(
    await db
      .prepare("SELECT document_id FROM jev_document_heads WHERE document_id=?")
      .bind(captures[0].id)
      .first(),
  ).toEqual({ document_id: captures[0].id });
  expect(
    await db
      .prepare("SELECT document_id FROM jev_document_heads WHERE document_id=?")
      .bind(captures[1].id)
      .first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT status FROM jev_jobs WHERE capture_id=?")
      .bind(captures[1].id)
      .first(),
  ).toEqual({ status: "waiting" });

  const statusResponse = await mf.dispatchFetch(`${origin}/api/jev/status`, {
    headers: { ...ownerHeaders, Authorization: `Bearer ${processingToken}` },
  });
  expect(statusResponse.status).toBe(200);
  expect(await statusResponse.json<any>()).toMatchObject({
    current_captures_with_waiting_jobs: 1,
    current_captures_missing_page_head: 1,
    missing_page_head_capture_ids: [captures[2].id],
  });

  expect(await runBackfill(mf, processingToken)).toMatchObject({
    result: null,
    phase: "complete",
    remaining: 0,
    waiting: true,
  });

  await seedHistoricalOcr(
    mf,
    captures[2],
    "SECOND SHOP RECEIPT PAGE 2\nTOTAL 20.00",
    "2026-01-01T00:00:02.000Z",
  );
  await drainBackfill(mf, processingToken);
  const catalog = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  expect(
    catalog.documents.find((document: any) => document.id === captures[1].id)
      .pages,
  ).toHaveLength(2);
  expect(
    await db
      .prepare("SELECT document_id FROM jev_document_heads WHERE document_id=?")
      .bind(captures[1].id)
      .first(),
  ).toEqual({ document_id: captures[1].id });
});

it("withholds a previously terminal document as soon as a newer raw capture exists", async () => {
  const processingToken = `rsc_${"t".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const first = await saveCapture(mf);
  const db = await mf.getD1Database("DB");
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:00.000Z", first.id)
    .run();
  await seedHistoricalOcr(
    mf,
    first,
    "FIRST SHOP RECEIPT TOTAL 10.00",
    "2026-01-01T00:00:00.000Z",
  );
  await drainBackfill(mf, processingToken);
  const catalog = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  const firstDocument = catalog.documents.find(
    (document: any) => document.id === first.id,
  );
  const env = {
    DB: db,
    BUCKET: await mf.getR2Bucket("BUCKET"),
  } as any;
  expect((await jevSummary(env, firstDocument)).ready).toBe(true);

  const classified = await db
    .prepare(
      "SELECT document_revision FROM jev_document_heads WHERE document_id=?",
    )
    .bind(first.id)
    .first<{ document_revision: number }>();
  expect(classified!.document_revision).toBe(0);
  const legacy = {
    ...firstDocument,
    pages: firstDocument.pages.map((page: any) => ({ ...page, crop: null })),
  };
  const hashLegacy = async (pages: any[]) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify(
              pages.map((page: any) => ({
                capture_id: page.captureId,
                source_sha256: page.sha256,
                crop: page.crop,
                rotation: page.rotation,
              })),
            ),
          ),
        ),
      ),
    )
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  await db
    .prepare(
      "UPDATE jev_document_heads SET page_fingerprint=? WHERE document_id=?",
    )
    .bind(await hashLegacy(legacy.pages), first.id)
    .run();
  const assessCompleteness = async () => {
    const response = await mf.dispatchFetch(`${origin}/api/jev/completeness`, {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "Content-Type": "application/json",
        Authorization: `Bearer ${processingToken}`,
      },
      body: JSON.stringify({ document_id: first.id }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json<any>()).toMatchObject({ assessed: true });
    const detail = await mf.dispatchFetch(
      `${origin}/api/documents/${first.id}`,
      { headers: ownerHeaders },
    );
    expect((await detail.json<any>()).document).toMatchObject({
      jevRole: "purchase_document",
      completenessAudit: { result: "yes" },
    });
  };
  await assessCompleteness();
  const updated = {
    ...legacy,
    revision: 1,
    pages: legacy.pages.map(({ crop: _crop, ...page }: any) => page),
  };
  await db
    .prepare(
      "INSERT INTO document_versions(document_id,revision,payload,created_at) VALUES(?,?,?,?)",
    )
    .bind(
      first.id,
      updated.revision,
      JSON.stringify(updated),
      new Date().toISOString(),
    )
    .run();
  await db
    .prepare("INSERT INTO document_heads(id,revision) VALUES(?,?)")
    .bind(first.id, updated.revision)
    .run();
  // A revision-zero Jev head can predate the first saved document version.
  expect((await jevSummary(env, updated)).ready).toBe(true);
  await assessCompleteness();
  legacy.pages[0].crop = [0, 0, 1, 1];
  await db
    .prepare(
      "INSERT INTO document_versions(document_id,revision,payload,created_at) VALUES(?,?,?,?)",
    )
    .bind(first.id, 0, JSON.stringify(legacy), new Date().toISOString())
    .run();
  await db
    .prepare(
      "UPDATE jev_document_heads SET page_fingerprint=? WHERE document_id=?",
    )
    .bind(await hashLegacy(legacy.pages), first.id)
    .run();
  // The same check also works when the classified revision exists historically.
  expect((await jevSummary(env, updated)).ready).toBe(true);
  const rotated = structuredClone(updated);
  rotated.pages[0].rotation = 90;
  expect((await jevSummary(env, rotated)).ready).toBe(false);

  const second = await saveCapture(mf);
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:01.000Z", second.id)
    .run();
  expect(await jevOpenTailDocumentId(env)).toBe(first.id);

  const waiting = await drainBackfill(mf, processingToken);
  expect(
    waiting.results.some(
      (step) => step.result?.status === "waiting-for-ocr" && step.waiting,
    ),
  ).toBe(true);
  expect(
    await db
      .prepare("SELECT document_id FROM jev_document_heads WHERE document_id=?")
      .bind(first.id)
      .first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT status FROM jev_jobs WHERE capture_id=?")
      .bind(first.id)
      .first(),
  ).toEqual({ status: "waiting" });
  expect(await runBackfill(mf, processingToken)).toMatchObject({
    result: null,
    phase: "complete",
    remaining: 0,
    waiting: true,
  });
  const statusResponse = await mf.dispatchFetch(`${origin}/api/jev/status`, {
    headers: {
      ...ownerHeaders,
      Authorization: `Bearer ${processingToken}`,
    },
  });
  expect(statusResponse.status).toBe(200);
  expect(await statusResponse.json<any>()).toMatchObject({
    current_captures_with_waiting_jobs: 1,
    current_captures_missing_page_head: 1,
    missing_page_head_capture_ids: [second.id],
  });
});

it("marks an open tail larger than the D1 parameter limit as waiting", async () => {
  const processingToken = `rsc_${"u".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const captures = [];
  for (let index = 0; index < 101; index += 1)
    captures.push(await saveCapture(mf));
  const db = await mf.getD1Database("DB");
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:00.000Z", captures[0].id)
    .run();
  await seedHistoricalOcr(mf, captures[0], "", "2026-01-01T00:00:00.000Z");

  const waiting = await drainBackfill(mf, processingToken, 20);
  expect(
    waiting.results.some(
      (step) => step.result?.status === "waiting-for-ocr" && step.waiting,
    ),
  ).toBe(true);
});

it("advances a legacy group replay when the saved scan snapshot is already verified", async () => {
  const token = `rsc_${"q".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(token),
    typesafeApiKey: "synthetic-key",
    outboundService: unrelatedPaymentJevResponse,
  });
  const capture = await saveCapture(mf);
  await seedHistoricalOcr(
    mf,
    capture,
    "SHOP RECEIPT 21.09.2026 TOTAL 12.34",
    "2026-01-01T00:00:00.000Z",
  );
  await drainBackfill(mf, token);
  const db = await mf.getD1Database("DB");
  const completed = await db
    .prepare(
      "SELECT snapshot_created_at,snapshot_capture_id FROM jev_pipeline_runs WHERE phase='complete' ORDER BY created_at DESC LIMIT 1",
    )
    .first<{ snapshot_created_at: string; snapshot_capture_id: string }>();
  expect(completed).toBeTruthy();
  const seed = await mf.dispatchFetch(
    `${origin}/api/jev/seed-completed-continuity`,
    {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Authorization: `Bearer ${token}`,
        Origin: origin,
        "X-Scanner-Request": "1",
      },
      body: "{}",
    },
  );
  expect(seed.status).toBe(200);
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO jev_pipeline_runs(id,version,phase,snapshot_created_at,snapshot_capture_id,cursor,step_token,step_started_at,created_at,updated_at) VALUES(?,8,'group',?,?,NULL,NULL,NULL,?,?)",
    )
    .bind(
      crypto.randomUUID(),
      completed!.snapshot_created_at,
      completed!.snapshot_capture_id,
      now,
      now,
    )
    .run();
  const step = await runBackfill(mf, token);
  expect(step).toMatchObject({
    phase: "dates",
    result: { status: "continuity-verified" },
  });
});
