// @vitest-environment node
import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  BooleanGraph,
  DetailedBooleanEvaluation,
  identityPlacement,
  booleanFailure,
  type MeshData,
  type BooleanNode,
  type BooleanOperation,
  type BooleanResult,
} from '@gim/gim-sdk/geometry';
import { createMeshBooleanBackend, readBooleanMesh } from '../meshBooleanBackend.js';
const translate = (x: number) => [...identityPlacement.slice(0, 12), x, 0, 0, 1];
function box(length: number) {
  const g = new THREE.BoxGeometry(length, 10, 10).translate(length / 2, 5, 5);
  return readBooleanMesh(g);
}
function volume(m: MeshData) {
  let sum = 0;
  const p = m.positions;
  const v = (i: number) => new THREE.Vector3().fromArray(p, (m.indices?.[i] ?? i) * 3);
  for (let j = 0; j < (m.indices?.length ?? p.length / 3); j += 3)
    sum += v(j).dot(v(j + 1).cross(v(j + 2))) / 6;
  return sum;
}
it('evaluates ordered volumes with the real backend, reuses shared results, and distinguishes empty, failed and absent operands', async () => {
  const a = box(20),
    b = box(10),
    indices = a.indices!.slice(),
    untouched = a.positions.slice();
  const node = (op: BooleanOperation, entity1: number, entity2: number): BooleanNode => ({
    localToParent: identityPlacement,
    operation: { op, entity1, entity2 },
  });
  const nodes = new Map<number, BooleanNode>([
    [1, { localToParent: identityPlacement }],
    [2, { localToParent: translate(15) }],
    [3, node('Union', 1, 2)],
    [4, node('Intersection', 1, 2)],
    [5, node('Difference', 1, 2)],
    [6, node('Difference', 2, 1)],
    [7, { localToParent: translate(35) }],
    [8, node('Intersection', 1, 7)],
    [9, node('Union', 8, 1)],
    [10, node('Difference', 1, 8)],
    [11, node('Intersection', 1, 99)],
    [12, { localToParent: [-1, ...translate(25).slice(1)] }],
    [13, node('Difference', 1, 12)],
  ]);
  const g = new BooleanGraph((id) => nodes.get(id));
  const host = createMeshBooleanBackend(),
    run = vi.spyOn(host, 'evaluate');
  const leaf = (id: number): BooleanResult => ({
    status: 'success',
    mesh: id === 1 ? a : b,
    diagnostics: [],
  });
  const ev = new DetailedBooleanEvaluation(g, leaf, host, 'source-version', 'L2');
  for (const [id, want] of [
    [3, 2500],
    [4, 500],
    [5, 1500],
    [6, 500],
    [9, 2000],
    [10, 2000],
    [13, 1500],
  ]) {
    const r = await ev.evaluate(id);
    expect(r.status).toBe('success');
    if (r.status === 'success') expect(volume(r.mesh)).toBeCloseTo(want, 3);
  }
  expect((await ev.evaluate(8)).status).toBe('empty');
  expect(run).toHaveBeenCalledTimes(6);
  expect((await ev.evaluate(3)).status).toBe('success');
  expect(run).toHaveBeenCalledTimes(6);
  expect(await ev.evaluate(11)).toMatchObject({
    status: 'failed',
    diagnostics: [
      { code: 'operand-unavailable' },
      { code: 'missing-reference', location: { entityId: 99 } },
    ],
  });
  expect(
    (await new DetailedBooleanEvaluation(g, leaf, undefined, 'source-version', 'L2').evaluate(3))
      .status,
  ).toBe('failed');
  expect(ev.key(5)).not.toEqual(ev.key(6));
  expect(a.positions).toEqual(untouched);
  expect(a.indices).toEqual(indices);
  const flaky = {
    ...host,
    evaluate: vi
      .fn()
      .mockRejectedValueOnce(Error('temporary'))
      .mockResolvedValue({ status: 'empty', diagnostics: [] }),
  };
  const retry = new DetailedBooleanEvaluation(g, leaf, flaky, 'source-version', 'L2');
  expect((await retry.evaluate(3)).status).toBe('failed');
  expect((await retry.evaluate(3)).status).toBe('empty');
  expect(flaky.evaluate).toHaveBeenCalledTimes(2);
  expect(booleanFailure(3, 'x').diagnostics[0].location?.entityId).toBe(3);
});
