import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';

/** Project unit directions only; translations and camera zoom have no effect on the compass. */
export function orientationAxes(
  ctx: ViewerContext,
  host: HTMLElement,
  anchor: () => THREE.Matrix4 | null,
) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('orientation-axes');
  svg.setAttribute('viewBox', '0 0 84 84');
  svg.setAttribute('role', 'img');
  const axes = (
    [
      ['X', '#c23c40', new THREE.Vector3(1, 0, 0)],
      ['Y', '#218449', new THREE.Vector3(0, 1, 0)],
      ['Z', '#2365bd', new THREE.Vector3(0, 0, 1)],
    ] as const
  ).map(([label, color, axis]) => {
    const line = document.createElementNS(ns, 'line'),
      text = document.createElementNS(ns, 'text');
    line.setAttribute('x1', '42');
    line.setAttribute('y1', '42');
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '2.5');
    text.textContent = label;
    text.setAttribute('fill', color);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    svg.append(line, text);
    return { axis, line, text };
  });
  host.append(svg);
  const dir = new THREE.Vector3(),
    rotation = new THREE.Quaternion(),
    prior = new THREE.Quaternion(),
    previous = new THREE.Matrix4();
  let drawn = false,
    wasEngineering = false;
  function update() {
    const camera = ctx.world.camera.three,
      frame = anchor();
    camera.getWorldQuaternion(rotation).invert();
    if (
      drawn &&
      prior.equals(rotation) &&
      wasEngineering === !!frame &&
      (!frame || previous.equals(frame))
    )
      return;
    drawn = true;
    prior.copy(rotation);
    wasEngineering = !!frame;
    if (frame) previous.copy(frame);
    svg.setAttribute('aria-label', frame ? '工程 XYZ 坐标轴' : '场景 XYZ 坐标轴');
    for (const { axis, line, text } of axes) {
      dir.copy(axis);
      if (frame) dir.transformDirection(frame);
      dir.applyQuaternion(rotation);
      line.setAttribute('x2', String(42 + dir.x * 23));
      line.setAttribute('y2', String(42 - dir.y * 23));
      text.setAttribute('x', String(42 + dir.x * 34));
      text.setAttribute('y', String(42 - dir.y * 34));
    }
  }
  ctx.world.renderer?.onAfterUpdate?.add(update);
  update();
  return () => {
    ctx.world.renderer?.onAfterUpdate?.remove(update);
    svg.remove();
  };
}
