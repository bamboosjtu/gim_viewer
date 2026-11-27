import type { Point3 } from "./analysisGeometry.js";
import {
  add3,
  cross3,
  dot3,
  mul3,
  sub3,
  unit3,
  type SweepFrame,
} from "./sweep.js";

/** A disk projects r*sin(turn) along the adjacent disk's normal. Keeping
 * positive axial clearance on both sides prevents short, tilted rings from
 * folding into one another when stitching corresponding vertices. */
function separated(
  a: Point3,
  b: Point3,
  chord: Point3,
  radius: number,
): boolean {
  const advance = Math.min(dot3(a, chord), dot3(b, chord));
  const cosine = dot3(a, b);
  if (advance <= 0 || cosine <= 0) return false;
  return (
    advance > radius ||
    advance * advance > radius * radius * Math.max(0, 1 - cosine * cosine)
  );
}

/** Adjust only interior planes of the discrete Wire preview. Centres, radius,
 * endpoint planes, segment count and index topology all stay fixed. */
export function separateWireSections(
  frames: SweepFrame[],
  radius: number,
): boolean {
  const last = frames.length - 1;
  const chord = (i: number) => sub3(frames[i + 1].center, frames[i].center);
  let touched = false,
    deferred = false;
  function constrain(anchor: number, movable: number) {
    const fixed = frames[anchor],
      target = frames[movable],
      a = fixed.tangent,
      b = target.tangent;
    const d = chord(Math.min(anchor, movable));
    if (separated(a, b, d, radius)) return;
    const advance = dot3(a, d);
    if (!(advance > 0)) {
      deferred = true;
      return;
    }
    touched = true;
    const axis = cross3(a, b),
      sine = Math.hypot(...axis),
      cosine = dot3(a, b);
    let tangent = a;
    if (sine > Number.EPSILON) {
      const u = unit3(cross3(axis, a));
      // New tangent = a*cos(t) + u*sin(t). Each of the two clearance
      // inequalities bounds the turn; reserve Float32 coordinate roundoff.
      const scale = Math.max(
        radius,
        ...fixed.center.map(Math.abs),
        ...target.center.map(Math.abs),
      );
      const run = Math.max(0, advance - 8 * 2 ** -23 * scale);
      const angle = Math.min(
        Math.atan2(sine, cosine),
        Math.asin(Math.min(1, run / radius)),
        Math.atan2(run, radius - dot3(d, u)),
      );
      tangent = add3(mul3(a, Math.cos(angle)), mul3(u, Math.sin(angle)));
    }
    target.tangent = tangent;
  }
  for (let i = 0; i < last - 1; i++) constrain(i, i + 1);
  if (
    deferred ||
    !separated(
      frames[last - 1].tangent,
      frames[last].tangent,
      chord(last - 1),
      radius,
    )
  ) {
    for (let i = last; i > 1; i--) constrain(i, i - 1);
    deferred = true;
  }
  if (touched || deferred) {
    for (let i = 0; i < last; i++)
      if (
        !separated(frames[i].tangent, frames[i + 1].tangent, chord(i), radius)
      )
        return false;
  }
  return true;
}
