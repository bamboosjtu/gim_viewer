/** At most one IFC WASM job and two isolated DEV jobs. Source-template
 * compilation does not consume the IFC anchor and may run alongside IFC. */
let active = 0;
let dev = 0;
let ifcCompleted = false;
let ifcQueue = Promise.resolve();
const listeners = new Set<() => void>();
let notificationPending = false;
function notifyAvailable(): void {
  if (notificationPending) return;
  notificationPending = true;
  queueMicrotask(() => {
    notificationPending = false;
    for (const listener of [...listeners]) listener();
  });
}
/** A pool must wake when another pool releases the shared computation gate. */
export function onGeometryWorkAvailable(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function geometryWorkSnapshot() {
  return { ifcActive: active, devActive: dev, ifcCompleted };
}
export const ifcGeometryBusy = () => active > 0;
/** True once at least one IFC conversion has completed in this process. */
export const hasCompletedIfcWork = () => ifcCompleted;
/** Project/session boundary: do not carry one project's IFC completion into the next. */
export function resetIfcWorkCompletion(): void {
  ifcCompleted = false;
}
/** Reserve the sole IFC lane while booting or reading. DEV budgeting sees
 * actual IFC work only after the source is ready for conversion. */
export async function reserveIfcGeometryWork() {
  const previous = ifcQueue;
  let unlock!: () => void;
  ifcQueue = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  await previous;
  let started = false,
    released = false;
  return {
    start() {
      if (started || released) return;
      started = true;
      active++;
    },
    release(this: void) {
      if (released) return;
      released = true;
      if (started) {
        active--;
        ifcCompleted = true;
      }
      unlock();
      if (started) notifyAvailable();
    },
  };
}
export async function beginIfcGeometryWork(): Promise<() => void> {
  const reservation = await reserveIfcGeometryWork();
  reservation.start();
  return reservation.release;
}
export function beginDevGeometryWork(limit = 2): (() => void) | null {
  if (dev >= Math.max(1, Math.floor(limit))) return null;
  dev++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    dev--;
    notifyAvailable();
  };
}

/** Test-only isolation for the process-global gate. */
export function resetGeometryWorkGateForTests(): void {
  active = 0;
  dev = 0;
  ifcCompleted = false;
  ifcQueue = Promise.resolve();
}
