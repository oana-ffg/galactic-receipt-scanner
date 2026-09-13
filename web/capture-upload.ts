import { api } from "./api";
import { sha256 } from "./checksum";
import type { PendingCapture } from "./pending";

import type { CaptureAcknowledgement, CaptureSource } from "./types";

function metadata(capture: PendingCapture): string {
  return JSON.stringify({
    captureMethod: capture.method,
    manualCapture: capture.manual === true,
    sourcePixels: capture.sourcePixels,
    quality: capture.quality,
    checks: "browser-opencv-mediapipe-v6-paper-boundary",
  });
}

export async function expectedAcknowledgement(
  capture: PendingCapture,
): Promise<CaptureSource> {
  const [sourceHash, metadataHash] = await Promise.all([
    capture.blob.arrayBuffer().then(sha256),
    sha256(new TextEncoder().encode(metadata(capture))),
  ]);
  return {
    id: capture.id,
    sha256: sourceHash,
    bytes: capture.blob.size,
    status: capture.manual
      ? "manual-review"
      : capture.quality.ok
        ? "accepted"
        : "rejected",
    retake_of: capture.retakeOf ?? null,
    metadataSha256: metadataHash,
  };
}

export function assertAcknowledgement(
  actual: CaptureAcknowledgement,
  expected: CaptureSource,
): void {
  if (
    !actual ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      actual.receipt_id ?? "",
    ) ||
    !Number.isSafeInteger(actual.take_number) ||
    actual.take_number < 1 ||
    typeof actual.created_at !== "string" ||
    !Number.isFinite(Date.parse(actual.created_at)) ||
    Object.entries(expected).some(
      ([key, value]) => actual[key as keyof CaptureAcknowledgement] !== value,
    )
  )
    throw new Error(
      "Saved photo verification differs from the phone copy. Keep this page open and report the issue; the phone copy is retained.",
    );
}

export async function uploadCapture(
  capture: PendingCapture,
): Promise<CaptureAcknowledgement> {
  const [response, expected] = await Promise.all([
    api<CaptureAcknowledgement | { status: "checking" }>(
      `/api/captures/${capture.id}`,
      {
        method: "POST",
        body: capture.blob,
        headers: {
          "Content-Type": capture.blob.type,
          "X-Capture-Acknowledgement": "durable-v1",
          "X-Capture-Status": capture.manual
            ? "manual-review"
            : capture.quality.ok
              ? "accepted"
              : "rejected",
          ...(capture.retakeOf ? { "X-Retake-Of": capture.retakeOf } : {}),
          "X-Capture-Metadata": metadata(capture),
          ...(capture.acknowledgement
            ? { "X-Capture-Recovery": JSON.stringify(capture.acknowledgement) }
            : {}),
        },
      },
    ),
    expectedAcknowledgement(capture),
  ]);
  let result = response;
  if (result.status === "checking") {
    // Resume a capture left by an older client before finalization.
    await api(`/api/captures/${capture.id}/finalize`, {
      method: "POST",
      body: JSON.stringify({ status: expected.status }),
    });
    result = await api<CaptureAcknowledgement>(
      `/api/captures/${capture.id}/verify`,
    );
  }
  assertAcknowledgement(result, expected);
  return result;
}
