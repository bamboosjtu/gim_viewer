import CameraControls from 'camera-controls';
import { orientationAxes } from './orientationAxes.js';
import * as THREE from 'three';
import type { ViewerCommands, ViewerCommand, ToolSnapshot } from '../shared/viewerCommands.js';
import type { ViewerContext } from './viewerEngine.js';
import { requestViewerRender } from './demandRendering.js';
import { SectionController, initialSection } from './section/sectionController.js';
import { measureDistance } from './measurement/distanceMeasurement.js';
import { ToolOverlay } from './toolOverlay.js';

export function bindViewerTools(
  ctx: ViewerContext,
  host: HTMLElement,
  port: ViewerCommands,
  bindings: {
    anchor: () => THREE.Matrix4 | null;
    resolveAnchor: () => Promise<THREE.Matrix4 | null>;
    bounds: () => Promise<THREE.Box3>;
    filter: (command: ViewerCommand) => Promise<void>;
    reset: () => void;
    home: () => void;
    back: () => Promise<unknown>;
  },
) {
  const clip = new SectionController(ctx);
  let anchor: THREE.Matrix4 | null = null,
    revision = 0,
    next = 0;
  const matrix = () => bindings.anchor() ?? anchor;
  const controls = ctx.world.camera.controls;
  const originalLeft = controls?.mouseButtons.left;
  const removeAxes = orientationAxes(ctx, host, matrix);
  const overlay = new ToolOverlay(ctx, host, port, matrix);
  const applied = new THREE.Matrix4();
  function applySection(s: ToolSnapshot) {
    const m = matrix();
    if (m) applied.copy(m);
    clip.apply(s.section, m ?? undefined);
  }
  const updateAnchor = () => {
    const m = matrix();
    if (port.snapshot.section && m && !m.equals(applied)) {
      revision++;
      applySection(port.snapshot);
    }
  };
  const draw = () => {
    const s = port.snapshot;
    if (s.section || s.distances.length || s.first) overlay.draw();
  };
  ctx.world.renderer?.onAfterUpdate?.add(draw);
  ctx.world.onBeforeUpdate?.add(updateAnchor);
  const notify = () => {
    port.notify();
    overlay.draw();
    requestViewerRender(ctx);
  };
  port.cleanup = () => {
    revision++;
    next = 0;
    anchor = null;
    clip.apply();
    overlay.clear();
    if (controls && originalLeft !== undefined) controls.mouseButtons.left = originalLeft;
    bindings.reset();
  };
  port.execute = async (c) => {
    const s = port.snapshot;
    const seq = ++revision;
    s.message = '';
    if (c.kind === 'camera') {
      if (!controls) throw Error('相机尚未就绪');
      if (c.action === 'home') bindings.home();
      else if (c.action === 'back') await bindings.back();
      else if (c.action === 'orbit' || c.action === 'pan') {
        s.cameraMode = c.action;
        controls.mouseButtons.left =
          c.action === 'pan' ? CameraControls.ACTION.TRUCK : CameraControls.ACTION.ROTATE;
      } else if (c.action === 'zoomIn' || c.action === 'zoomOut') {
        const factor = c.action === 'zoomIn' ? 1.3 : 1 / 1.3,
          camera = ctx.world.camera.three;
        if (camera instanceof THREE.OrthographicCamera)
          await controls.zoomTo(camera.zoom * factor, false);
        else await controls.dollyTo(controls.distance / factor, false);
      } else {
        const dir = (
          {
            top: [0, -0.00001, 1],
            front: [0, -1, 0],
            right: [1, 0, 0],
            iso: [1, -1, 0.85],
          } as const
        )[c.action];
        const v = new THREE.Vector3(...dir);
        const frame = matrix() ?? (await bindings.resolveAnchor());
        if (seq !== revision) return;
        if (frame) v.transformDirection(frame);
        else v.applyAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
        const target = controls.getTarget(new THREE.Vector3()),
          eye = target.clone().addScaledVector(v.normalize(), Math.max(0.01, controls.distance));
        await controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
      }
    } else if (c.kind === 'tool') {
      if (s.tool !== c.tool) s.first = undefined;
      s.tool = c.tool;
      notify();
      if (c.tool === 'display') await bindings.filter({ kind: 'refreshOptions' });
      if (c.tool === 'distance' && !matrix()) {
        const resolved = await bindings.resolveAnchor();
        if (seq !== revision) return;
        anchor = resolved;
        if (!matrix()) s.message = '等待工程坐标基准';
      }
    } else if (c.kind === 'cancelPoint') {
      if (s.first) s.first = undefined;
      else s.tool = 'select';
    } else if (c.kind === 'clearDistances') {
      s.first = undefined;
      s.distances = [];
    } else if (c.kind === 'removeDistance') s.distances = s.distances.filter((d) => d.id !== c.id);
    else if (c.kind === 'clearSection') {
      s.section = undefined;
      applySection(s);
    } else if (c.kind === 'startSection') {
      const m = matrix() ?? (await bindings.resolveAnchor());
      if (seq !== revision) return;
      if (!m) throw Error('工程坐标基准尚未就绪');
      anchor = m;
      const bounds = await bindings.bounds();
      if (seq !== revision) return;
      s.first = undefined;
      s.tool = 'section';
      s.section = initialSection(c.shape, bounds.applyMatrix4(m.clone().invert()));
      applySection(s);
    } else if (c.kind === 'section') {
      const v = c.value;
      if (
        ![v.offset, v.azimuth, ...v.min, ...v.max].every(Number.isFinite) ||
        v.min.some((n, i) => n > v.max[i])
      )
        throw Error('剖切范围无效');
      s.section = { ...v, min: [...v.min], max: [...v.max] };
      applySection(s);
    } else await bindings.filter(c);
    if (seq === revision) notify();
  };
  port.notify();
  return {
    revision: () => revision,
    measuring: () => port.snapshot.tool === 'distance',
    clipTest: () => (clip.active ? clip.accepts : undefined),
    point(world: THREE.Vector3, source: string, lod: string) {
      const s = port.snapshot,
        m = matrix();
      if (!m || Math.abs(m.determinant()) < 1e-12) {
        s.message = '无法统一工程坐标或单位';
        notify();
        return;
      }
      const xyz = world.clone().applyMatrix4(m.clone().invert()).toArray();
      if (!xyz.every(Number.isFinite)) {
        s.message = '测点坐标无效';
        notify();
        return;
      }
      const end = { xyz, source, lod };
      if (!s.first) s.first = end;
      else {
        s.distances = [...s.distances, measureDistance(++next, s.first, end)];
        s.first = undefined;
      }
      s.message = '';
      notify();
    },
    miss() {
      port.snapshot.message = '请点击可见模型表面';
      notify();
    },
    dispose() {
      port.reset();
      port.execute = undefined;
      port.cleanup = undefined;
      removeAxes();
      overlay.dispose();
      ctx.world.renderer?.onAfterUpdate?.remove(draw);
      ctx.world.onBeforeUpdate?.remove(updateAnchor);
    },
  };
}
