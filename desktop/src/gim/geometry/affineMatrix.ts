/** GIM placements are column-major affine transforms. Reject projective or
 * collapsed bases before they reach Object3D.decompose / world placement.
 * Normalized columns preserve valid small unit scales and reflections. */
export function isUsableAffineMatrix(values: readonly number[]): boolean {
  if (values.length !== 16 || !values.every(Number.isFinite)) return false;
  if ([3, 7, 11].some(i => Math.abs(values[i]) > 1e-6) || Math.abs(values[15] - 1) > 1e-6) return false;
  const lengths = [0, 4, 8].map(i => Math.hypot(values[i], values[i + 1], values[i + 2]));
  if (lengths.some(n => !Number.isFinite(n) || n === 0)) return false;
  const [a,b,c] = [0,4,8].map((i, n) => values.slice(i, i + 3).map(v => v / lengths[n]));
  const determinant = a[0]*(b[1]*c[2]-b[2]*c[1]) - b[0]*(a[1]*c[2]-a[2]*c[1]) + c[0]*(a[1]*b[2]-a[2]*b[1]);
  return Math.abs(determinant) > 1e-12;
}
