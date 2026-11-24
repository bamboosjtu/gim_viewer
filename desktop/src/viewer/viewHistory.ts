import { cameraPoseHub } from './cameraPoseHub.js';
import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';

interface ViewSnapshot<Visibility> {
  position: [number, number, number];
  target: [number, number, number];
  visibility?: Visibility;
}

export interface ViewerViewHistoryOptions<Visibility> {
  getVisibility?: () => Visibility;
  sameVisibility?: (a: Visibility, b: Visibility) => boolean;
  setVisibility?: (
    value: Visibility,
    current: () => boolean,
  ) => void | boolean | Promise<void | boolean>;
  onChange?: () => void;
}

// CameraControls converts Cartesian coordinates through spherical coordinates.
// Ignore micrometre round-off in navigation history, never in model geometry.
function sameCamera<Visibility>(
  a: ViewSnapshot<Visibility> | null,
  b: ViewSnapshot<Visibility>,
): boolean {
  return (
    !!a &&
    a.position.every((value, i) => Math.abs(value - b.position[i]) <= 1e-6) &&
    a.target.every((value, i) => Math.abs(value - b.target[i]) <= 1e-6)
  );
}

/** Session-only camera history for a browser workflow.
 * It records settled camera states and never persists a project location. */
export class ViewerViewHistory<Visibility = string> {
  private readonly stack: ViewSnapshot<Visibility>[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private suspended = false;
  private readonly unsubscribe: () => void;
  private restoring = false;
  private generation = 0;
  private disposed = false;
  private cancelRestore: (() => void) | null = null;
  private readonly onControlStart = (): void => {
    this.cancelRestore?.();
  };
  private readonly onCameraUpdate = (): void => {
    if (this.suspended || this.restoring || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.record();
    }, 220);
  };

  constructor(
    private readonly ctx: ViewerContext,
    private readonly maxEntries = 20,
    private readonly options: ViewerViewHistoryOptions<Visibility> = {},
  ) {
    const controls = ctx.world.camera.controls as
      | (typeof ctx.world.camera.controls & {
          addEventListener?: (type: string, listener: () => void) => void;
        })
      | undefined;
    this.unsubscribe = cameraPoseHub(ctx).subscribe(({ owner }) => {
      if (owner.source === 'orbit') this.onCameraUpdate();
    });
    controls?.addEventListener?.('controlstart', this.onControlStart);
    this.record();
  }

  get canGoBack(): boolean {
    if (this.suspended) return false;
    if (this.restoring || this.disposed) return false;
    return (
      this.stack.length >= 2 ||
      (this.stack.length === 1 &&
        this.timer !== null &&
        !this.sameView(this.snapshot(), this.stack[0]))
    );
  }

  private sameVisibility(a?: Visibility, b?: Visibility): boolean {
    return a === b || (a !== undefined && b !== undefined && !!this.options.sameVisibility?.(a, b));
  }

  private sameView(a: ViewSnapshot<Visibility> | null, b?: ViewSnapshot<Visibility>): boolean {
    return !!a && !!b && this.sameVisibility(a.visibility, b.visibility) && sameCamera(a, b);
  }

  private snapshot(receiveEndValue = true): ViewSnapshot<Visibility> | null {
    const controls = this.ctx.world.camera.controls;
    if (!controls?.getPosition || !controls.getTarget) return null;
    // Store destinations rather than the damping tail of a restored view.
    const position = controls.getPosition(new THREE.Vector3(), receiveEndValue);
    const target = controls.getTarget(new THREE.Vector3(), receiveEndValue);
    if (![...position.toArray(), ...target.toArray()].every(Number.isFinite)) return null;
    return {
      position: position.toArray(),
      target: target.toArray(),
      visibility: this.options.getVisibility?.(),
    };
  }

  private record(): void {
    if (this.suspended || this.disposed) return;
    const next = this.snapshot();
    if (!next) return;
    const previous = this.stack[this.stack.length - 1];
    if (this.sameView(next, previous)) return;
    this.stack.push(next);
    if (this.stack.length > this.maxEntries)
      this.stack.splice(0, this.stack.length - this.maxEntries);
    this.options.onChange?.();
  }

  async back(): Promise<boolean> {
    if (this.suspended) return false;
    if (this.restoring || this.disposed) return false;
    const controls = this.ctx.world.camera.controls;
    if (!controls?.setLookAt) return false;
    // A user need not wait for the debounce to return from their latest move.
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.record();
    }
    if (this.stack.length < 2) return false;
    const current = this.stack[this.stack.length - 1];
    const previous = this.stack[this.stack.length - 2];
    const rollback = this.snapshot(false);
    const generation = this.generation;
    let cancelled = false;
    const currentRestore = () => !cancelled && generation === this.generation;
    let visibilityCommitStarted = false;
    this.restoring = true;
    const setCamera = (view: ViewSnapshot<Visibility>, animate: boolean) =>
      controls.setLookAt(...view.position, ...view.target, animate);
    const interrupted = new Promise<boolean>((resolve) => {
      this.cancelRestore = () => {
        if (cancelled) return;
        cancelled = true;
        // stop() alone jumps to the old destination in CameraControls 3.1.2.
        // Freeze the current view before stopping this history-owned movement.
        try {
          const at = this.snapshot(false);
          if (at) void Promise.resolve(setCamera(at, false)).catch(() => {});
          controls.stop?.();
          // Consume the controller's final update while history is still
          // suppressed; it must not seed a cleared/new project's history.
          controls.update?.(0);
        } catch {
          /* Unavailable camera controls must not block project cleanup. */
        } finally {
          resolve(false);
        }
      };
    });
    try {
      const completed = await Promise.race([
        Promise.resolve(setCamera(previous, true)).then(() => true),
        interrupted,
      ]);
      if (!completed || !currentRestore()) return false;
      const arrived = this.snapshot();
      if (
        !arrived ||
        !this.sameVisibility(arrived.visibility, current.visibility) ||
        !sameCamera(arrived, previous)
      ) {
        // Another navigation action superseded the history-owned destination.
        // Keep its camera and filter, and record it once this action settles.
        this.restoring = false;
        this.onCameraUpdate();
        return false;
      }
      // Commit the filter and consume history only after successful movement.
      if (
        previous.visibility !== undefined &&
        !this.sameVisibility(previous.visibility, current.visibility)
      ) {
        visibilityCommitStarted = true;
        const applied = await Promise.race([
          Promise.resolve(this.options.setVisibility?.(previous.visibility, currentRestore)),
          interrupted,
        ]);
        if (!currentRestore() || applied === false) return false;
      }
      this.stack.pop();
      return true;
    } catch (error) {
      if (!currentRestore()) return false;
      if (
        !visibilityCommitStarted &&
        !this.sameVisibility(this.snapshot()?.visibility, current.visibility)
      ) {
        this.restoring = false;
        this.onCameraUpdate();
        return false;
      }
      try {
        if (visibilityCommitStarted && current.visibility !== undefined)
          await this.options.setVisibility?.(current.visibility, currentRestore);
        if (rollback && currentRestore()) await setCamera(rollback, false);
      } catch {
        /* Keep the entry retryable even if the controls remain unavailable. */
      }
      if (!currentRestore()) return false;
      throw error;
    } finally {
      if (generation === this.generation) {
        this.restoring = false;
        this.cancelRestore = null;
        this.options.onChange?.();
      }
    }
  }

  /** Record a visibility/filter change as a navigable browser state. */
  recordVisibility(): void {
    if (!this.restoring) this.record();
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.record();
    }
  }
  suspend(): void {
    this.interruptRestore();
    this.flush();
    this.suspended = true;
  }
  resume(): void {
    this.suspended = false;
  }

  interruptRestore(): void {
    this.cancelRestore?.();
  }

  clear(): void {
    this.suspended = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const cancel = this.cancelRestore;
    this.cancelRestore = null;
    try {
      cancel?.();
    } finally {
      this.restoring = false;
      this.stack.length = 0;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    const controls = this.ctx.world.camera.controls as
      | (typeof this.ctx.world.camera.controls & {
          removeEventListener?: (type: string, listener: () => void) => void;
        })
      | undefined;
    this.unsubscribe();
    controls?.removeEventListener?.('controlstart', this.onControlStart);
  }
}
