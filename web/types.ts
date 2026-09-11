export interface Quality {
  ok: boolean;
  quad: number[][] | null;
  hands: number[][][];
  reason: string;
  empty?: boolean;
  motion?: number;
  focus?: number;
  contrast?: number;
  receiptPixels?: number[];
}

export interface ScanState {
  type: "state";
  phase: "red" | "amber" | "green";
  message: string;
  paused: boolean;
  activeId: string | null;
  lastSaved: string | null;
  armed: boolean;
  cameraConnected: boolean;
  streamFresh: boolean;
  detectorReady: boolean;
  needsAttention?: boolean;
  previewWarning?: string;
  stage?: "photo" | "checking" | "uploading";
  timings?: { photoMs?: number; checksMs?: number; saveMs?: number };
  count: number;
  quality: Quality;
}

export interface Capture {
  id: string;
  created_at: string;
  sha256: string;
  status: "checking" | "accepted" | "rejected";
  ocr_status: string;
  ocr_error: string | null;
  outputs: { image: boolean; pdf: boolean };
  acceptedCount?: number;
  metadata: { quality?: Quality; sourcePixels?: number[] };
}
