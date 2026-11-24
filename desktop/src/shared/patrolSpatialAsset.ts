/** Structured-clone payloads shared by the Worker, cache and spatial query. */
export interface PatrolPart {
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
  vertices: Float64Array;
  order: Uint32Array;
  nodes: PatrolBranch[];
}
