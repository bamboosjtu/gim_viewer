/** At most one IFC WASM job and two isolated DEV jobs. Source-template
 * compilation does not consume the IFC anchor and may run alongside IFC. */
let active = 0;
let dev = 0;
let ifcQueue = Promise.resolve();
const listeners = new Set<() => void>();
export const ifcGeometryBusy = () => active > 0;
export function onIfcGeometryIdle(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export async function beginIfcGeometryWork(): Promise<() => void> {
  const previous = ifcQueue;
  let unlock!: () => void;
  ifcQueue = new Promise<void>(resolve => { unlock = resolve; });
  await previous;
  active++; for (const listener of listeners) listener();
  let released = false;
  return () => { if (released) return; released = true; active--; unlock(); for (const listener of listeners) listener(); };
}
export function beginDevGeometryWork(): (() => void) | null {
  if (dev >= 2) return null;
  dev++; let released = false;
  return () => { if (released) return; released = true; dev--; };
}
