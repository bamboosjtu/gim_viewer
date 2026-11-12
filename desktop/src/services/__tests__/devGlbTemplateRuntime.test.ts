import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { highlightModGroups, resetModHighlight } from '../../viewer/highlight.js';
import {
  DevGlbTemplate,
  DevGlbTemplatePool,
  attachDevGlbTemplatePool,
  disposeDevGlbTemplatePool,
  getDevGlbTemplatePool,
  runBudgetedPlacementWork,
  validateDevGlbTemplate,
} from '../devGlbTemplateRuntime.js';

function makeNestedTemplate(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'template-root';
  root.matrix.makeTranslation(0.25, -0.5, 0.75);
  root.matrixAutoUpdate = false;

  const parent = new THREE.Group();
  parent.matrix.makeRotationZ(0.31);
  parent.matrixAutoUpdate = false;
  root.add(parent);

  const nested = new THREE.Group();
  nested.matrix.makeScale(1.2, 0.7, 1.4);
  nested.matrixAutoUpdate = false;
  parent.add(nested);

  const material = new THREE.MeshStandardMaterial({ color: 0x778899 });
  const first = new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 0.25), material);
  first.position.set(0.4, 0.2, -0.1);
  first.rotation.y = 0.27;
  first.updateMatrix();
  first.matrixAutoUpdate = false;
  nested.add(first);

  const second = new THREE.Mesh(new THREE.TetrahedronGeometry(0.4), material);
  second.matrix.set(
    1, 0.2, 0, 0.1,
    0, 1, 0.15, -0.2,
    0, 0, 1, 0.3,
    0, 0, 0, 1,
  );
  second.matrixAutoUpdate = false;
  parent.add(second);
  root.updateMatrixWorld(true);
  return root;
}

it('rejects a template if its session expires during source verification',async()=>{
  let current=true;const scene=makeNestedTemplate();
  const pool=new DevGlbTemplatePool({parse:async()=>({scene,animations:[]}),isCurrent:()=>current,
    verifySourceEnvelope:async()=>{await Promise.resolve();current=false;}});
  expect(await pool.prepare('DEV/a.dev',new Uint8Array([1]))).toBeNull();
  expect(pool.metrics().templateShareableCount).toBe(0);
});

it('rejects a GLB with finite astronomical extent before creating any occurrence', async () => {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(7.57e11,1,1),new THREE.MeshStandardMaterial()));
  const pool = new DevGlbTemplatePool({session:new AppState().captureProjectSession(),isCurrent:()=>true,parse:async()=>({scene:group,animations:[]})});
  expect(await pool.prepare('DEV/bad.dev',new Uint8Array([1]))).toBeNull();
  pool.dispose();
});

function referencePlacement(root: THREE.Group, raw: number[], project: THREE.Matrix4): THREE.Group {
  const result = new THREE.Group(); result.matrixAutoUpdate = false;
  // Independent matrix oracle: transform metre-coordinate points by T_mm/1000,
  // preserving the source linear basis and template-local hierarchy order.
  const source = new THREE.Matrix4().fromArray(raw);
  source.setPosition(new THREE.Vector3(raw[12]/1000,raw[13]/1000,raw[14]/1000));
  result.matrix.copy(project.clone().multiply(source)); result.add(root.clone(true));
  result.updateMatrixWorld(true); return result;
}

function worldVertexSamples(root: THREE.Group): number[][] {
  const samples: number[][] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    const count = Math.min(4, position.count);
    for (let i = 0; i < count; i++) {
      const point = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      samples.push(point.toArray());
    }
  });
  return samples;
}

function expectMatrixClose(actual: THREE.Matrix4, expected: THREE.Matrix4, tolerance = 1e-7): void {
  actual.elements.forEach((value, index) => {
    expect(Math.abs(value - expected.elements[index]!)).toBeLessThanOrEqual(tolerance);
  });
}

describe('DevGlbTemplate immutable placement runtime', () => {
  it('places a nested source template once and shares it between distinct occurrences', () => {
    const scene = new THREE.Group(); scene.matrix.makeTranslation(1, 2, 3); scene.matrixAutoUpdate = false;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
    mesh.position.set(2, 0, 0); mesh.updateMatrix(); scene.add(mesh);
    const template = new DevGlbTemplate('DEV/shared.dev', scene);
    const project = new THREE.Matrix4().makeTranslation(5, -6, 7).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    const a = template.createPlacement({ rootOccurrence: 'A', placementMatrix: new THREE.Matrix4().makeTranslation(1000, 2000, 3000).toArray(), projectSourceToViewerMatrix: project });
    const b = template.createPlacement({ rootOccurrence: 'B', placementMatrix: new THREE.Matrix4().makeTranslation(4000, 2000, 3000).toArray(), projectSourceToViewerMatrix: project });
    const ca = new THREE.Box3().setFromObject(a, true).getCenter(new THREE.Vector3());
    const cb = new THREE.Box3().setFromObject(b, true).getCenter(new THREE.Vector3());
    expect(ca.distanceTo(new THREE.Vector3(9, 0, 3))).toBeLessThan(1e-7);
    expect(cb.distanceTo(new THREE.Vector3(12, 0, 3))).toBeLessThan(1e-7);
    expect(a.userData.rootOccurrence).toBe('A'); expect(b.userData.rootOccurrence).toBe('B');
    expect((a.children[0].children[0] as THREE.Mesh).geometry).toBe((b.children[0].children[0] as THREE.Mesh).geometry);
    template.dispose();
  });
  it('preserves source-before-template affine order in world vertices and bounds', () => {
    const project = new THREE.Matrix4().makeTranslation(4, -2, 1)
      .multiply(new THREE.Matrix4().makeRotationY(0.42));
    const cases = [
      new THREE.Matrix4(),
      new THREE.Matrix4().makeTranslation(1000, -250, 75),
      new THREE.Matrix4().makeRotationX(0.37),
      new THREE.Matrix4().makeScale(1.5, 0.75, 2.2),
      new THREE.Matrix4().makeTranslation(120, 300, -40).multiply(new THREE.Matrix4().makeRotationZ(0.5)),
      new THREE.Matrix4().makeTranslation(700, -100, 50)
        .multiply(new THREE.Matrix4().makeRotationY(-0.3))
        .multiply(new THREE.Matrix4().makeScale(0.8, 1.7, 1.1)),
      new THREE.Matrix4().set(
        1, 0.25, 0, 100,
        0.1, 1, 0.2, -50,
        0, 0, 1, 20,
        0, 0, 0, 1,
      ),
    ];

    for (const rawMatrix of cases) {
      const source = makeNestedTemplate();
      const template = new DevGlbTemplate('DEV/test.dev', source);
      const placementRaw = rawMatrix.toArray();
      const actual = template.createPlacement({
        placementMatrix: placementRaw,
        projectSourceToViewerMatrix: project,
      });
      const expected = referencePlacement(source, placementRaw, project);

      const actualSamples = worldVertexSamples(actual);
      const expectedSamples = worldVertexSamples(expected);
      expect(actualSamples).toHaveLength(expectedSamples.length);
      actualSamples.forEach((sample, index) => {
        sample.forEach((value, component) => {
          expect(Math.abs(value - expectedSamples[index]![component]!)).toBeLessThan(1e-6);
        });
      });
      const actualBox = new THREE.Box3().setFromObject(actual, true);
      const expectedBox = new THREE.Box3().setFromObject(expected, true);
      expect(actualBox.min.distanceTo(expectedBox.min)).toBeLessThan(1e-6);
      expect(actualBox.max.distanceTo(expectedBox.max)).toBeLessThan(1e-6);

      expectMatrixClose(actual.matrixWorld, expected.matrixWorld);
      const actualMeshes: THREE.Mesh[] = [], expectedMeshes: THREE.Mesh[] = [];
      actual.traverse(o => { if ((o as THREE.Mesh).isMesh) actualMeshes.push(o as THREE.Mesh); });
      expected.traverse(o => { if ((o as THREE.Mesh).isMesh) expectedMeshes.push(o as THREE.Mesh); });
      expect(actualMeshes).toHaveLength(expectedMeshes.length);
      actualMeshes.forEach((mesh, i) => expectMatrixClose(mesh.matrixWorld, expectedMeshes[i].matrixWorld));
      template.dispose();
    }
  });

  it('shares static geometry/material but isolates highlight state per placement', () => {
    const source = makeNestedTemplate();
    const template = new DevGlbTemplate('DEV/shared.dev', source);
    const a = template.createPlacement({ instanceKey: 'a' });
    const b = template.createPlacement({ instanceKey: 'b' });
    const aMesh = a.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const bMesh = b.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const baseMaterial = aMesh.material as THREE.Material;

    expect(aMesh.geometry).toBe(bMesh.geometry);
    expect(aMesh.material).toBe(bMesh.material);

    const state = new AppState();
    highlightModGroups(state, [a]);
    expect(aMesh.material).not.toBe(baseMaterial);
    expect(bMesh.material).toBe(baseMaterial);
    resetModHighlight(state);
    expect(aMesh.material).toBe(baseMaterial);
    expect(bMesh.material).toBe(baseMaterial);
    template.dispose();
  });

  it('rejects unsafe hierarchies and pool ownership is idempotent', async () => {
    const unsafeSource = makeNestedTemplate();
    const skinned = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    unsafeSource.add(skinned);
    expect(validateDevGlbTemplate({ scene: unsafeSource, animations: [] })).toMatchObject({
      shareable: false,
      reason: 'skinned-mesh',
    });
    const unsafePool = new DevGlbTemplatePool({
      parse: async () => ({ scene: unsafeSource, animations: [] }),
    });
    const unsafePreparation = await unsafePool.prepare('DEV/unsafe.dev', new Uint8Array([1]));
    expect(unsafePreparation).toMatchObject({ kind: 'exclusive', fallbackReason: 'skinned-mesh' });
    expect(unsafePool.metrics().templateFallbackCount).toBe(1);
    unsafePool.dispose();

    const source = makeNestedTemplate();
    const sourceMesh = source.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const geometry = sourceMesh.geometry as THREE.BufferGeometry;
    const material = sourceMesh.material as THREE.Material;
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    const pool = new DevGlbTemplatePool({
      parse: async () => ({ scene: source, animations: [] }),
    });
    const prepared = await pool.prepare('dev/a.dev', new Uint8Array([1]));
    expect(prepared?.kind).toBe('shared');
    pool.dispose();
    pool.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
  });

  it('yields placement work by slice and stops after a stale yield', async () => {
    let current = true;
    let yields = 0;
    const worked: number[] = [];
    const result = await runBudgetedPlacementWork(
      Array.from({ length: 10 }, (_, index) => index),
      (item) => { worked.push(item); },
      {
        maxSliceMs: 1000,
        maxPlacementsPerSlice: 2,
        yieldToMain: async () => {
          yields++;
          if (yields === 1) current = false;
        },
        isCurrent: () => current,
      },
    );
    expect(worked).toEqual([0, 1]);
    expect(result.yieldCount).toBe(1);
    expect(result.sliceCount).toBe(1);
    expect(result.placementCount).toBe(2);
  });

  it('stale A cleanup cannot dispose a replacement B template pool on the same root', () => {
    const root = new THREE.Group();
    const sessionA = { generation: 1, projectId: 1, sourceSha256: 'a', geometryToken: 1 };
    const sessionB = { generation: 2, projectId: 2, sourceSha256: 'b', geometryToken: 2 };
    const makePool = (session: typeof sessionA) => new DevGlbTemplatePool({
      session,
      parse: async () => ({ scene: makeNestedTemplate(), animations: [] }),
    });
    const poolA = makePool(sessionA);
    const poolB = makePool(sessionB);
    attachDevGlbTemplatePool(root, poolA);
    attachDevGlbTemplatePool(root, poolB);

    disposeDevGlbTemplatePool(root, sessionA);
    expect(getDevGlbTemplatePool(root, sessionB)).toBe(poolB);
    disposeDevGlbTemplatePool(root, sessionB);
    expect(getDevGlbTemplatePool(root, sessionB)).toBeNull();
  });
});
