import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { highlightModGroups, resetModHighlight } from '../../viewer/highlight.js';
import {
  DevGlbTemplate,
  DevGlbTemplatePool,
  attachDevGlbTemplatePool,
  createLegacyEquivalentPlacementMatrix,
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

function cloneLegacy(root: THREE.Group, placementRaw: number[], project: THREE.Matrix4 | null): THREE.Group {
  const clone = root.clone(true) as THREE.Group;
  clone.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry = mesh.geometry.clone();
    mesh.geometry.applyMatrix4(createLegacyEquivalentPlacementMatrix(placementRaw));
  });
  if (project) clone.applyMatrix4(project);
  clone.updateMatrixWorld(true);
  return clone;
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
  it('matches legacy world-space vertices and bbox for affine transform cases', () => {
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
      const legacy = cloneLegacy(source, placementRaw, project);

      const actualSamples = worldVertexSamples(actual);
      const legacySamples = worldVertexSamples(legacy);
      expect(actualSamples).toHaveLength(legacySamples.length);
      actualSamples.forEach((sample, index) => {
        sample.forEach((value, component) => {
          expect(Math.abs(value - legacySamples[index]![component]!)).toBeLessThan(1e-6);
        });
      });
      const actualBox = new THREE.Box3().setFromObject(actual, true);
      const legacyBox = new THREE.Box3().setFromObject(legacy, true);
      expect(actualBox.min.distanceTo(legacyBox.min)).toBeLessThan(1e-6);
      expect(actualBox.max.distanceTo(legacyBox.max)).toBeLessThan(1e-6);

      // Root matrix is represented identically; each mesh matrix carries the
      // additional post-multiplied CBM affine that legacy baked into vertices.
      expectMatrixClose(actual.matrixWorld, legacy.matrixWorld);
      const actualMeshes: THREE.Mesh[] = [];
      const legacyMeshes: THREE.Mesh[] = [];
      actual.traverse((object) => { if ((object as THREE.Mesh).isMesh) actualMeshes.push(object as THREE.Mesh); });
      legacy.traverse((object) => { if ((object as THREE.Mesh).isMesh) legacyMeshes.push(object as THREE.Mesh); });
      expect(actualMeshes).toHaveLength(legacyMeshes.length);
      const cbm = createLegacyEquivalentPlacementMatrix(placementRaw);
      actualMeshes.forEach((mesh, index) => {
        const expectedWorld = legacyMeshes[index]!.matrixWorld.clone().multiply(cbm);
        expectMatrixClose(mesh.matrixWorld, expectedWorld);
      });
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
    expect(unsafePreparation).toMatchObject({ kind: 'legacy', fallbackReason: 'skinned-mesh' });
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
