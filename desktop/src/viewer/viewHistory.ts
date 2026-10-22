import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';

interface ViewSnapshot {
  position: [number, number, number];
  target: [number, number, number];
  visibility?: string;
}

export interface ViewerViewHistoryOptions {
  getVisibility?: () => string;
  setVisibility?: (value: string) => void;
}

/** Session-only camera history for a browser workflow.
 * It records settled camera states and never persists a project location. */
export class ViewerViewHistory {
  private readonly stack: ViewSnapshot[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private restoring = false;
  private readonly onCameraUpdate = (): void => {
    if (this.restoring) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.record();
    }, 220);
  };

  constructor(
    private readonly ctx: ViewerContext,
    private readonly maxEntries = 20,
    private readonly options: ViewerViewHistoryOptions = {},
  ) {
    const controls = ctx.world.camera.controls as (typeof ctx.world.camera.controls & {
      addEventListener?: (type: string, listener: () => void) => void;
    }) | undefined;
    controls?.addEventListener?.('update', this.onCameraUpdate);
    this.record();
  }

  get canGoBack(): boolean {
    return this.stack.length >= 2;
  }

  private snapshot(): ViewSnapshot | null {
    const controls = this.ctx.world.camera.controls;
    if (!controls?.getPosition || !controls.getTarget) return null;
    const position = controls.getPosition(new THREE.Vector3(), false);
    const target = controls.getTarget(new THREE.Vector3(), false);
    if (![...position.toArray(), ...target.toArray()].every(Number.isFinite)) return null;
    return {
      position: position.toArray() as ViewSnapshot['position'],
      target: target.toArray() as ViewSnapshot['target'],
      visibility: this.options.getVisibility?.(),
    };
  }

  private record(): void {
    const next = this.snapshot();
    if (!next) return;
    const previous = this.stack[this.stack.length - 1];
    if (previous && previous.position.every((value: number, index: number) => value === next.position[index])
      && previous.target.every((value: number, index: number) => value === next.target[index])
      && previous.visibility === next.visibility) return;
    this.stack.push(next);
    if (this.stack.length > this.maxEntries) this.stack.splice(0, this.stack.length - this.maxEntries);
  }

  async back(): Promise<boolean> {
    if (this.stack.length < 2) return false;
    this.stack.pop();
    const previous = this.stack[this.stack.length - 1];
    const controls = this.ctx.world.camera.controls;
    if (!previous || !controls?.setLookAt) return false;
    this.restoring = true;
    try {
      if (previous.visibility !== undefined) this.options.setVisibility?.(previous.visibility);
      await controls.setLookAt(
        previous.position[0], previous.position[1], previous.position[2],
        previous.target[0], previous.target[1], previous.target[2], true,
      );
      return true;
    } finally {
      this.restoring = false;
    }
  }

  /** Record a visibility/filter change as a navigable browser state. */
  recordVisibility(): void {
    if (!this.restoring) this.record();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stack.length = 0;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const controls = this.ctx.world.camera.controls as (typeof this.ctx.world.camera.controls & {
      removeEventListener?: (type: string, listener: () => void) => void;
    }) | undefined;
    controls?.removeEventListener?.('update', this.onCameraUpdate);
    this.stack.length = 0;
  }
}
