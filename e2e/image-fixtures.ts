import type { Page } from "@playwright/test";

declare global {
  interface Window {
    blurFixture: (canvas: HTMLCanvasElement, radius: number) => void;
  }
}

export async function installImageFixtures(page: Page) {
  await page.addInitScript(() => {
    // Pixel blur works in Safari too; CanvasRenderingContext2D.filter does not.
    window.blurFixture = (canvas, radius) => {
      const ctx = canvas.getContext("2d")!;
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const temporary = new Uint8ClampedArray(image.data.length);
      const { width, height } = canvas;
      const convolve = (
        source: Uint8ClampedArray,
        dest: Uint8ClampedArray,
        horizontal: boolean,
      ) => {
        const length = horizontal ? width : height,
          rows = horizontal ? height : width;
        const index = (row: number, position: number, channel: number) =>
          4 * (horizontal ? row * width + position : position * width + row) +
          channel;
        for (let row = 0; row < rows; row++)
          for (let channel = 0; channel < 4; channel++) {
            let sum = 0;
            for (let k = -radius; k <= radius; k++)
              sum +=
                source[
                  index(row, Math.max(0, Math.min(length - 1, k)), channel)
                ];
            for (let position = 0; position < length; position++) {
              dest[index(row, position, channel)] = sum / (radius * 2 + 1);
              sum +=
                source[
                  index(
                    row,
                    Math.min(length - 1, position + radius + 1),
                    channel,
                  )
                ] - source[index(row, Math.max(0, position - radius), channel)];
            }
          }
      };
      convolve(image.data, temporary, true);
      convolve(temporary, image.data, false);
      ctx.putImageData(image, 0, 0);
    };
  });
}
