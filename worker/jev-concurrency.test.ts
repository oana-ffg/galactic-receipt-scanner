import { afterEach, beforeEach, expect, it } from "vitest";
import { origin, ownerHeaders, runtime } from "../scripts/test-runtime.mjs";
import { newDocument } from "../web/documents";
import {
  saveCapture,
  seedHistoricalOcr,
  processingTokenHash,
  runBackfill,
  drainBackfill,
  matchingPaymentJevResponse,
  unrelatedPaymentJevResponse,
  syntheticJevResponse,
} from "../scripts/jev-test-fixtures.mjs";

let mf: Awaited<ReturnType<typeof runtime>>;

beforeEach(async () => {
  mf = await runtime();
}, 30_000);

afterEach(async () => mf?.dispose());

it("retries a saved grouping decision after the merge write fails", async () => {
  const processingToken = `rsc_${"g".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: matchingPaymentJevResponse,
  });
  const receipt = await saveCapture(mf);
  const payment = await saveCapture(mf);
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of [receipt, payment].entries()) {
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(
      mf,
      capture,
      index === 0 ? "SHOP RECEIPT TOTAL 12.34" : "PAYMENT SLIP TOTAL 12.34",
      createdAt,
    );
  }
  let step: any;
  for (let index = 0; index < 10; index += 1) {
    step = await runBackfill(mf, processingToken);
    if (step.phase === "group") break;
  }
  expect(step.phase).toBe("group");
  await runBackfill(mf, processingToken);
  await db
    .prepare(
      "CREATE TRIGGER synthetic_fail_merge BEFORE INSERT ON document_versions BEGIN SELECT RAISE(ABORT, 'synthetic merge failure'); END",
    )
    .run();
  const failed = await mf.dispatchFetch(`${origin}/api/jev/backfill`, {
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
  expect(failed.status).toBe(503);
  expect(
    await db
      .prepare(
        "SELECT cursor,step_token FROM jev_pipeline_runs WHERE phase='group'",
      )
      .first(),
  ).toMatchObject({ step_token: null });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jev_assessments WHERE task='document-relationship-scan-v1'",
      )
      .first(),
  ).toEqual({ count: 1 });
  await db.prepare("DROP TRIGGER synthetic_fail_merge").run();
  await drainBackfill(mf, processingToken);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jev_assessments WHERE task='document-relationship-scan-v1'",
      )
      .first(),
  ).toEqual({ count: 1 });
});

it("serializes forward grouping with the pipeline step lease", async () => {
  const processingToken = `rsc_${"h".repeat(43)}`;
  let releaseRelationship!: () => void;
  const relationshipReleased = new Promise<void>((resolve) => {
    releaseRelationship = resolve;
  });
  let markRelationshipStarted!: () => void;
  const relationshipStarted = new Promise<void>((resolve) => {
    markRelationshipStarted = resolve;
  });
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      if (body.questions.relationship) {
        markRelationshipStarted();
        await relationshipReleased;
      }
      return unrelatedPaymentJevResponse(request);
    },
  });
  const db = await mf.getD1Database("DB");
  for (let index = 0; index < 2; index += 1) {
    const capture = await saveCapture(mf);
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(
      mf,
      capture,
      `${index ? "SHOP RECEIPT" : "PAYMENT SLIP"} TOTAL 12.34`,
      createdAt,
    );
  }
  let step: any;
  for (let index = 0; index < 10; index += 1) {
    step = await runBackfill(mf, processingToken);
    if (step.phase === "group") break;
  }
  await runBackfill(mf, processingToken);
  const first = runBackfill(mf, processingToken);
  await relationshipStarted;
  const concurrent = await runBackfill(mf, processingToken);
  expect(concurrent).toMatchObject({
    phase: "group",
    remaining: 1,
    busy: true,
  });
  releaseRelationship();
  expect(await first).toMatchObject({
    phase: "group",
    remaining: 1,
    busy: false,
  });
});

it("retries a merge when a document revision changes during Jev comparison", async () => {
  const processingToken = `rsc_${"w".repeat(43)}`;
  let releaseRelationship!: () => void;
  const relationshipReleased = new Promise<void>((resolve) => {
    releaseRelationship = resolve;
  });
  let markRelationshipStarted!: () => void;
  const relationshipStarted = new Promise<void>((resolve) => {
    markRelationshipStarted = resolve;
  });
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      if (body.questions.relationship) {
        markRelationshipStarted();
        await relationshipReleased;
      }
      return matchingPaymentJevResponse(request);
    },
  });
  const captures = [await saveCapture(mf), await saveCapture(mf)];
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
      `${index ? "SHOP RECEIPT" : "PAYMENT SLIP"} TOTAL 12.34`,
      createdAt,
    );
  }
  const persisted = newDocument(captures[0]);
  const initialSave = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documents: [persisted] }),
  });
  expect(initialSave.status).toBe(200);
  let step: any;
  for (let index = 0; index < 10; index += 1) {
    step = await runBackfill(mf, processingToken);
    if (step.phase === "group") break;
  }
  await runBackfill(mf, processingToken);
  const grouping = runBackfill(mf, processingToken);
  await relationshipStarted;
  const current = await (
    await mf.dispatchFetch(`${origin}/api/documents/${captures[0].id}`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  current.document.vendor = "Owner correction during comparison";
  const changed = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documents: [current.document] }),
  });
  expect(changed.status).toBe(200);
  releaseRelationship();
  expect(await grouping).toMatchObject({
    phase: "group",
    remaining: 1,
    busy: true,
  });
  const beforeRetry = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  expect(
    beforeRetry.documents.find(
      (document: any) => document.id === captures[0].id,
    ).pages,
  ).toHaveLength(1);

  await drainBackfill(mf, processingToken);
  const afterRetry = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  expect(
    afterRetry.documents.find((document: any) => document.id === captures[1].id)
      .pages,
  ).toHaveLength(2);
});

it("creates only one active pipeline when initial backfill requests overlap", async () => {
  const processingToken = `rsc_${"i".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  await saveCapture(mf);
  const results = await Promise.all([
    runBackfill(mf, processingToken),
    runBackfill(mf, processingToken),
  ]);
  expect(
    results.every((result) => result.remaining === 0 || result.remaining === 1),
  ).toBe(true);
  const db = await mf.getD1Database("DB");
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_pipeline_runs").first(),
  ).toEqual({ count: 1 });
});

it("checkpoints final document classification one document per request", async () => {
  const processingToken = `rsc_${"j".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const captures = [await saveCapture(mf), await saveCapture(mf)];
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of captures.entries()) {
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(mf, capture, "", createdAt);
  }
  let step: any;
  for (let index = 0; index < 30; index += 1) {
    step = await runBackfill(mf, processingToken);
    if (step.phase === "documents") break;
  }
  expect(step.phase).toBe("documents");
  await db
    .prepare("UPDATE jev_jobs SET status='classified' WHERE status='complete'")
    .run();
  await runBackfill(mf, processingToken);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM jev_jobs WHERE status='complete'")
      .first(),
  ).toEqual({ count: 1 });
  await saveCapture(mf, captures[0].id);
  await runBackfill(mf, processingToken);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM jev_jobs WHERE status='complete'")
      .first(),
  ).toEqual({ count: 2 });
});

it("atomically owns a Jev job while upload and backfill overlap", async () => {
  await mf.dispose();
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let calls = 0;
  const processingToken = `rsc_${"q".repeat(43)}`;
  const tokenHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(processingToken),
      ),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  mf = await runtime({
    typesafeApiKey: "synthetic-key",
    processingTokenSha256: tokenHash,
    outboundService: async (request: Request) => {
      calls += 1;
      if (calls === 1) {
        markStarted();
        await firstReleased;
      }
      return syntheticJevResponse(request);
    },
  });
  const capture = await saveCapture(mf);
  const upload = mf.dispatchFetch(
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
        text: "Synthetic shop\nSynthetic item 12,34\nTOTAL 12,34",
      }),
    },
  );
  await firstStarted;
  const concurrent = await mf.dispatchFetch(`${origin}/api/jev/backfill`, {
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
  const concurrentResult = await concurrent.json<any>();
  expect(concurrent.status, JSON.stringify(concurrentResult)).toBe(200);
  expect(concurrentResult).toMatchObject({ result: null, remaining: 1 });
  releaseFirst();
  const saved = await upload;
  expect(saved.status, await saved.text()).toBe(200);
  expect(calls).toBe(1);
  const db = await mf.getD1Database("DB");
  expect(
    await db.prepare("SELECT status,run_token FROM jev_jobs").first(),
  ).toEqual({ status: "classified", run_token: null });
  await drainBackfill(mf, processingToken);
  expect(calls).toBe(2);
  expect(
    await db.prepare("SELECT status,run_token FROM jev_jobs").first(),
  ).toEqual({ status: "complete", run_token: null });
});
