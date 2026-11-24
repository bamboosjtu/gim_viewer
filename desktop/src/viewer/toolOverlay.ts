import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import type { Section, ViewerCommands, Vec3 } from '../shared/viewerCommands.js';
import { sectionFaces } from './section/sectionController.js';

/** Screen-space annotations project the same saved engineering endpoints on every actual draw. */
export class ToolOverlay {
  private svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private handles = document.createElement('div');
  private drag?: AbortController;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly annotations = new Map<string, SVGElement>();
  constructor(
    private ctx: ViewerContext,
    private host: HTMLElement,
    private port: ViewerCommands,
    private anchor: () => THREE.Matrix4 | null,
  ) {
    this.svg.classList.add('tool-annotations');
    this.handles.className = 'tool-handles';
    host.append(this.svg, this.handles);
  }
  private project(p: Vec3, m: THREE.Matrix4) {
    const v = new THREE.Vector3().fromArray(p).applyMatrix4(m).project(this.ctx.world.camera.three);
    return {
      x: ((v.x + 1) * this.host.clientWidth) / 2,
      y: ((1 - v.y) * this.host.clientHeight) / 2,
      visible: v.z >= -1 && v.z <= 1,
    };
  }
  private svgItem(id: string, tag: string, attrs: Record<string, number>, label?: string) {
    let element = this.annotations.get(id);
    if (!element) {
      element = document.createElementNS('http://www.w3.org/2000/svg', tag);
      this.annotations.set(id, element);
      this.svg.append(element);
    }
    for (const [key, value] of Object.entries(attrs)) {
      const text = String(value);
      if (element.getAttribute(key) !== text) element.setAttribute(key, text);
    }
    if (label && element.textContent !== label) element.textContent = label;
  }
  draw = () => {
    const m = this.anchor();
    const s = this.port.snapshot;
    const drawn = new Set<string>();
    const annotate = (id: string, tag: string, attrs: Record<string, number>, label?: string) => {
      drawn.add(id);
      this.svgItem(id, tag, attrs, label);
    };
    for (const item of m ? s.distances : []) {
      if (!m) break;
      const a = this.project(item.a.xyz, m),
        b = this.project(item.b.xyz, m);
      if (!a.visible || !b.visible) continue;
      annotate(item.id + ':line', 'line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      annotate(item.id + ':a', 'circle', { cx: a.x, cy: a.y, r: 4 });
      annotate(item.id + ':b', 'circle', { cx: b.x, cy: b.y, r: 4 });
      annotate(
        item.id + ':label',
        'text',
        { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 8 },
        item.metres.toFixed(3) + ' m',
      );
    }
    if (s.first && m) {
      const p = this.project(s.first.xyz, m);
      if (p.visible) annotate('first', 'circle', { cx: p.x, cy: p.y, r: 5 });
    }
    for (const [id, element] of this.annotations)
      if (!drawn.has(id)) {
        element.remove();
        this.annotations.delete(id);
      }
    if (this.drag) return;
    const faces = m && s.tool === 'section' && s.section?.enabled ? sectionFaces(s.section) : [];
    for (const [id, button] of this.buttons) {
      if (!faces.some((face) => face.id === id)) {
        button.remove();
        this.buttons.delete(id);
      }
    }
    for (const { id, origin } of faces) {
      if (!m) break;
      let button = this.buttons.get(id);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'section-handle';
        button.textContent =
          id === 'offset'
            ? '↕'
            : ({ min0: '左', max0: '右', min1: '前', max1: '后', min2: '下', max2: '上' }[id] ??
              id);
        button.title = '拖动调整剖切位置';
        const handle = button;
        button.onpointerdown = (e) => {
          const active = this.port.snapshot.section,
            frame = this.anchor();
          if (!active?.enabled || !frame) return;
          const face = sectionFaces(active).find((entry) => entry.id === id);
          if (face) this.startDrag(e, handle, active, id, face.origin, face.axis, frame);
        };
        this.buttons.set(id, button);
        this.handles.append(button);
      }
      const p = this.project(origin.toArray(), m);
      button.hidden = !p.visible;
      button.style.left = p.x + 'px';
      button.style.top = p.y + 'px';
    }
  };
  private startDrag(
    e: PointerEvent,
    button: HTMLButtonElement,
    s: Section,
    id: string,
    origin: THREE.Vector3,
    axis: THREE.Vector3,
    m: THREE.Matrix4,
  ) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const size = Math.max(
      1,
      new THREE.Vector3(...s.max).distanceTo(new THREE.Vector3(...s.min)) * 0.1,
    );
    const a = this.project(origin.toArray(), m),
      b = this.project(origin.clone().addScaledVector(axis, size).toArray(), m);
    let dx = b.x - a.x,
      dy = b.y - a.y;
    if (Math.hypot(dx, dy) < 2) {
      dx = 0;
      dy = -32;
    }
    const controls = this.ctx.world.camera.controls;
    if (!controls) return;
    const enabled = controls.enabled;
    controls.enabled = false;
    const drag = new AbortController();
    this.drag = drag;
    button.setPointerCapture(e.pointerId);
    const finish = () => {
      drag.abort();
      controls.enabled = enabled;
      this.drag = undefined;
      this.draw();
    };
    drag.signal.addEventListener(
      'abort',
      () => {
        controls.enabled = enabled;
      },
      { once: true },
    );
    button.addEventListener(
      'pointermove',
      (ev) => {
        const delta =
          (size * ((ev.clientX - e.clientX) * dx + (ev.clientY - e.clientY) * dy)) /
          (dx * dx + dy * dy);
        const next: Section = { ...s, min: [...s.min], max: [...s.max] };
        if (id === 'offset') next.offset += delta;
        else {
          const i = Number(id.slice(-1));
          if (id.startsWith('min')) next.min[i] = Math.min(s.max[i], s.min[i] + delta);
          else next.max[i] = Math.max(s.min[i], s.max[i] + delta);
        }
        this.port.dispatch({ kind: 'section', value: next });
        button.style.left = a.x + (delta * dx) / size + 'px';
        button.style.top = a.y + (delta * dy) / size + 'px';
      },
      { signal: drag.signal },
    );
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'])
      button.addEventListener(event, finish, { signal: drag.signal });
  }
  clear() {
    this.drag?.abort();
    this.drag = undefined;
    this.svg.replaceChildren();
    this.annotations.clear();
    this.handles.replaceChildren();
    this.buttons.clear();
  }
  dispose() {
    this.clear();
    this.svg.remove();
    this.handles.remove();
  }
}
