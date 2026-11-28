/** Geometry-facing compatibility entry; the format-neutral check lives in parser. */
export { isUsableAffineMatrix } from "../parser/affineMatrix.js";

/** Column-major millimetre transforms, parent * child. Preserve shear and reflections. */
export function composePlacement(
  parent: readonly number[],
  child: readonly number[],
): number[] {
  const out = Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let value = 0;
      for (let k = 0; k < 4; k++)
        value += parent[4 * k + row] * child[4 * col + k];
      out[4 * col + row] = value;
    }
  }
  return out;
}
