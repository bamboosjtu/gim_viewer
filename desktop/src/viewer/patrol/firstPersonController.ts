import { Matrix4, Vector3 } from 'three';
import type { OrthoPerspectiveCamera } from '@thatopen/components';
import type { ViewerContext } from '../viewerEngine.js';
import { cameraPoseHub } from '../cameraPoseHub.js';
import type { ViewerNavigationCommands } from '../../shared/viewerNavigationCommands.js';
import { patrolProfile as profile, type NavigationQueryPort } from './navigationQueryPort.js';

/** The owner stops the RAF whenever movement settles. RenderDemand is notified by the camera hub. */
export class FirstPersonController {
  private readonly hub;
  private readonly keys = new Set<string>();
  private readonly events = new AbortController();
  private readonly camera: OrthoPerspectiveCamera;
  private owner?: ReturnType<ReturnType<typeof cameraPoseHub>['claim']>;
  readonly tickMs: number[] = [];
  ticks = 0;
  capped = 0;
  private frame = 0;
  private stamp = 0;
  private accumulator = 0;
  private yaw = 0;
  private pitch = 0;
  private drag?: number;
  private dragX = 0;
  private dragY = 0;
  private delayed = false;
  private inputEpoch = 0;
  private dx = 0;
  private dy = 0;
  readonly feet: Vector3;
  readonly entry: Vector3;
  private readonly entryYaw: number;
  constructor(
    ctx: ViewerContext,
    private canvas: HTMLCanvasElement,
    private commands: ViewerNavigationCommands,
    private nav: NavigationQueryPort,
    private sourceFrame: Matrix4,
    entry: Vector3,
    private generation: number,
    private valid: () => boolean,
    private runSignal: AbortSignal,
  ) {
    this.hub = cameraPoseHub(ctx);
    this.camera = ctx.world.camera as OrthoPerspectiveCamera;
    this.feet = entry.clone();
    this.entry = entry.clone();
    const dir = this.camera.three
      .getWorldDirection(new Vector3())
      .transformDirection(sourceFrame.clone().invert());
    this.entryYaw = this.yaw = Math.atan2(dir.x, dir.y);
    const { signal } = this.events;
    const key = (e: KeyboardEvent, down: boolean) => {
      if (commands.mode !== 'walking' || e.ctrlKey || e.altKey || e.metaKey) return;
      if (
        !['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'KeyF', 'KeyE'].includes(
          e.code,
        )
      )
        return;
      e.preventDefault();
      if (e.code === 'KeyE') {
        if (down && !e.repeat && commands.doorHint) commands.execute?.('door');
        return;
      }
      if (e.code === 'KeyF') {
        if (down && !e.repeat) commands.execute?.('inspect');
        return;
      }
      if (down) this.keys.add(e.code);
      else this.keys.delete(e.code);
      this.wake();
    };
    window.addEventListener('keydown', (e) => key(e, true), { signal });
    window.addEventListener('keyup', (e) => key(e, false), { signal });
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        if (commands.mode === 'walking' && commands.dragLook && e.button === 0) {
          this.drag = e.pointerId;
          this.dragX = e.clientX;
          this.dragY = e.clientY;
          canvas.setPointerCapture?.(e.pointerId);
          e.preventDefault();
        }
      },
      { signal },
    );
    canvas.addEventListener(
      'pointermove',
      (e) => {
        if (
          this.drag !== e.pointerId ||
          commands.mode !== 'walking' ||
          document.pointerLockElement === canvas
        )
          return;
        this.dx += e.clientX - this.dragX;
        this.dy += e.clientY - this.dragY;
        this.dragX = e.clientX;
        this.dragY = e.clientY;
        this.wake();
      },
      { signal },
    );
    const release = () => {
      this.drag = undefined;
    };
    canvas.addEventListener('lostpointercapture', release, { signal });
    canvas.addEventListener('pointerup', release, { signal });
    canvas.addEventListener('pointercancel', release, { signal });
    document.addEventListener(
      'mousemove',
      (e) => {
        if (commands.mode === 'walking' && document.pointerLockElement === canvas) {
          this.dx += e.movementX;
          this.dy += e.movementY;
          this.wake();
        }
      },
      { signal },
    );
    document.addEventListener(
      'pointerlockchange',
      () => {
        if (document.pointerLockElement === canvas) {
          if (commands.mode !== 'walking') {
            document.exitPointerLock();
            return;
          }
          commands.dragLook = false;
          commands.set('walking');
        } else if (commands.mode === 'walking' && !commands.dragLook) commands.execute?.('pause');
      },
      { signal },
    );
    const blur = () => {
      if (commands.mode === 'walking') commands.execute?.('pause');
    };
    window.addEventListener('blur', blur, { signal });
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) blur();
      },
      { signal },
    );
  }
  takeCamera() {
    this.owner = this.hub.claim('patrol', this.generation);
    this.camera.controls.enabled = false;
    this.apply();
  }
  walk() {
    this.commands.dragLook = true;
    this.commands.set('walking', '开始巡视');
    this.canvas.tabIndex = 0;
    this.canvas.focus({ preventScroll: true });
    const epoch = ++this.inputEpoch;
    const fallback = () => {
      if (epoch !== this.inputEpoch || !this.valid() || this.commands.mode !== 'walking') return;
      if (!document.hasFocus() || document.activeElement !== this.canvas) {
        this.commands.execute?.('pause');
        return;
      }
      this.commands.dragLook = true;
      this.commands.set('walking', '');
    };
    try {
      if (this.canvas.requestPointerLock) {
        const request = this.canvas.requestPointerLock();
        Promise.resolve(request).then(() => {
          if (document.pointerLockElement !== this.canvas) fallback();
        }, fallback);
      } else fallback();
    } catch {
      fallback();
    }
  }
  private apply() {
    if (!this.owner || !this.valid()) return;
    this.hub.write(this.owner, () => {
      const cam = this.camera.threePersp;
      cam.position
        .copy(this.feet)
        .add(new Vector3(0, 0, profile.eyeHeight))
        .applyMatrix4(this.sourceFrame);
      cam.up.set(0, 0, 1).transformDirection(this.sourceFrame);
      const c = Math.cos(this.pitch);
      const forward = new Vector3(
        Math.sin(this.yaw) * c,
        Math.cos(this.yaw) * c,
        Math.sin(this.pitch),
      ).transformDirection(this.sourceFrame);
      cam.lookAt(forward.add(cam.position));
      cam.updateMatrixWorld();
    });
  }
  private wake() {
    if (!this.frame && this.commands.mode === 'walking') {
      if (!this.stamp) this.stamp = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
  }
  private tick = (now: number) => {
    this.frame = 0;
    if (!this.valid()) {
      this.commands.execute?.('pause');
      return;
    }
    if (this.commands.mode !== 'walking') return;
    if (this.accumulator + (now - this.stamp) / 1000 > 5 / 60) this.capped++;
    this.accumulator = Math.min(this.accumulator + (now - this.stamp) / 1000, 5 / 60);
    this.stamp = now;
    let changed = !!(this.dx || this.dy);
    this.yaw += this.dx * 0.002;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - this.dy * 0.002));
    this.dx = this.dy = 0;
    const x = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA'));
    const y = Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS'));
    let advance = !!(x || y);
    const speed =
      this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? profile.fast : profile.walk;
    const delta = new Vector3(
      x * Math.cos(this.yaw) + y * Math.sin(this.yaw),
      y * Math.cos(this.yaw) - x * Math.sin(this.yaw),
      0,
    )
      .normalize()
      .multiplyScalar(speed / 60);
    while (advance && this.accumulator + 1e-10 >= 1 / 60) {
      const started = performance.now();
      this.accumulator -= 1 / 60;
      const to = this.feet.clone().add(delta),
        result = this.nav.step(this.feet, to);
      if ('reason' in result) {
        this.commands.set('walking', result.reason);
        advance = false;
        if (result.reason.includes('正在准备') && !this.delayed) {
          this.delayed = true;
          const epoch = this.inputEpoch;
          void this.nav
            .prepare(to, this.runSignal)
            .then(
              () => {
                if (epoch === this.inputEpoch) this.wake();
              },
              (e) => {
                if (epoch === this.inputEpoch) this.commands.set('walking', String(e));
              },
            )
            .finally(() => {
              this.delayed = false;
            });
        }
      } else {
        this.feet.copy(result.feet);
        changed = true;
        this.commands.set('walking');
      }
      this.tickMs[this.ticks++ % 4096] = performance.now() - started;
    }
    if (changed) this.apply();
    if (advance) this.wake();
    else {
      this.stamp = 0;
      this.accumulator = 0;
    }
  };
  returnToEntry() {
    this.feet.copy(this.entry);
    this.yaw = this.entryYaw;
    this.pitch = 0;
    this.apply();
  }
  stop() {
    this.inputEpoch++;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.stamp = this.accumulator = 0;
    this.keys.clear();
    this.dx = this.dy = 0;
    if (this.drag !== undefined && this.canvas.hasPointerCapture?.(this.drag))
      this.canvas.releasePointerCapture(this.drag);
    this.drag = undefined;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
  dispose() {
    this.events.abort();
    this.stop();
  }
}
