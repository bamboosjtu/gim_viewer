/** At most one IFC WASM job and two isolated DEV jobs. Source-template
 * compilation does not consume the IFC anchor and may run alongside IFC. */
let active = 0;
let dev = 0;
let ifcQueue = Promise.resolve();
export const ifcGeometryBusy = () => active > 0;
export async function beginIfcGeometryWork(): Promise<() => void> {
  const previous = ifcQueue;
  let unlock!: () => void;
  ifcQueue = new Promise<void>(resolve => { unlock = resolve; });
  await previous;
  active++;
  let released = false;
  return () => { if (released) return; released = true; active--; unlock(); };
}
export function beginDevGeometryWork(): (() => void) | null {
  if (dev >= 2) return null;
  dev++; let released = false;
  return () => { if (released) return; released = true; dev--; };
}
