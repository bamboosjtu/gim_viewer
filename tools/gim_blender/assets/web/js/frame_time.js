// Bound long stalls without tying movement speed to render FPS. Each physics
// slice stays small; tryMove still performs its original collision subdivisions.
export function advancePlayer(seconds, update) {
  const elapsed = Math.min(.25, Math.max(0, seconds));
  const count = Math.max(1, Math.ceil(elapsed / .025));
  for (let index = 0; index < count; index++) update(elapsed / count);
  return elapsed;
}
