export interface SaveRecoveryState {
  pending: number;
  bytes: number;
  blocked: boolean;
  warning?: string;
}

export interface CaptureSource {
  id: string;
  sha256: string;
  bytes: number;
  status: "accepted" | "rejected" | "manual-review";
  retake_of: string | null;
  metadataSha256: string;
}

export interface CaptureAcknowledgement extends CaptureSource {
  receipt_id: string;
  take_number: number;
  created_at: string;
}

export interface RemovalDiagnostics {
  geometry: "no-candidates" | "incomplete" | "outline";
  bounds?: string;
  dark?: number;
  bright?: number;
  cutLow?: number;
  cutHigh?: number;
  regions?: number;
  candidates?: number;
  complete?: number;
  inclusiveCoverage?: number;
  coverage?: number;
  previousBrightness?: number;
  areaBrightness?: number;
  naturalEmpty?: boolean;
  naturalStrong?: boolean;
  calibration?: "disabled" | "match" | "mismatch";
  referenceDifference?: number;
  referenceTileDifference?: number;
  confirmedFrames?: boolean;
  visionMs?: number;
}

export interface Quality {
  ok: boolean;
  quad: number[][] | null;
  hands: number[][][];
  handsChecked?: boolean;
  /** Preview geometry/print checks passed; ML may still be pending. */
  candidateReady?: boolean;
  reason: string;
  empty?: boolean;
  /** Last paper area is clear even at the most inclusive segmentation cut. */
  emptyStrong?: boolean;
  motion?: number;
  focus?: number;
  contrast?: number;
  inkFraction?: number;
  sharpness?: number;
  noiseFloor?: number;
  glare?: boolean;
  receiptPixels?: number[];
  removalDiagnostics?: RemovalDiagnostics;
}

export interface ScanState {
  type: "state";
  cameraId?: string;
  stateRevision?: number;
  phase: "red" | "amber" | "green";
  message: string;
  paused: boolean;
  activeId: string | null;
  lastSaved: string | null;
  lastCapture: string | null;
  retakeOf: string | null;
  supportsTargetedRetake?: boolean;
  selectedRetake?: boolean;
  supportsForce?: boolean;
  supportsBackground?: boolean;
  supportsBackgroundReset?: boolean;
  backgroundReady?: boolean;
  backgroundMessage?: string;
  manualReview?: boolean;
  armed: boolean;
  cameraConnected: boolean;
  streamFresh: boolean;
  detectorReady: boolean;
  needsAttention?: boolean;
  recovery?: "retake" | "upload";
  previewWarning?: string;
  saveRecovery?: SaveRecoveryState;
  stage?: "photo" | "checking" | "uploading";
  timings?: { photoMs?: number; checksMs?: number; saveMs?: number };
  count: number;
  countKnown?: boolean;
  quality: Quality;
  removalDiagnostics?: {
    gate:
      | "not-empty"
      | "hands-unchecked"
      | "hands-present"
      | "confirming"
      | "removed";
    elapsedMs: number;
    gapMs?: number;
    clearMs: number;
    strongMs: number;
    samples: number;
    resets: number;
  };
}

export interface Capture {
  id: string;
  receipt_id: string;
  retake_of: string | null;
  take_number: number;
  is_current: boolean;
  current_capture_id: string | null;
  created_at: string;
  sha256: string;
  status: "checking" | "accepted" | "rejected" | "manual-review";
  ocr_status: string;
  ocr_error: string | null;
  outputs: { image: boolean; pdf: boolean };
  acceptedCount?: number;
  metadata: { quality?: Quality; sourcePixels?: number[] };
}
