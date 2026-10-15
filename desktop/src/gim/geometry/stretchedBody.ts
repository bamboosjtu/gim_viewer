/** Observed XML encodings: unit direction + L, or a complete displacement.
 * Keep this interpretation shared by tessellation and analytic bounds.
 */
export function stretchedBodyDisplacement(normal: string, length: number): {
  mode: 'direction-length' | 'displacement'; vector: [number, number, number];
} | null {
  const parts = normal.split(',');
  if (parts.length !== 3 || parts.some(part => !part.trim())) return null;
  const values = parts.map(Number), magnitude = Math.hypot(...values);
  if (!values.every(Number.isFinite) || magnitude <= Number.EPSILON) return null;
  const direction = Math.abs(magnitude - 1) <= 1e-6;
  if (direction && (!Number.isFinite(length) || length === 0)) return null;
  const scale = direction ? length / magnitude : 1;
  return { mode: direction ? 'direction-length' : 'displacement',
    vector: values.map(value => value * scale) as [number, number, number] };
}
