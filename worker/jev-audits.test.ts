import { afterEach, beforeEach, expect, it } from "vitest";
import { origin, ownerHeaders, runtime } from "../scripts/test-runtime.mjs";
import { newDocument } from "../web/documents";
import {
  saveCapture,
  seedHistoricalOcr,
  processingTokenHash,
  drainBackfill,
  matchingPaymentJevResponse,
  relationshipOcr,
  syntheticJevResponse,
} from "../scripts/jev-test-fixtures.mjs";

let mf: Awaited<ReturnType<typeof runtime>>;

beforeEach(async () => {
  mf = await runtime();
}, 30_000);

afterEach(async () => mf?.dispose());

it("reports Jev's proposed join without changing Luna's saved group", async () => {
  const processingToken = `rsc_${"l".repeat(43)}`;
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
    const at = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(at, capture.id)
      .run();
    await seedHistoricalOcr(
      mf,
      capture,
      index ? "PAYMENT SLIP\nTOTAL 12.34" : "SHOP RECEIPT\nTOTAL 12.34",
      at,
    );
  }
  const luna = newDocument(receipt);
  luna.processing = {
    extraction: {
      type: "receipt",
      vendor: "Synthetic shop",
      receipt_date: "2026-01-01",
      reference: "SYNTHETIC-123",
      currency: "DKK",
      has_handwriting: false,
      has_payment_slip: false,
      payment_status: "unknown",
      card_last_four: null,
      line_items: [
        {
          description: "Synthetic item",
          quantity: 1,
          unit_price_minor: 1234,
          amount_minor: 1234,
        },
      ],
      adjustments: [],
      total_minor: 1234,
      charged_total_minor: 1234,
      payment_adjustments: [],
      vat_minor: null,
      tax_basis: "gross",
      completeness: "complete",
      category_id: null,
      certainty: "medium",
      uncertainties: [],
      broken_reasons: [],
      confirmed_arithmetic_mismatch: false,
      evidence: "Synthetic receipt source.",
    },
    not_invoice: false,
    has_handwriting: false,
    small_model_certainty: "medium",
    large_model_confidence: null,
    has_human_review: false,
    human_review_revision: null,
    needs_reparse: false,
    seen_capture_count: 1,
  };
  const saved = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      documents: [newDocument(receipt), newDocument(payment)],
    }),
  });
  expect(saved.status, await saved.text()).toBe(200);
  const current = await (
    await mf.dispatchFetch(`${origin}/api/documents/${receipt.id}`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  const revision = current.document.revision + 1;
  luna.revision = revision;
  await db.batch([
    db
      .prepare(
        "INSERT INTO document_versions(document_id,revision,payload,created_at) VALUES(?,?,?,?)",
      )
      .bind(
        receipt.id,
        revision,
        JSON.stringify(luna),
        new Date().toISOString(),
      ),
    db
      .prepare("UPDATE document_heads SET revision=? WHERE id=?")
      .bind(revision, receipt.id),
  ]);
  const replay = await drainBackfill(mf, processingToken);
  expect(
    replay.results.some(
      (step) =>
        step.result?.status === "luna-disagreement" &&
        step.result.current_document_id === receipt.id &&
        step.result.next_document_id === payment.id,
    ),
  ).toBe(true);
  const afterResponse = await mf.dispatchFetch(
    `${origin}/api/documents/${receipt.id}`,
    {
      headers: ownerHeaders,
    },
  );
  const after = await afterResponse.json<any>();
  expect(afterResponse.status, JSON.stringify(after)).toBe(200);
  expect(after.document.pages.map((page: any) => page.captureId)).toEqual([
    receipt.id,
  ]);
  expect(after.document.processing).toBeTruthy();
  expect(after.document.revision).toBe(revision);
  expect(after.document.processing.extraction.total_minor).toBe(1234);
  const paymentAfter = await (
    await mf.dispatchFetch(`${origin}/api/documents/${payment.id}`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  expect(
    paymentAfter.document.pages.map((page: any) => page.captureId),
  ).toEqual([payment.id]);
});

it("audits an existing grouped page without changing its membership", async () => {
  const processingToken = `rsc_${"a".repeat(43)}`;
  const comparisons: Array<{ current: string; candidate: string }> = [];
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      if (body.questions.relationship)
        comparisons.push({
          ...relationshipOcr(body.state),
        });
      return syntheticJevResponse(request);
    },
  });
  const captures = [
    await saveCapture(mf),
    await saveCapture(mf),
    await saveCapture(mf),
  ];
  const grouped = newDocument(captures[0]);
  grouped.pages.push(
    ...captures.slice(1).map((capture) => newDocument(capture).pages[0]),
  );
  const saved = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documents: [grouped] }),
  });
  expect(saved.status, await saved.text()).toBe(200);
  let revision = (
    await (
      await mf.dispatchFetch(`${origin}/api/documents/${grouped.id}`, {
        headers: ownerHeaders,
      })
    ).json<any>()
  ).document.revision;
  const audit = () =>
    mf.dispatchFetch(`${origin}/api/jev/group-audit`, {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "Content-Type": "application/json",
        Authorization: `Bearer ${processingToken}`,
      },
      body: JSON.stringify({
        document_id: grouped.id,
        revision,
        next_page_index: 2,
        page_id: captures[2].id,
      }),
    });
  const missing = await audit();
  expect(await missing.json<any>()).toMatchObject({
    assessed: false,
    reason: "missing_matching_ocr",
  });
  for (const [index, capture] of captures.entries())
    await seedHistoricalOcr(
      mf,
      capture,
      `SHOP RECEIPT SECTION ${index + 1}\nTOTAL 12.34`,
      `2026-01-01T00:00:0${index}.000Z`,
    );
  await drainBackfill(mf, processingToken);
  revision = (
    await (
      await mf.dispatchFetch(`${origin}/api/documents/${grouped.id}`, {
        headers: ownerHeaders,
      })
    ).json<any>()
  ).document.revision;
  const firstResponse = await audit();
  const first = await firstResponse.json<any>();
  expect(firstResponse.status, JSON.stringify(first)).toBe(200);
  expect(first).toMatchObject({
    assessed: true,
    document_id: grouped.id,
    page_id: captures[2].id,
    relationship: "unrelated",
    confidence: 1,
  });
  expect(comparisons).toEqual([
    {
      current: "Page 1:\nSHOP RECEIPT SECTION 3\nTOTAL 12.34",
      candidate:
        "Page 1:\nSHOP RECEIPT SECTION 1\nTOTAL 12.34\n\nPage 2:\nSHOP RECEIPT SECTION 2\nTOTAL 12.34",
    },
  ]);
  const secondResponse = await audit();
  expect((await secondResponse.json<any>()).assessment_id).toBe(
    first.assessment_id,
  );
  expect(comparisons).toHaveLength(1);
  const oversized = await seedHistoricalOcr(
    mf,
    captures[0],
    "X".repeat(24_001),
    "2026-01-02T00:00:00.000Z",
  );
  await (
    await mf.getD1Database("DB")
  )
    .prepare("UPDATE jev_page_heads SET ocr_sha256=? WHERE capture_id=?")
    .bind(oversized, captures[0].id)
    .run();
  const tooLong = await audit();
  expect(await tooLong.json<any>()).toMatchObject({
    assessed: false,
    reason: "ocr_too_long",
  });
  expect(comparisons).toHaveLength(1);
  const after = await mf.dispatchFetch(
    `${origin}/api/documents/${grouped.id}`,
    { headers: ownerHeaders },
  );
  expect(
    (await after.json<any>()).document.pages.map((page: any) => page.captureId),
  ).toEqual(captures.map((capture) => capture.id));
});

it("benchmarks fixed relationship prompts against current saved OCR without changing documents", async () => {
  const processingToken = `rsc_${"h".repeat(43)}`;
  const questions: Record<string, string[]> = {};
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      if (body.questions.relationship)
        questions[body.questions.relationship.instructions] = Object.keys(
          body.questions.relationship.criteria,
        );
      return syntheticJevResponse(request);
    },
  });
  const first = await saveCapture(mf);
  const second = await saveCapture(mf);
  await seedHistoricalOcr(
    mf,
    first,
    "SHOP RECEIPT TOTAL 12.34",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    mf,
    second,
    "OTHER SHOP RECEIPT TOTAL 99.00",
    "2026-01-01T00:00:01.000Z",
  );
  await drainBackfill(mf, processingToken);
  const db = await mf.getD1Database("DB");
  const before = await db
    .prepare("SELECT COUNT(*) AS count FROM jev_assessments")
    .first<{ count: number }>();
  const call = (prompt_variant: string, left_page_ids = [first.id]) =>
    mf.dispatchFetch(`${origin}/api/jev/relationship-benchmark`, {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "Content-Type": "application/json",
        Authorization: `Bearer ${processingToken}`,
      },
      body: JSON.stringify({
        prompt_variant,
        left_page_ids,
        right_page_ids: [second.id],
      }),
    });
  expect((await call("unknown")).status).toBe(400);
  expect((await call("baseline", [second.id])).status).toBe(400);
  for (const variant of ["baseline", "evidence", "ordered"]) {
    const response = await call(variant);
    const payload = await response.json<any>();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload).toMatchObject({
      prompt_variant: variant,
      relationship: "unrelated",
      model: "jev-1.13.0",
      left_page_ids: [first.id],
      right_page_ids: [second.id],
    });
  }
  expect(
    Object.values(questions)
      .map((choices) => choices.length)
      .sort(),
  ).toEqual([3, 4, 4, 4]);
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_assessments").first(),
  ).toEqual(before);
  const documents = await (
    await mf.dispatchFetch(`${origin}/api/documents`, { headers: ownerHeaders })
  ).json<any>();
  expect(
    documents.documents
      .filter((document: any) => !document.mergedInto)
      .map((document: any) =>
        document.pages.map((page: any) => page.captureId),
      ),
  ).toEqual([[first.id], [second.id]]);
});

it("pins benchmark answers to the OCR Jev saw even if OCR or the current take changes", async () => {
  const processingToken = `rsc_${"j".repeat(43)}`;
  let change: "none" | "ocr" | "retake" = "none";
  let replacementSha: string | null = null;
  const inputs: Array<{ current: string; candidate: string }> = [];
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      if (body.questions.relationship)
        inputs.push({
          ...relationshipOcr(body.state),
        });
      if (body.questions.relationship && change === "ocr") {
        await (
          await mf.getD1Database("DB")
        )
          .prepare("UPDATE jev_page_heads SET ocr_sha256=? WHERE capture_id=?")
          .bind(replacementSha, first.id)
          .run();
      } else if (body.questions.relationship && change === "retake") {
        await saveCapture(mf, first.id);
      }
      return syntheticJevResponse(request);
    },
  });
  const first = await saveCapture(mf);
  const second = await saveCapture(mf);
  await seedHistoricalOcr(
    mf,
    first,
    "FIRST RECEIPT TOTAL 12.34",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    mf,
    second,
    "SECOND RECEIPT TOTAL 99.00",
    "2026-01-01T00:00:01.000Z",
  );
  await drainBackfill(mf, processingToken);
  const priorHead = await (
    await mf.getD1Database("DB")
  )
    .prepare("SELECT ocr_sha256 FROM jev_page_heads WHERE capture_id=?")
    .bind(first.id)
    .first<{ ocr_sha256: string }>();
  replacementSha = await seedHistoricalOcr(
    mf,
    first,
    "REVISED FIRST RECEIPT TOTAL 12.34",
    "2026-01-02T00:00:00.000Z",
  );
  inputs.length = 0;
  const benchmark = () =>
    mf.dispatchFetch(`${origin}/api/jev/relationship-benchmark`, {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "Content-Type": "application/json",
        Authorization: `Bearer ${processingToken}`,
      },
      body: JSON.stringify({
        prompt_variant: "evidence",
        left_page_ids: [first.id],
        right_page_ids: [second.id],
      }),
    });
  change = "ocr";
  const changedOcr = await benchmark();
  expect(changedOcr.status).toBe(200);
  const firstResult = await changedOcr.json<any>();
  expect(firstResult.evidence_scope).toBe("request_snapshot");
  expect(firstResult.ocr_pins.left[0].ocr_sha256).toBe(priorHead!.ocr_sha256);
  change = "retake";
  const retakeResponse = await benchmark();
  expect(retakeResponse.status).toBe(200);
  expect((await retakeResponse.json<any>()).ocr_pins.left[0].ocr_sha256).toBe(
    replacementSha,
  );
  expect(inputs).toEqual([
    {
      current: "Page 1:\nSECOND RECEIPT TOTAL 99.00",
      candidate: "Page 1:\nFIRST RECEIPT TOTAL 12.34",
    },
    {
      current: "Page 1:\nSECOND RECEIPT TOTAL 99.00",
      candidate: "Page 1:\nREVISED FIRST RECEIPT TOTAL 12.34",
    },
  ]);
  const originalAfterRetake = await (
    await mf.dispatchFetch(`${origin}/api/captures/${first.id}`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  expect(originalAfterRetake.is_current).toBe(false);
});

it("rejects a group audit when its OCR head changes during Jev assessment", async () => {
  const processingToken = `rsc_${"b".repeat(43)}`;
  let replacementSha: string | null = null;
  const comparisons: string[] = [];
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      if (body.questions.relationship) {
        comparisons.push(relationshipOcr(body.state).current);
        if (replacementSha)
          await (
            await mf.getD1Database("DB")
          )
            .prepare(
              "UPDATE jev_page_heads SET ocr_sha256=? WHERE capture_id=?",
            )
            .bind(replacementSha, captures[1].id)
            .run();
      }
      return syntheticJevResponse(request);
    },
  });
  const captures = [await saveCapture(mf), await saveCapture(mf)];
  const grouped = newDocument(captures[0]);
  grouped.pages.push(newDocument(captures[1]).pages[0]);
  const saved = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documents: [grouped] }),
  });
  expect(saved.status, await saved.text()).toBe(200);
  for (const [index, capture] of captures.entries())
    await seedHistoricalOcr(
      mf,
      capture,
      `ORIGINAL RECEIPT SECTION ${index + 1}`,
      `2026-01-01T00:00:0${index}.000Z`,
    );
  await drainBackfill(mf, processingToken);
  replacementSha = await seedHistoricalOcr(
    mf,
    captures[1],
    "REVISED RECEIPT SECTION 2",
    "2026-01-02T00:00:00.000Z",
  );
  const before = await mf.dispatchFetch(
    `${origin}/api/documents/${grouped.id}`,
    { headers: ownerHeaders },
  );
  const revision = (await before.json<any>()).document.revision;
  const response = await mf.dispatchFetch(`${origin}/api/jev/group-audit`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
      Authorization: `Bearer ${processingToken}`,
    },
    body: JSON.stringify({
      document_id: grouped.id,
      revision,
      next_page_index: 1,
      page_id: captures[1].id,
    }),
  });
  expect(response.status).toBe(409);
  expect(comparisons).toEqual(["Page 1:\nORIGINAL RECEIPT SECTION 2"]);
});
