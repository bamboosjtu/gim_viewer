/** Only source adapters with a confirmed, deterministic lack of collision geometry use this error. */
export class UnsupportedPatrolSourceError extends Error {}

/** Structured-clone payload shared by the Worker, cache and spatial query. */
export interface PatrolPart {
  previewShapes?: readonly string[];
  positions: Float32Array;
  indices: Uint32Array;
  matrix: number[];
}
export type PatrolBounds = [number, number, number, number, number, number];
export interface PatrolBranch {
  bounds: PatrolBounds;
  start: number;
  end: number;
  left?: number;
  right?: number;
}
export interface PatrolAsset {
  previewShapes?: readonly string[];
  vertices: Float64Array;
  order: Uint32Array;
  nodes: PatrolBranch[];
}
