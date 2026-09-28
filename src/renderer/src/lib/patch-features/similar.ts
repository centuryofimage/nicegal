import type { F32Tensor } from "./safetensors";

import { TURBO_LUT } from "./colormap";

/** Map one score grid across its own range to opaque Turbo pixels. */
export function colorizeScores(scores: ArrayLike<number>): {
  pixels: Uint8ClampedArray<ArrayBuffer>;
  low: number;
  high: number;
} {
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < scores.length; i += 1) {
    low = Math.min(low, scores[i]!);
    high = Math.max(high, scores[i]!);
  }
  const pixels = new Uint8ClampedArray(scores.length * 4);
  const range = high - low;
  for (let i = 0; i < scores.length; i += 1) {
    const t = range > 1e-6 ? (scores[i]! - low) / range : 1;
    const color = Math.round(t * 255) * 3;
    pixels[i * 4] = TURBO_LUT[color]!;
    pixels[i * 4 + 1] = TURBO_LUT[color + 1]!;
    pixels[i * 4 + 2] = TURBO_LUT[color + 2]!;
    pixels[i * 4 + 3] = 255;
  }
  return { pixels, low, high };
}

/** Compare one patch with every patch in the same unit-length feature grid. */
export function similarityPixels(
  patches: F32Tensor,
  index: number,
): Uint8ClampedArray<ArrayBuffer> {
  const [rows = 0, columns = 0, dimensions = 0] = patches.shape;
  const count = rows * columns;
  if (index < 0 || index >= count) throw new RangeError("Patch index is outside the grid");
  const scores = new Float32Array(count);
  const reference = index * dimensions;
  for (let patch = 0; patch < count; patch += 1) {
    let score = 0;
    for (let d = 0; d < dimensions; d += 1)
      score += patches.data[patch * dimensions + d]! * patches.data[reference + d]!;
    scores[patch] = score;
  }
  return colorizeScores(scores).pixels;
}
