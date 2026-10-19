/** At most one IFC WASM job and two isolated DEV jobs. Source-template
 * compilation does not consume the IFC anchor and may run alongside IFC. */
let active = 0;
let dev = 0;
let ifcCompleted = false;
let ifcQueue = Promise.resolve();
export const ifcGeometryBusy = () => active > 0;
/** True once at least one IFC conversion has completed in this process. */
export const hasCompletedIfcWork = () => ifcCompleted;
/** Project/session boundary: do not carry one project's IFC completion into the next. */
export function resetIfcWorkCompletion(): void { ifcCompleted = false; }
export async function beginIfcGeometryWork(): Promise<() => void> {
  const previous = ifcQueue;
  let unlock!: () => void;
  ifcQueue = new Promise<void>(resolve => { unlock = resolve; });
  await previous;
  active++;
  let released = false;
  return () => { if (released) return; released = true; active--; ifcCompleted = true; unlock(); };
}
export function beginDevGeometryWork(limit = 2): (() => void) | null {
  if (dev >= Math.max(1, Math.floor(limit))) return null;
  dev++; let released = false;
  return () => { if (released) return; released = true; dev--; };
}

/** Test-only isolation for the process-global gate. */
export function resetGeometryWorkGateForTests(): void {
  active = 0;
  dev = 0;
  ifcCompleted = false;
  ifcQueue = Promise.resolve();
}
