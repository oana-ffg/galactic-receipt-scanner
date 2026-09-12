// A camera-session reference explicitly supplied by the operator. Never learn
// the background from a rejected paper frame or update it while scanning.
export class DeskReference {
  private pixels?: Uint8ClampedArray;
  set(pixels: Uint8ClampedArray) {
    this.pixels = pixels.slice();
  }
  matches(pixels: Uint8ClampedArray, width: number): boolean | undefined {
    const reference = this.pixels;
    if (!reference) return undefined;
    if (reference.length !== pixels.length) return false;
    const height = pixels.length / 4 / width;
    let total = 0;
    // Local checks prevent a small moved/folded sheet from disappearing into
    // an average dominated by the unchanged desk. No geometric alignment or
    // brightness correction can turn a changed scene into an empty one.
    for (let y = 0; y < height; y += 8)
      for (let x = 0; x < width; x += 8) {
        let tile = 0,
          count = 0;
        for (let dy = y; dy < Math.min(y + 8, height); dy++)
          for (let dx = x; dx < Math.min(x + 8, width); dx++) {
            const i = (dy * width + dx) * 4;
            for (let c = 0; c < 3; c++) {
              tile += Math.abs(pixels[i + c] - reference[i + c]);
              count++;
            }
          }
        if (tile / count > 12) return false;
        total += tile;
      }
    return total / (width * height * 3) <= 4;
  }
}
