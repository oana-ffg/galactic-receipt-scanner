// Shared numeric-only timing protocol. No URLs, image content or credentials.
export const serverStages = [
  "serverAuthMs",
  "serverRoutingMs",
  "serverBodyMs",
  "serverHashMs",
  "serverValidationMs",
  "serverParentMs",
  "serverProvenanceMs",
  "serverObjectMs",
  "serverInsertMs",
  "serverRetryReadMs",
  "serverReadbackMs",
  "serverAckMs",
  "serverTotalMs",
] as const;
export type TimingStage =
  | (typeof serverStages)[number]
  | "pendingReadMs"
  | "photoMs"
  | "initialPersistMs"
  | "decodeMs"
  | "checksMs"
  | "qualityPersistMs"
  | "localHashMs"
  | "requestHeadersMs"
  | "responseParseMs"
  | "requestMs"
  | "ackValidateMs"
  | "ackPersistMs"
  | "inventoryMs"
  | "saveMs"
  | "captureTotalMs"
  | "localDeleteMs"
  | "verificationMs";
export interface SaveTiming {
  at: number;
  kind: "capture" | "retry" | "verification" | "resend";
  requests?: Array<
    Pick<SaveTiming, "at" | "status" | "failedStage" | "values">
  >;
  outcome: "pending" | "complete" | "failed";
  bytes?: number;
  status?: number;
  failedStage?: TimingStage;
  values: Partial<Record<TimingStage, number>>;
}
export class Timing {
  readonly started = performance.now();
  readonly data: SaveTiming;
  constructor(kind: SaveTiming["kind"] = "capture") {
    this.data = { at: Date.now(), kind, outcome: "pending", values: {} };
  }
  async measure<T>(
    stage: TimingStage,
    operation: () => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    try {
      return await operation();
    } catch (error) {
      this.data.failedStage ??= stage;
      throw error;
    } finally {
      this.set(stage, performance.now() - start);
    }
  }
  set(stage: TimingStage, ms: number) {
    if (Number.isFinite(ms) && ms >= 0)
      this.data.values[stage] = Math.round(ms * 100) / 100;
  }
  finish(ok: boolean) {
    this.data.outcome = ok ? "complete" : "failed";
  }
  readServer(header: string | null) {
    for (const part of (header ?? "").slice(0, 4000).split(",")) {
      const match = part.trim().match(/^(\w+);dur=(\d+(?:\.\d+)?)$/);
      if (
        match &&
        serverStages.includes(match[1] as (typeof serverStages)[number])
      )
        this.set(match[1] as TimingStage, Number(match[2]));
    }
  }
  header() {
    return serverStages
      .filter((key) => this.data.values[key] !== undefined)
      .map((key) => `${key};dur=${this.data.values[key]}`)
      .join(",");
  }
}
