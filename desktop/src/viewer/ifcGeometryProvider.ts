import type * as THREE from 'three';

export type IfcLOD = 0 | 1 | 2;
/** Representation ownership is separate from the existing IFC object identity. */
export interface IfcPreviewObject {
  key: string;
  modelId: string;
  sourcePath: string;
  expressId: number;
  globalId: string;
  ifcType: string;
  name: string;
  provider: 'ifc-preview';
}
export interface IfcPreviewShape {
  object: IfcPreviewObject;
  matrix: number[]; // source metres, column major; no benchmark calibration
  bounds: [number, number, number, number, number, number];
  profile?: number[][];
  extrusion?: number[];
  approximation: string;
}
export interface IfcPreviewData {
  shapes: IfcPreviewShape[];
  unitScale: number;
  origin: number[];
  diagnostics: { products: number; represented: number; unsupported: number; reasons: Record<string, number> };
}
export interface IfcPreviewProperties {
  attributes: Record<string, unknown>;
  propertySets: unknown[];
}
export interface IfcGeometryProvider {
  readonly modelId: string;
  readonly root: THREE.Group;
  readonly level: IfcLOD | null;
  readonly data: IfcPreviewData | null;
  canProvide(level: IfcLOD): boolean;
  loadLOD(level: IfcLOD): Promise<void>;
  /** GlobalId collisions remain a candidate set, never an arbitrary first match. */
  findByGlobalId(globalId: string): IfcPreviewObject[];
  objectLOD(object: IfcPreviewObject): IfcLOD;
  getProperties(expressId: number): Promise<IfcPreviewProperties>;
  pick(raycaster: THREE.Raycaster): { object: IfcPreviewObject; distance: number } | null;
  highlight(object: IfcPreviewObject): void;
  clearHighlight(): void;
  /** Remove preview only after the existing fine runtime is available. */
  retire(): void;
  release(): void;
}
