/**
 * Google's Turbo colormap (blue, cyan, green, yellow, red) as 256 RGB triples, from Anton
 * Mikhailov's polynomial fit. Its full hue range stays readable under `color` blending, where the
 * photo supplies brightness and the map supplies only hue and saturation.
 */
export const TURBO_LUT: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  const channel = (t: number, c: readonly number[]): number =>
    255 * (c[0]! + t * (c[1]! + t * (c[2]! + t * (c[3]! + t * (c[4]! + t * c[5]!)))));
  const red = [0.13572138, 4.6153926, -42.66032258, 132.13108234, -152.94239396, 59.28637943];
  const green = [0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604];
  const blue = [0.1066733, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973];
  for (let index = 0; index < 256; index += 1) {
    const t = index / 255;
    lut[index * 3] = channel(t, red);
    lut[index * 3 + 1] = channel(t, green);
    lut[index * 3 + 2] = channel(t, blue);
  }
  return lut;
})();

/** The same colormap as a left-to-right CSS gradient, for a weak-to-strong legend. */
export const TURBO_GRADIENT = `linear-gradient(to right, ${Array.from({ length: 9 }, (_, stop) => {
  const index = Math.round((stop / 8) * 255) * 3;
  return `rgb(${TURBO_LUT[index]} ${TURBO_LUT[index + 1]} ${TURBO_LUT[index + 2]})`;
}).join(", ")})`;
