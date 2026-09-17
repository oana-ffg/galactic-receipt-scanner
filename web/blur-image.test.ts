import type CV from "@techstark/opencv-js";
import { afterEach, expect, it, vi } from "vitest";
import { AREA_TILE } from "./area-resize";
import { measureCapturedBlur } from "./blur-image";

afterEach(() => vi.unstubAllGlobals());

it("bounds canvas readback and OpenCV allocations while scoring a native 55MP crop", () => {
  let maxCanvas = 0,
    maxMat = 0,
    reads = 0,
    deleted = 0;
  class Canvas {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return {
        drawImage: (
          _bitmap: unknown,
          _x: number,
          _y: number,
          w: number,
          h: number,
          _dx: number,
          _dy: number,
          dw: number,
          dh: number,
        ) => {
          expect([dw, dh]).toEqual([w, h]);
          maxCanvas = Math.max(maxCanvas, this.width * this.height);
        },
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          reads++;
          return { width: w, height: h };
        },
      };
    }
  }
  class Mat {
    data = new Uint8Array();
    delete() {
      deleted++;
    }
  }
  vi.stubGlobal("OffscreenCanvas", Canvas);
  const cv = {
    Mat,
    COLOR_RGBA2GRAY: 1,
    matFromImageData: (data: { width: number; height: number }) => {
      const size = data.width * data.height;
      maxMat = Math.max(maxMat, size);
      return {
        size,
        delete() {
          deleted++;
        },
      };
    },
    cvtColor: (source: { size: number }, target: Mat) => {
      target.data = new Uint8Array(source.size).fill(100);
    },
  } as unknown as typeof CV;
  const result = measureCapturedBlur(
    cv,
    { width: 11003, height: 5007 } as ImageBitmap,
    [
      [0.001, 0.002],
      [0.999, 0.002],
      [0.999, 0.998],
      [0.001, 0.998],
    ],
  );
  expect(result.region).toBe("document-bounds");
  expect(result.sourceBounds).toEqual([1, 0, 11002, 5007]);
  expect(result.pixels).toEqual([600, 273]);
  expect(result.score).toBe(1);
  expect(maxCanvas).toBeLessThanOrEqual(AREA_TILE.width * AREA_TILE.height);
  expect(maxMat).toBeLessThanOrEqual(AREA_TILE.width * AREA_TILE.height);
  expect(deleted).toBe(reads + 1);
});
