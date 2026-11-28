import { Box3, Vector3, Matrix4 } from 'three';
import type { PatrolSource } from '../../../viewer/patrol/navigationQueryPort.js';
import type { NavigationProduct } from '../../../viewer/patrol/ifcNavigationSource.js';
import type { IfcRegionalRuntime } from '../../../viewer/ifcRegionalRuntime.js';
import { UnsupportedPatrolSourceError } from '../../../shared/patrolSpatialAsset.js';
const groundType = /^IFC(SLAB|STAIR(FLIGHT)?|RAMP(FLIGHT)?|ROAD|PAVEMENT|SITE|GEOGRAPHICELEMENT)$/;
const groundLabel =
  /楼板|踏步|楼梯|台阶|坡道|路面|道路|广场|站区地面|室外地面|场坪|地坪|平台|\b(stair|floor|road|pavement|landing|ramp)\b/i;

export function appendPatrolProduct(
  sources: PatrolSource[],
  runtime: Pick<IfcRegionalRuntime, 'patrolSource'>,
  path: string,
  id: string,
  product: NavigationProduct,
  bounds: Box3,
  toEngineering: Matrix4,
) {
  const add = (sourceId: string, box: Box3, door: typeof product.door, indices?: number[]) =>
    sources.push({
      id: sourceId,
      assetKey: 'ifc:' + sourceId,
      residentModel: path,
      bounds: box,
      matrix: toEngineering,
      // The descriptor comes from IFC placements in Z-up engineering metres.
      // Only web-ifc triangulations and their bounds arrive in Y-up mesh space.
      door: door && { ...door, sourceId },
      approximate: door?.evidence.includes('preview-swing'),
      doorAddress: door ? { path, expressId: product.expressId, parts: indices } : undefined,
      support:
        !door &&
        (groundType.test(product.type) ||
          (product.type === 'IFCBUILDINGELEMENTPROXY' &&
            groundLabel.test(product.label) &&
            !/栏杆|扶手|墙/.test(product.label))),
      load: async (signal) => {
        const result = await mesh(signal);
        const parts = result.parts.filter((_p, i) =>
          indices ? indices.includes(i) : !used.has(i),
        );
        if (!parts.some((p) => p.indices.length))
          throw new UnsupportedPatrolSourceError(sourceId + ': IFC source has no triangles');
        return parts.map((p) => {
          const positions = new Float32Array(p.vertices.length / 2);
          for (let i = 0; i < positions.length; i += 3)
            positions.set(p.vertices.subarray(i * 2, i * 2 + 3), i);
          return { positions, indices: p.indices, matrix: p.matrix };
        });
      },
    });
  const leaves = product.leaves ?? [];
  const used = new Set(leaves.flatMap((l) => l.parts));
  // Share one in-flight original-product read across its frame and leaves.
  const fetchMesh = (signal: AbortSignal) => runtime.patrolSource('patrol-mesh', signal, product);
  let pending: ReturnType<typeof fetchMesh> | undefined,
    remaining = leaves.length + Number(!product.allPartsMovable);
  const mesh = async (signal: AbortSignal) => {
    try {
      return await (pending ??= fetchMesh(signal));
    } finally {
      if (--remaining <= 0) pending = undefined;
    }
  };
  if (!product.allPartsMovable) add(id, bounds, product.door);
  for (const l of leaves) {
    const leafBox = new Box3(
      new Vector3().fromArray(l.bounds),
      new Vector3().fromArray(l.bounds, 3),
    );
    add(id + '/leaf/' + l.parts[0], leafBox, l.motion, l.parts);
  }
}
