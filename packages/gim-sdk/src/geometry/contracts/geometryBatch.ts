import type { BoundsCoverage, GeometryPort } from "../analysisGeometry.js";
import type {
  GeometryCompileResult,
  GeometryDiagnostic,
  GeometryLod,
  MeshData,
} from "../primitiveContracts.js";
import type { StlFormat } from "../formats/stl.js";

export interface GeometryOccurrence {
  readonly rootOccurrence: string;
  readonly assemblyPath: string;
  readonly referencePath?: string;
  readonly localToParent: readonly number[];
}
export interface GeometrySourceAddress {
  readonly variantKey?: string;
  readonly componentKey?: string;
  readonly sourceVersion: string;
  readonly sourcePath: string;
  readonly format: "xml-mod" | "stl" | "ifc" | "line-mod";
  readonly modelId?: string;
  readonly expressId?: number;
  readonly globalId?: string;
  readonly geometryId?: number;
  readonly partIndex?: number;
  readonly rootOccurrence: string;
  readonly assemblyPath: string;
  readonly referencePath?: string;
  readonly entityId?: number;
  readonly ordinal?: number;
}
export type GeometryAvailability =
  "available" | "partial" | "empty" | "unavailable" | "unknown";
export type GeometryQuality =
  Exclude<GeometryCompileResult["status"], "none"> | "source-derived";
export interface MeshTemplate {
  readonly kind: "mesh";
  readonly mesh: MeshData;
  readonly quality: GeometryQuality;
}
export interface LineSegments3D {
  readonly kind: "line-segments";
  /** Source R record ordinal per segment within its section. */
  readonly recordOrdinals?: readonly number[];
  /** Consecutive pairs of XYZ endpoints in local millimetres. */
  readonly positions: Float32Array;
}
export type GeometryTemplate = MeshTemplate | LineSegments3D;
export interface PlacedPart {
  readonly instanceId: string;
  readonly address: GeometrySourceAddress;
  readonly templateKey: string;
  readonly localToParent: readonly number[];
  readonly quality: GeometryQuality;
  readonly lod?: GeometryLod;
  /** Backend linear RGBA, independent of the shared template. */
  readonly rgba?: readonly number[];
  /** Original MOD colour fields; display alpha conventions belong to the host. */
  readonly sourceColor?: Readonly<Record<string, string>>;
}
export type NamedGeometryPort = Omit<GeometryPort, "direction"> & {
  readonly address: GeometrySourceAddress;
  readonly direction?: GeometryPort["direction"];
  readonly recordOrdinal?: number;
  readonly referencePath?: string;
};
export interface GeometryObjectResult {
  /** Placement of local analysis bounds and ports, including for port-only records. */
  readonly analysisToParent?: readonly number[];
  readonly address: GeometrySourceAddress;
  readonly visible: boolean;
  readonly availability: GeometryAvailability;
  readonly parts: readonly PlacedPart[];
  readonly ports: readonly NamedGeometryPort[];
  /** Local object space (right-handed Z-up, mm), independent of the occurrence. */
  readonly range: BoundsCoverage;
  readonly diagnostics: readonly GeometryDiagnostic[];
}
export interface GeometryBatch {
  readonly requestedLod?: GeometryLod;
  readonly templates: ReadonlyMap<string, GeometryTemplate>;
  readonly objects: readonly GeometryObjectResult[];
  readonly diagnostics: readonly GeometryDiagnostic[];
}

export interface LocalGeometryObject {
  readonly componentKey?: string;
  readonly entityId?: number;
  readonly ordinal?: number;
  readonly visible: boolean;
  readonly availability: GeometryAvailability;
  readonly geometry?: Pick<
    PlacedPart,
    "templateKey" | "quality" | "lod" | "sourceColor"
  >;
  readonly localToSource: readonly number[];
  readonly ports: readonly Omit<NamedGeometryPort, "address">[];
  readonly range: BoundsCoverage;
  readonly diagnostics: readonly GeometryDiagnostic[];
}
export interface CompiledGeometrySource {
  readonly variantKey?: string;
  readonly requestedLod?: GeometryLod;
  readonly sourceVersion: string;
  readonly sourcePath: string;
  readonly format: GeometrySourceAddress["format"];
  readonly stlFormat?: StlFormat;
  readonly templates: ReadonlyMap<string, GeometryTemplate>;
  readonly objects: readonly LocalGeometryObject[];
  /** Source-wide diagnostics. Declaration-specific evidence is on its object. */
  readonly diagnostics: readonly GeometryDiagnostic[];
}
