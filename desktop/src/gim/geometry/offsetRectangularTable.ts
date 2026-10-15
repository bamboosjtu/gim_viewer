/** XY-centred lower rectangle at Z=0; upper rectangle at Z=H with XOFF/YOFF.
 * Only the observed explicit seven-field encoding is accepted.
 */
export function offsetRectangularTableVertices(raw: Record<string, string>): number[] | null {
  const keys = ['LL', 'LW', 'TL', 'TW', 'H', 'XOFF', 'YOFF'];
  if (keys.some(key => raw[key] == null || !raw[key].trim())) return null;
  const [ll, lw, tl, tw, h, x, y] = keys.map(key => Number(raw[key]));
  if (![ll, lw, tl, tw, h, x, y].every(Number.isFinite) || Math.min(ll, lw, tl, tw, h) <= 0) return null;
  return [-ll/2,-lw/2,0, ll/2,-lw/2,0, ll/2,lw/2,0, -ll/2,lw/2,0,
    x-tl/2,y-tw/2,h, x+tl/2,y-tw/2,h, x+tl/2,y+tw/2,h, x-tl/2,y+tw/2,h];
}
