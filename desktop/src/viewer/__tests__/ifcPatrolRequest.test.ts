import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { ViewerContext } from '../viewerEngine.js';
import { IfcRegionalRuntime } from '../ifcRegionalRuntime.js';

it('dispatches the navigation operation for a product that carries its own IFC type', async () => {
  const camera = new THREE.PerspectiveCamera();
  const runtime = new IfcRegionalRuntime(
    'm',
    'm.ifc',
    { objects: [], unitScale: 1, openingRelations: [] },
    {
      ctx: {
        world: { scene: { three: new THREE.Scene() }, camera: { three: camera } },
        fragments: { list: { onBeforeDelete: { add: vi.fn(), remove: vi.fn() } } },
      } as unknown as ViewerContext,
      model: {
        modelId: 'm',
        object: new THREE.Group(),
        setVisible: vi.fn(),
        getGuidsByLocalIds: vi.fn(),
        getItemsIdsWithGeometry: vi.fn(),
      },
      readBytes: async () => null,
      cacheKey: 'k',
      isCurrent: () => true,
      sourceToViewer: new THREE.Matrix4(),
    },
  );
  const transport = runtime as unknown as {
    open: () => Promise<void>;
    send: (value: unknown) => Promise<unknown>;
  };
  const send = vi.spyOn(transport, 'send').mockResolvedValue({ parts: [] });
  vi.spyOn(transport, 'open').mockResolvedValue();
  const product = { type: 'IFCSLAB', expressId: 17, globalId: 'floor', bounds: [0, 0, 0, 2, 2, 1] };
  try {
    await runtime.patrolSource('patrol-mesh', new AbortController().signal, product);
    expect(send).toHaveBeenCalledWith({ type: 'patrol-mesh', expressId: 17, globalId: 'floor' });
  } finally {
    runtime.release();
  }
});
