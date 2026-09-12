import type { Quality } from "./types";

export interface PreviewChecks {
  capture: boolean;
  removal: boolean;
}

const HAND_CHECK_LEAD_MS = 750;
const HAND_RETRY_MS = 750;

function changed(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return true;
  let difference = 0;
  for (let i = 0; i < a.length; i += 4)
    for (let channel = 0; channel < 3; channel++)
      difference += Math.abs(a[i + channel] - b[i + channel]);
  return difference / ((a.length / 4) * 3) > 3.5;
}

/** Gate ML on useful transitions; never reuse a clear result for another frame. */
export class HandChecks {
  private candidateSince: number | undefined;
  private blocked: { at: number; scene: Uint8ClampedArray } | undefined;

  apply(
    quality: Quality,
    preview: PreviewChecks | undefined,
    now: number,
    scene: () => Uint8ClampedArray,
    detect: () => number[][][],
  ): Quality {
    const candidate = quality.ok;
    const empty = quality.empty === true;
    quality.ok = false;
    quality.empty = false;
    quality.handsChecked = false;
    quality.candidateReady = candidate && preview?.capture === true;

    if (preview) {
      this.candidateSince = quality.candidateReady
        ? (this.candidateSince ?? now)
        : undefined;
      const captureDue =
        this.candidateSince !== undefined &&
        now - this.candidateSince >= HAND_CHECK_LEAD_MS;
      if (!captureDue && !(preview.removal && empty)) return quality;

      if (
        this.blocked &&
        now - this.blocked.at < HAND_RETRY_MS &&
        !changed(this.blocked.scene, scene())
      ) {
        quality.candidateReady = false;
        quality.reason = "Waiting for hands to move clear.";
        return quality;
      }
    }

    // Independent photos always run ML, including manual/rejected captures.
    quality.hands = detect();
    quality.handsChecked = true;
    if (preview)
      this.blocked = quality.hands.length
        ? { at: now, scene: scene() }
        : undefined;
    if (quality.hands.length) {
      quality.candidateReady = false;
      quality.reason = "Hand or fingers detected. Move them out of view.";
    } else {
      quality.ok = candidate;
      quality.empty = empty;
    }
    return quality;
  }
}
