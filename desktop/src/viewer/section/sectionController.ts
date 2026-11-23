import * as THREE from 'three';
import type { Section } from '../../shared/viewerCommands.js';
import type { ViewerContext } from '../viewerEngine.js';
import { requestViewerRender } from '../demandRendering.js';

export interface SectionHandle {
  id: string;
  origin: THREE.Vector3;
  axis: THREE.Vector3;
}
export function sectionFaces(s: Section): SectionHandle[] {
  const center = new THREE.Vector3()
    .fromArray(s.min)
    .lerp(new THREE.Vector3().fromArray(s.max), 0.5);
  if (s.kind === 'box') {
    return (['min', 'max'] as const).flatMap((side) =>
      [0, 1, 2].map((i) => {
        const axis = new THREE.Vector3().setComponent(i, 1);
        return { id: side + i, origin: center.clone().setComponent(i, s[side][i]), axis };
      }),
    );
  }
  const angle = THREE.MathUtils.degToRad(s.azimuth);
  const axis =
    s.kind === 'horizontal'
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
  return [
    {
      id: 'offset',
      axis,
      origin: center.clone().addScaledVector(axis, s.offset - center.dot(axis)),
    },
  ];
}
export function sectionPlanes(section: Section, anchor: THREE.Matrix4) {
  if (!section.enabled) return [];
  return sectionFaces(section).map((face) => {
    const keepPositive = section.kind === 'box' ? face.id.startsWith('min') : section.flipped;
    return new THREE.Plane()
      .setFromNormalAndCoplanarPoint(
        face.axis.clone().multiplyScalar(keepPositive ? 1 : -1),
        face.origin,
      )
      .applyMatrix4(anchor);
  });
}
export function initialSection(kind: Section['kind'], bounds: THREE.Box3): Section {
  if (bounds.isEmpty()) throw Error('当前没有可用几何范围');
  const center = bounds.getCenter(new THREE.Vector3());
  return {
    kind,
    enabled: true,
    flipped: false,
    azimuth: 0,
    offset: kind === 'vertical' ? center.x : center.z,
    min: bounds.min.toArray(),
    max: bounds.max.toArray(),
  };
}
export class SectionController {
  private planes: THREE.Plane[] = [];
  constructor(private ctx: ViewerContext) {}
  accepts = (point: THREE.Vector3) => this.planes.every((p) => p.distanceToPoint(point) >= -1e-6);
  get active() {
    return this.planes.length > 0;
  }
  apply(section?: Section, anchor?: THREE.Matrix4) {
    const renderer = this.ctx.world.renderer;
    if (!renderer) return;
    const planes = section && anchor ? sectionPlanes(section, anchor) : [];
    if (planes.length === this.planes.length) {
      planes.forEach((p, i) => this.planes[i].copy(p));
      if (planes.length) {
        renderer.updateClippingPlanes();
        requestViewerRender(this.ctx);
      }
      return;
    }
    for (const prior of this.planes) renderer.setPlane(false, prior);
    this.planes = planes;
    for (const plane of planes) renderer.setPlane(true, plane);
    requestViewerRender(this.ctx);
  }
}
