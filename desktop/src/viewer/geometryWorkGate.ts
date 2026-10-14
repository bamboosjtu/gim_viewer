/** IFC atomic work excludes DEV triangulation; metadata work may continue. */
let active = 0;
let dev: { done: Promise<void>; release: () => void } | null = null;
const listeners = new Set<() => void>();
export const ifcGeometryBusy = () => active > 0;
export function onIfcGeometryIdle(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export async function beginIfcGeometryWork(): Promise<() => void> {
  active++; for (const listener of listeners) listener();
  if (dev) await dev.done; // finish the currently running DEV atomic unit
  let released = false;
  return () => { if (released) return; released = true; active--; for (const listener of listeners) listener(); };
}
export function beginDevGeometryWork(): (() => void) | null {
  if (active || dev) return null;
  let resolve!: () => void;
  const lease = { done: new Promise<void>(r => { resolve = r; }), release: () => resolve() };
  dev = lease;
  return () => { if (dev !== lease) return; dev = null; lease.release(); };
}
