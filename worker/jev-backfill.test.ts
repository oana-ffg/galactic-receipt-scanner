import { afterEach, beforeEach, expect, it } from "vitest";
import { origin, ownerHeaders, runtime } from "../scripts/test-runtime.mjs";
import { documentEvidence, jevSummary, queueJevJob } from "./jev";
import {
  saveCapture,
  seedHistoricalOcr,
  processingTokenHash,
  runBackfill,
  drainBackfill,
  syntheticJevResponse,
} from "../scripts/jev-test-fixtures.mjs";

let mf: Awaited<ReturnType<typeof runtime>>;

beforeEach(async () => {
  mf = await runtime();
}, 30_000);

afterEach(async () => mf?.dispose());

it("discovers and processes only one historical OCR artifact per backfill request", async () => {
  const processingToken = `rsc_${"b".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const captures = [await saveCapture(mf), await saveCapture(mf)];
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of captures.entries()) {
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(`2026-01-01T00:00:0${index}.000Z`, capture.id)
      .run();
    await seedHistoricalOcr(mf, capture, "", `2026-01-01T00:00:0${index}.000Z`);
  }
  expect(await runBackfill(mf, processingToken)).toMatchObject({
    result: { status: "classified" },
    remaining: 1,
    blocked: 0,
  });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_jobs").first(),
  ).toEqual({ count: 1 });
  expect(await db.prepare("SELECT capture_id FROM jev_jobs").first()).toEqual({
    capture_id: captures[0].id,
  });
  const { result } = await drainBackfill(mf, processingToken);
  expect(result).toMatchObject({
    remaining: 0,
    blocked: 0,
  });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_jobs").first(),
  ).toEqual({ count: 2 });
});

it("re-evaluates legacy ineligible jobs and classifies safe auto-cropped PP text", async () => {
  const processingToken = `rsc_${"r".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const capture = await saveCapture(mf);
  const digest = await seedHistoricalOcr(
    mf,
    capture,
    "Synthetic shop\nSynthetic item 12,34\nTOTAL 12,34",
    "2026-01-01T00:00:00.000Z",
    { left: 100, top: 100, width: 800, height: 1300 },
  );
  const db = await mf.getD1Database("DB");
  await queueJevJob({ DB: db } as any, capture.id, digest);
  await db
    .prepare(
      "UPDATE jev_jobs SET status='ineligible',eligibility_version=1,ineligible_reason=NULL",
    )
    .run();
  expect(
    await db.prepare("SELECT status,eligibility_version FROM jev_jobs").first(),
  ).toEqual({ status: "ineligible", eligibility_version: 1 });

  expect((await drainBackfill(mf, processingToken)).result).toMatchObject({
    remaining: 0,
    blocked: 0,
    phase: "complete",
  });
  expect(
    await db
      .prepare(
        "SELECT status,eligibility_version,ineligible_reason FROM jev_jobs",
      )
      .first(),
  ).toEqual({
    status: "complete",
    eligibility_version: 3,
    ineligible_reason: null,
  });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_page_heads").first(),
  ).toEqual({ count: 1 });
});

it("reports unprocessed legacy captures in the backfill remaining count", async () => {
  const processingToken = `rsc_${"u".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const captures = [await saveCapture(mf), await saveCapture(mf)];
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of captures.entries()) {
    const digest = await seedHistoricalOcr(
      mf,
      capture,
      `Synthetic shop ${index}\nTOTAL 12,34`,
      `2026-01-01T00:00:0${index}.000Z`,
      { left: 100, top: 100, width: 800, height: 1300 },
    );
    await queueJevJob({ DB: db } as any, capture.id, digest);
  }
  await db
    .prepare(
      "UPDATE jev_jobs SET status='ineligible',eligibility_version=1,ineligible_reason=NULL",
    )
    .run();

  expect(await runBackfill(mf, processingToken)).toMatchObject({
    result: { status: "classified" },
    remaining: 1,
    blocked: 0,
  });
  const { result: final } = await drainBackfill(mf, processingToken);
  expect(final).toMatchObject({
    remaining: 0,
    blocked: 0,
    phase: "complete",
  });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_page_heads").first(),
  ).toEqual({ count: 2 });
});

it("keeps completed Jev evidence pinned when a newer legacy artifact is rejected", async () => {
  const processingToken = `rsc_${"s".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const capture = await saveCapture(mf);
  const completed = await seedHistoricalOcr(
    mf,
    capture,
    "Completed synthetic shop\nTOTAL 12,34",
    "2026-01-01T00:00:00.000Z",
  );
  const db = await mf.getD1Database("DB");
  await queueJevJob({ DB: db } as any, capture.id, completed);
  await drainBackfill(mf, processingToken);

  const rejected = await seedHistoricalOcr(
    mf,
    capture,
    "Newer rejected synthetic OCR",
    "2026-01-01T00:00:01.000Z",
    { left: 100, top: 100, width: 800, height: 1300 },
  );
  await queueJevJob({ DB: db } as any, capture.id, rejected);
  await db
    .prepare(
      "UPDATE jev_jobs SET status='ineligible',eligibility_version=1,ineligible_reason=NULL WHERE ocr_sha256=?",
    )
    .bind(rejected)
    .run();

  expect((await runBackfill(mf, processingToken)).remaining).toBe(0);
  expect(
    (
      await db
        .prepare(
          "SELECT ocr_sha256,status,eligibility_version FROM jev_jobs ORDER BY ocr_sha256",
        )
        .all()
    ).results,
  ).toEqual(
    [
      { ocr_sha256: rejected, status: "ineligible", eligibility_version: 1 },
      { ocr_sha256: completed, status: "complete", eligibility_version: 3 },
    ].sort((a, b) => a.ocr_sha256.localeCompare(b.ocr_sha256)),
  );
  const stored = await mf.dispatchFetch(
    `${origin}/api/documents/${capture.id}`,
    { headers: ownerHeaders },
  );
  const document = (await stored.json<any>()).document;
  expect(
    await jevSummary(
      { DB: db, BUCKET: await mf.getR2Bucket("BUCKET") } as any,
      document,
    ),
  ).toMatchObject({ ready: true });
  expect(
    await db.prepare("SELECT ocr_sha256 FROM jev_page_heads").first(),
  ).toEqual({ ocr_sha256: completed });
  expect(
    await documentEvidence(
      { DB: db, BUCKET: await mf.getR2Bucket("BUCKET") } as any,
      document,
    ),
  ).toMatchObject({
    ocr: { pins: [{ capture_id: capture.id, ocr_sha256: completed }] },
  });
});

it("retries only the newest legacy artifact and leaves its older sibling untouched", async () => {
  const processingToken = `rsc_${"t".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const capture = await saveCapture(mf);
  const older = await seedHistoricalOcr(
    mf,
    capture,
    "Older synthetic shop\nTOTAL 10,00",
    "2026-01-01T00:00:00.000Z",
    { left: 100, top: 100, width: 800, height: 1300 },
  );
  const newer = await seedHistoricalOcr(
    mf,
    capture,
    "Newer synthetic shop\nTOTAL 12,34",
    "2026-01-01T00:00:01.000Z",
    { left: 100, top: 100, width: 800, height: 1300 },
  );
  const db = await mf.getD1Database("DB");
  await queueJevJob({ DB: db } as any, capture.id, older);
  await queueJevJob({ DB: db } as any, capture.id, newer);
  await db
    .prepare(
      "UPDATE jev_jobs SET status='ineligible',eligibility_version=1,ineligible_reason=NULL",
    )
    .run();

  await drainBackfill(mf, processingToken);
  expect(
    (
      await db
        .prepare(
          "SELECT ocr_sha256,status,eligibility_version FROM jev_jobs ORDER BY ocr_sha256",
        )
        .all()
    ).results,
  ).toEqual(
    [
      { ocr_sha256: older, status: "ineligible", eligibility_version: 1 },
      { ocr_sha256: newer, status: "complete", eligibility_version: 3 },
    ].sort((a, b) => a.ocr_sha256.localeCompare(b.ocr_sha256)),
  );
  expect(
    await db.prepare("SELECT ocr_sha256 FROM jev_page_heads").first(),
  ).toEqual({ ocr_sha256: newer });
  expect((await runBackfill(mf, processingToken)).remaining).toBe(0);
});

it("recovers an interrupted job that the previous request boundary blocked", async () => {
  const processingToken = `rsc_${"f".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const capture = await saveCapture(mf);
  const ocrSha256 = await seedHistoricalOcr(
    mf,
    capture,
    "",
    "2026-01-01T00:00:00.000Z",
  );
  const db = await mf.getD1Database("DB");
  const jobId = await queueJevJob(
    {
      DB: db,
      BUCKET: await mf.getR2Bucket("BUCKET"),
    } as any,
    capture.id,
    ocrSha256,
  );
  await db
    .prepare(
      "UPDATE jev_jobs SET status='blocked',attempts=3,last_error='Interrupted Jev run; safe to retry.',updated_at=? WHERE id=?",
    )
    .bind("2026-01-01T00:00:01.000Z", jobId)
    .run();
  expect((await drainBackfill(mf, processingToken)).result).toMatchObject({
    remaining: 0,
    blocked: 0,
    phase: "complete",
  });
});
