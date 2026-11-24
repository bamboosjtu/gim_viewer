import { buildPatrolAsset } from './patrolGeometry.js';
import type { PatrolPart } from '../navigationQueryPort.js';
self.onmessage = ({ data }: MessageEvent<{ id: number; parts: PatrolPart[] }>) => {
  try {
    const asset = buildPatrolAsset(data.parts);
    self.postMessage(
      { id: data.id, asset },
      { transfer: [asset.vertices.buffer, asset.order.buffer] },
    );
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
