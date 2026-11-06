import { afterEach, beforeEach, expect, it } from "vitest";
import { origin, ownerHeaders, runtime } from "../scripts/test-runtime.mjs";
import { newDocument } from "../web/documents";
import { jevSummary } from "./jev";
import {
  saveCapture,
  seedHistoricalOcr,
  processingTokenHash,
  runBackfill,
  drainBackfill,
  paymentJevResponse,
  unrelatedPaymentJevResponse,
  relationshipOcr,
} from "../scripts/jev-test-fixtures.mjs";

let mf: Awaited<ReturnType<typeof runtime>>;

beforeEach(async () => {
  mf = await runtime();
}, 30_000);

afterEach(async () => mf?.dispose());

it("leaves a second detached payment slip separate when the receipt already has one", async () => {
  const processingToken = `rsc_${"m".repeat(43)}`;
  const secondSlipPairs: string[] = [];
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      let relationship: "continuation" | "payment_match" | "unrelated" =
        "unrelated";
      if (body.questions.relationship) {
        const { current, candidate } = relationshipOcr(body.state);
        if (
          current.includes("SHOP RECEIPT") &&
          candidate.includes("PAYMENT SLIP ONE")
        )
          relationship = "payment_match";
        if (
          current.includes("SHOP RECEIPT") &&
          current.includes("PAYMENT SLIP ONE") &&
          candidate.includes("PAYMENT SLIP TWO")
        ) {
          secondSlipPairs.push(
            `${body.state.current.document_id}|${body.state.candidate.document_id}`,
          );
          relationship = "payment_match";
        }
      }
      return paymentJevResponse(request, relationship);
    },
  });
  const receipt = await saveCapture(mf);
  const firstSlip = await saveCapture(mf);
  const separator = await saveCapture(mf);
  const secondSlip = await saveCapture(mf);
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of [
    receipt,
    firstSlip,
    separator,
    secondSlip,
  ].entries())
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(`2026-01-01T00:00:0${index}.000Z`, capture.id)
      .run();
  await seedHistoricalOcr(
    mf,
    receipt,
    "SHOP RECEIPT 21.09.2026 TOTAL 12.34",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    mf,
    firstSlip,
    "PAYMENT SLIP ONE 21.09.2026 TOTAL 12.34",
    "2026-01-01T00:00:01.000Z",
  );
  await seedHistoricalOcr(
    mf,
    separator,
    "BANK STATEMENT BALANCE SUMMARY",
    "2026-01-01T00:00:02.000Z",
  );
  await seedHistoricalOcr(
    mf,
    secondSlip,
    "PAYMENT SLIP TWO 21.09.2026 TOTAL 12.34",
    "2026-01-01T00:00:03.000Z",
  );

  const { result } = await drainBackfill(mf, processingToken);
  expect(result).toMatchObject({ remaining: 0, blocked: 0 });
  expect(secondSlipPairs).toEqual([]);

  const catalog = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  const merged = catalog.documents.find(
    (document: any) => document.id === receipt.id,
  );
  expect(merged.pages.map((page: any) => page.captureId)).toEqual([
    receipt.id,
    firstSlip.id,
  ]);
  expect(
    catalog.documents
      .find((document: any) => document.id === secondSlip.id)
      .pages.map((page: any) => page.captureId),
  ).toEqual([secondSlip.id]);
});

it("tries shared dates first but lets Jev match apparently conflicting dates", async () => {
  const processingToken = `rsc_${"q".repeat(43)}`;
  const reconciliationPairs: { current: string; candidate: string }[] = [];
  let reconciling = false;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      let relationship: "continuation" | "payment_match" | "unrelated" =
        "unrelated";
      if (body.questions.relationship) {
        if (reconciling)
          reconciliationPairs.push({
            current: body.state.current.document_id,
            candidate: body.state.candidate.document_id,
          });
        if (
          !reconciling &&
          relationshipOcr(body.state).current.includes("PAYMENT SLIP") &&
          relationshipOcr(body.state).candidate.includes("PAYMENT SLIP")
        )
          relationship = "continuation";
        else if (
          reconciling &&
          relationshipOcr(body.state).current.includes("REFERENCE MATCH") &&
          relationshipOcr(body.state).candidate.includes("REFERENCE MATCH")
        )
          relationship = "payment_match";
      }
      return paymentJevResponse(request, relationship);
    },
  });
  const payment = await saveCapture(mf);
  const paymentContinuation = await saveCapture(mf);
  const separator = await saveCapture(mf);
  const conflictingDateMatch = await saveCapture(mf);
  const sameDateWrongReceipt = await saveCapture(mf);
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of [
    payment,
    paymentContinuation,
    separator,
    conflictingDateMatch,
    sameDateWrongReceipt,
  ].entries())
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(`2026-01-01T00:00:0${index}.000Z`, capture.id)
      .run();
  await seedHistoricalOcr(
    mf,
    payment,
    "PAYMENT SLIP 19.09.26 REFERENCE MATCH",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    mf,
    paymentContinuation,
    "PAYMENT SLIP PART 2 19.09.26 REFERENCE MATCH",
    "2026-01-01T00:00:01.000Z",
  );
  await seedHistoricalOcr(
    mf,
    separator,
    "BANK STATEMENT BALANCE SUMMARY",
    "2026-01-01T00:00:02.000Z",
  );
  await seedHistoricalOcr(
    mf,
    conflictingDateMatch,
    "SHOP RECEIPT 20/09/2026 REFERENCE MATCH",
    "2026-01-01T00:00:03.000Z",
  );
  await seedHistoricalOcr(
    mf,
    sameDateWrongReceipt,
    "SHOP RECEIPT 2026-09-19 REFERENCE OTHER",
    "2026-01-01T00:00:04.000Z",
  );
  let backfill: any;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    backfill = await runBackfill(mf, processingToken);
    if (backfill.phase === "dates") break;
  }
  expect(backfill.phase).toBe("dates");
  await db
    .prepare(
      "INSERT INTO processing_batch_lease(id,batch_id,owner,expires,created_at,updated_at) VALUES(1,?,?,unixepoch()*1000+60000,?,?)",
    )
    .bind(
      "a".repeat(32),
      "synthetic-coordinator",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    )
    .run();
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM processing_batch_lease WHERE expires>unixepoch()*1000",
      )
      .first(),
  ).toEqual({ count: 1 });
  expect(
    await db
      .prepare(
        "SELECT phase FROM jev_pipeline_runs WHERE phase!='complete' ORDER BY created_at DESC LIMIT 1",
      )
      .first(),
  ).toEqual({ phase: "dates" });
  reconciling = true;
  expect(await runBackfill(mf, processingToken)).toMatchObject({
    phase: "dates",
    busy: true,
  });
  expect(reconciliationPairs).toEqual([]);
  await db.prepare("DELETE FROM processing_batch_lease WHERE id=1").run();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    backfill = await runBackfill(mf, processingToken);
    if (backfill.remaining === 0) break;
  }
  expect(backfill, JSON.stringify(backfill)).toMatchObject({
    remaining: 0,
    blocked: 0,
  });

  expect(reconciliationPairs).toEqual([
    { current: sameDateWrongReceipt.id, candidate: payment.id },
    { current: conflictingDateMatch.id, candidate: payment.id },
  ]);
  const catalog = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  const retained = catalog.documents.find(
    (document: any) => document.id === conflictingDateMatch.id,
  );
  const donor = catalog.documents.find(
    (document: any) => document.id === payment.id,
  );
  const separate = catalog.documents.find(
    (document: any) => document.id === sameDateWrongReceipt.id,
  );
  expect(retained.pages.map((page: any) => page.captureId)).toEqual([
    conflictingDateMatch.id,
    payment.id,
    paymentContinuation.id,
  ]);
  expect(donor).toMatchObject({
    pages: [],
    mergedInto: conflictingDateMatch.id,
  });
  expect(
    catalog.documents.find(
      (document: any) => document.id === paymentContinuation.id,
    ),
  ).toMatchObject({ pages: [], mergedInto: conflictingDateMatch.id });
  expect(separate.pages.map((page: any) => page.captureId)).toEqual([
    sameDateWrongReceipt.id,
  ]);
  expect(
    (
      await jevSummary(
        { DB: db, BUCKET: await mf.getR2Bucket("BUCKET") } as any,
        retained,
      )
    ).ready,
  ).toBe(true);
});

it("tries date, amount, then likely detached slips and lists the accepted match", async () => {
  const processingToken = `rsc_${"p".repeat(43)}`;
  const compared: string[] = [];
  let reconciling = false;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      let relationship: "continuation" | "payment_match" | "unrelated" =
        "unrelated";
      if (
        reconciling &&
        body.questions.relationship &&
        Object.keys(body.questions.relationship.criteria).length === 2
      ) {
        expect(Object.keys(body.questions.relationship.criteria)).toEqual([
          "payment_match",
          "unrelated",
        ]);
        compared.push(body.state.current.document_id);
        if (relationshipOcr(body.state).current.includes("ALPHA"))
          relationship = "payment_match";
      }
      return paymentJevResponse(request, relationship);
    },
  });
  const payment = await saveCapture(mf);
  const date = await saveCapture(mf);
  const amount = await saveCapture(mf);
  const likely = await saveCapture(mf);
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of [payment, date, amount, likely].entries())
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(`2026-01-01T00:00:0${index}.000Z`, capture.id)
      .run();
  await seedHistoricalOcr(
    mf,
    payment,
    "PAYMENT SLIP 21.09.2026 TOTAL 123,45 ALPHA",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    mf,
    date,
    "SHOP RECEIPT 21.09.2026 TOTAL 999,99 BETA",
    "2026-01-01T00:00:01.000Z",
  );
  await seedHistoricalOcr(
    mf,
    amount,
    "SHOP RECEIPT 22.09.2026 TOTAL 123,45 GAMMA",
    "2026-01-01T00:00:02.000Z",
  );
  await seedHistoricalOcr(
    mf,
    likely,
    "SHOP RECEIPT 23.09.2026 TOTAL 123,40 ALPHA",
    "2026-01-01T00:00:03.000Z",
  );
  let step: any;
  for (let index = 0; index < 60; index += 1) {
    step = await runBackfill(mf, processingToken);
    if (step.phase === "dates") break;
  }
  expect(step.phase).toBe("dates");
  reconciling = true;
  const { result, results } = await drainBackfill(mf, processingToken);
  expect(result.remaining).toBe(0);
  const heads = await db
    .prepare(
      "SELECT capture_id,role,date_candidates,payment_match_index FROM jev_page_heads",
    )
    .all();
  expect(
    compared,
    JSON.stringify({
      steps: results.map((step) => [step.phase, step.result]),
      heads,
    }),
  ).toEqual([date.id, amount.id, likely.id]);
  const response = await mf.dispatchFetch(`${origin}/api/payment-matches`, {
    headers: ownerHeaders,
  });
  expect(response.status).toBe(200);
  const matches = (await response.json<any>()).matches;
  expect(matches).toMatchObject([
    {
      original_receipt_document_id: likely.id,
      original_payment_document_id: payment.id,
      match_pass: "likely",
      status: "attached",
    },
  ]);
  await db
    .prepare("UPDATE jev_assessments SET subject_id=? WHERE id=?")
    .bind(crypto.randomUUID(), matches[0].assessment_id)
    .run();
  const relinked = await mf.dispatchFetch(`${origin}/api/payment-matches`, {
    headers: ownerHeaders,
  });
  expect((await relinked.json<any>()).matches[0].receipt_document_id).toBe(
    likely.id,
  );
  await db
    .prepare("UPDATE jev_page_heads SET ocr_sha256=? WHERE capture_id=?")
    .bind("a".repeat(64), likely.id)
    .run();
  const changed = await mf.dispatchFetch(`${origin}/api/payment-matches`, {
    headers: ownerHeaders,
  });
  expect((await changed.json<any>()).matches[0]).toMatchObject({
    status: "attached",
    evidence_current: false,
  });
});

it("does not match a current payment against a receipt capture retired after the snapshot", async () => {
  const processingToken = `rsc_${"x".repeat(43)}`;
  const reconciliationPairs: string[] = [];
  let reconciling = false;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      if (reconciling && body.questions.relationship)
        reconciliationPairs.push(
          `${body.state.current.document_id}|${body.state.candidate.document_id}`,
        );
      return paymentJevResponse(
        request,
        reconciling ? "payment_match" : "unrelated",
      );
    },
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
  }
  await seedHistoricalOcr(
    mf,
    receipt,
    "SHOP RECEIPT 19.09.2026 REFERENCE MATCH",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    mf,
    payment,
    "PAYMENT SLIP 19.09.2026 REFERENCE MATCH",
    "2026-01-01T00:00:01.000Z",
  );

  let step: any;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    step = await runBackfill(mf, processingToken);
    if (step.phase === "dates") break;
  }
  expect(step.phase).toBe("dates");
  const persisted = newDocument(receipt);
  const persistResponse = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
    },
    body: JSON.stringify({ documents: [persisted] }),
  });
  expect(persistResponse.status).toBe(200);
  await saveCapture(mf, receipt.id);
  reconciling = true;
  const { result } = await drainBackfill(mf, processingToken);
  expect(result).toMatchObject({ remaining: 0, blocked: 0 });
  expect(reconciliationPairs).toEqual([]);

  const catalog = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  expect(
    catalog.documents.find((document: any) => document.id === payment.id).pages,
  ).toEqual([expect.objectContaining({ captureId: payment.id })]);
});

it("plans detached payments in durable bounded batches", async () => {
  const token = `rsc_${"b".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(token),
    typesafeApiKey: "synthetic-key",
    outboundService: unrelatedPaymentJevResponse,
  });
  const db = await mf.getD1Database("DB");
  const captures = [];
  for (let index = 0; index < 7; index++) {
    const capture = await saveCapture(mf);
    captures.push(capture);
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(
      mf,
      capture,
      `${index === 0 ? "SHOP RECEIPT" : "PAYMENT SLIP"} 21.09.2026 TOTAL 12.34`,
      createdAt,
    );
  }
  let step: any;
  for (let attempt = 0; attempt < 70; attempt++) {
    step = await runBackfill(mf, token);
    if (step.phase === "dates") break;
  }
  expect(step.phase).toBe("dates");
  for (let attempt = 0; attempt < 5; attempt++) {
    step = await runBackfill(mf, token);
    if (step.result?.status === "payment-index-built") break;
  }
  expect(step.result).toMatchObject({
    status: "payment-index-built",
    purchases: 1,
    payments: 6,
  });
  const first = await runBackfill(mf, token);
  expect(first.result).toMatchObject({
    status: "payment-candidates-indexed",
    payments: 5,
    complete: false,
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM jev_payment_candidates")
      .first(),
  ).toEqual({ count: 5 });
  const second = await runBackfill(mf, token);
  expect(second.result).toMatchObject({
    status: "payment-candidates-indexed",
    payments: 1,
    complete: true,
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM jev_payment_candidates")
      .first(),
  ).toEqual({ count: 6 });
});

it("checkpoints ranked reconciliation without repeating candidate pairs", async () => {
  const processingToken = `rsc_${"v".repeat(43)}`;
  const reconciliationPairs: string[] = [];
  let reconciling = false;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      if (reconciling && body.questions.relationship)
        reconciliationPairs.push(
          `${body.state.current.document_id}|${body.state.candidate.document_id}`,
        );
      return unrelatedPaymentJevResponse(request);
    },
  });
  const captures = [];
  const db = await mf.getD1Database("DB");
  for (let index = 0; index < 4; index += 1) {
    const capture = await saveCapture(mf);
    captures.push(capture);
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(
      mf,
      capture,
      `${index < 2 ? "PAYMENT SLIP" : "SHOP RECEIPT"} ${index} 21.09.2026`,
      createdAt,
    );
  }
  let backfill: any;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (backfill?.phase === "dates") reconciling = true;
    backfill = await runBackfill(mf, processingToken);
    if (backfill.remaining === 0) break;
  }
  expect(backfill).toMatchObject({ remaining: 0, blocked: 0 });
  expect(reconciliationPairs).toHaveLength(4);
  expect(new Set(reconciliationPairs).size).toBe(4);
  const queue = await db
    .prepare("SELECT rank,pass FROM jev_payment_candidates ORDER BY rank")
    .all<{ rank: number; pass: string }>();
  expect(queue.results).toEqual([
    { rank: 1, pass: "date" },
    { rank: 2, pass: "date" },
    { rank: 3, pass: "date" },
    { rank: 4, pass: "date" },
  ]);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM jev_payment_candidate_runs")
      .first(),
  ).toEqual({ count: 1 });
  const queuePlan = await db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT rank FROM jev_payment_candidates WHERE pipeline_run_id=? AND rank>? ORDER BY rank LIMIT 1",
    )
    .bind("run", 0)
    .all<{ detail: string }>();
  expect(queuePlan.results.map((step) => step.detail).join(" ")).toContain(
    "jev_payment_candidate_rank",
  );
  const pendingPlan = await db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT capture_id FROM jev_page_heads WHERE date_candidates IS NULL OR payment_match_index IS NULL ORDER BY updated_at,capture_id LIMIT 25",
    )
    .all<{ detail: string }>();
  expect(pendingPlan.results.map((step) => step.detail).join(" ")).toContain(
    "jev_payment_index_pending",
  );
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jev_assessments WHERE task='payment-match-detached-v2-date' AND subject_id IN (?,?) AND candidate_id IN (?,?)",
      )
      .bind(captures[2].id, captures[3].id, captures[0].id, captures[1].id)
      .first(),
  ).toEqual({ count: 4 });
});
