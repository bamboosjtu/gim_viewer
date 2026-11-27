import type {
  RawXmlModDocument,
  RawXmlModEntity,
} from "../parser/rawXmlMod.js";

export type GeometryLod = 0 | 1 | 2;
export type CanonicalPrimitive =
  | { readonly kind: "Sphere"; readonly radius: number }
  | {
      readonly kind: "OffsetRectangularTable";
      readonly bottomLength: number;
      readonly bottomWidth: number;
      readonly topLength: number;
      readonly topWidth: number;
      readonly height: number;
      readonly offsetX: number;
      readonly offsetY: number;
    }
  | {
      readonly kind: "TruncatedCone";
      readonly bottomRadius: number;
      readonly topRadius: number;
      readonly height: number;
    }
  | {
      readonly kind: "EccentricTruncatedCone";
      readonly bottomRadius: number;
      readonly topRadius: number;
      readonly height: number;
      readonly offsetX: number;
      readonly offsetY: number;
    }
  | {
      readonly kind: "StretchedBody";
      readonly contour: readonly import("./analysisGeometry.js").Point3[];
      readonly normal: import("./analysisGeometry.js").Point3;
      readonly length: number;
      readonly displacement: import("./analysisGeometry.js").Point3;
    }
  | {
      readonly kind: "Cuboid";
      readonly length: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "Cylinder";
      readonly radius: number;
      readonly height: number;
    };

/** Local millimetres, XYZ positions and unit normals. An unindexed triangle uses three consecutive vertices. */
export interface MeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices?: Uint16Array | Uint32Array;
  readonly uvs?: Float32Array;
}

export interface GeometryLimits {
  maxVertices: number;
  maxContourPoints: number;
  maxHoles: number;
  maxCurveSegments: number;
}

export interface GeometryCompileOptions {
  readonly lod?: GeometryLod;
  readonly limits?: Partial<GeometryLimits>;
  /** An explicitly identified source dialect, scoped to this call. */
  readonly compatibility?: {
    rule: "cone-top-ratio-v1" | "stretch-displacement-v1";
    evidence: string;
  };
}

export interface GeometryDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly stage: "parse" | "interpret" | "analyze" | "compile" | "compose";
  readonly message: string;
  readonly location?: {
    path?: string;
    ordinal?: number;
    entityId?: number;
    sourceTag?: string;
    field?: string;
  };
  readonly limit?: {
    name: keyof GeometryLimits;
    requested: number;
    allowed: number;
  };
}

export type GeometryInterpretationResult = {
  readonly policyVersion: string;
  readonly diagnostics: readonly GeometryDiagnostic[];
} & (
  | {
      readonly status: "standard" | "compatible";
      readonly canonical: CanonicalPrimitive;
    }
  | {
      readonly status: "invalid" | "ambiguous" | "unsupported";
      readonly canonical?: never;
    }
);

export interface GeometryCompileResult {
  readonly status: "standard-derived" | "none";
  readonly mesh?: MeshData;
  readonly diagnostics: readonly GeometryDiagnostic[];
  readonly lod: GeometryLod;
  readonly compilerVersion: string;
}

export interface GeometryDocumentCompileResult {
  readonly source: RawXmlModDocument;
  readonly entities: readonly {
    readonly source: RawXmlModEntity;
    readonly interpretation: GeometryInterpretationResult;
    readonly templateKey?: string;
    readonly diagnostics: readonly GeometryDiagnostic[];
  }[];
  readonly templates: ReadonlyMap<string, GeometryCompileResult>;
}
