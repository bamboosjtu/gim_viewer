import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { geometryBatchToGroup } from './geometryBatch.js';
import type { GeometryBatch } from '@gim/gim-sdk/geometry';

export function lineModelPreview(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0xf0f4f8);
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(42, 1, 0.001, 10000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas),
    solid = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }),
    lines = new THREE.LineBasicMaterial({ color: 0x245bad }),
    ports = new THREE.PointsMaterial({ color: 0x197357, size: 5, sizeAttenuation: false });
  let group: THREE.Group | undefined;
  const draw = () => renderer.render(scene, camera);
  const resize = () => {
    const w = Math.max(1, canvas.clientWidth),
      h = Math.max(1, canvas.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    draw();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  controls.addEventListener('change', draw);
  const clear = () => {
    if (!group) return;
    group.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>();
    group.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g) geometries.add(g);
    });
    for (const g of geometries) g.dispose();
  };
  return {
    show(batch: GeometryBatch) {
      clear();
      group = geometryBatchToGroup(batch, (p) =>
        batch.templates.get(p.templateKey)?.kind === 'mesh' ? solid : lines,
      );
      const points: number[] = [],
        point = new THREE.Vector3(),
        matrix = new THREE.Matrix4();
      for (const object of batch.objects) {
        if (!object.visible || !object.analysisToParent) continue;
        matrix.fromArray(object.analysisToParent);
        for (const port of object.ports)
          points.push(
            ...point.fromArray(port.position).applyMatrix4(matrix).multiplyScalar(0.001).toArray(),
          );
      }
      if (points.length)
        group.add(
          new THREE.Points(
            new THREE.BufferGeometry().setAttribute(
              'position',
              new THREE.Float32BufferAttribute(points, 3),
            ),
            ports,
          ),
        );
      scene.add(group);
      const box = new THREE.Box3().setFromObject(group),
        target = box.getCenter(new THREE.Vector3()),
        span = Math.max(0.01, box.getSize(new THREE.Vector3()).length());
      controls.target.copy(target);
      camera.position
        .copy(target)
        .addScaledVector(new THREE.Vector3(1, -1, 0.65).normalize(), span * 1.65);
      camera.near = span / 5000;
      camera.far = span * 100;
      camera.updateProjectionMatrix();
      controls.update();
      resize();
    },
    dispose() {
      observer.disconnect();
      controls.dispose();
      clear();
      solid.dispose();
      lines.dispose();
      ports.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
