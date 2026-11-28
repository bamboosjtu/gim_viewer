import type {
  RawXmlModDocument,
  XmlModDiagnostic,
} from "../parser/rawXmlMod.js";
import {
  analyzePrimitive,
  queryXmlModBounds,
  type AnalysisGeometry,
  type BoundsCoverage,
  type BoundsPurpose,
} from "./analysisGeometry.js";
import { compileXmlModDocument } from "./compileXmlModDocument.js";
import {
  compileStl,
  queryStlBounds,
  type StlFormat,
  type StlCompileResult,
} from "./formats/stl.js";
import type {
  GeometryCompileOptions,
  GeometryCompileResult,
  GeometryDiagnostic,
} from "./primitiveContracts.js";
import type {
  CompiledGeometrySource,
  LocalGeometryObject,
  MeshTemplate,
} from "./contracts/geometryBatch.js";

export type GeometryInput =
  | {
      readonly format: "xml-mod";
      readonly sourceVersion: string;
      readonly document: RawXmlModDocument;
    }
  | {
      readonly format: "stl";
      readonly sourceVersion: string;
      readonly sourcePath: string;
      readonly bytes: ArrayBuffer | Uint8Array;
      readonly stlFormat?: StlFormat;
    };

const identity = Object.freeze([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);
const empty: BoundsCoverage = { coverage: "empty" };
const unknown: BoundsCoverage = { coverage: "unknown" };

/** Shared by the document and demand-driven single-leaf paths. No buffer copy. */
export function modMeshTemplate(
  result: GeometryCompileResult,
): MeshTemplate | undefined {
  if (!result.mesh || result.status === "none") return undefined;
  return { kind: "mesh", mesh: result.mesh, quality: result.status };
}

function stlDiagnostics(
  result: StlCompileResult,
  path: string,
): GeometryDiagnostic[] {
  return result.diagnostics.map((issue) => ({
    ...issue,
    location: { ...issue.location, path },
  }));
}

function stlRange(
  result: StlCompileResult,
  sourcePath: string,
): BoundsCoverage {
  if (result.bounds) return { coverage: "conservative", bounds: result.bounds };
  if (result.status === "empty") return empty;
  return {
    coverage: "unknown",
    diagnostics: stlDiagnostics(result, sourcePath),
  };
}

function parseIssue(issue: XmlModDiagnostic): GeometryDiagnostic {
  const { path, ordinal, entityId, sourceTag, field } = issue;
  return {
    stage: "parse",
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    location: { path, ordinal, entityId, sourceTag, field },
  };
}

/** Compile source-local contents once. Place the result for each occurrence without reinterpreting the source. */
export function compileGeometrySource(
  input: GeometryInput,
  options: GeometryCompileOptions = {},
): CompiledGeometrySource {
  return input.format === "stl"
    ? compileStlSource(input, options)
    : compileModSource(input, options);
}

function compileStlSource(
  input: Extract<GeometryInput, { format: "stl" }>,
  options: GeometryCompileOptions,
): CompiledGeometrySource {
  const templates = new Map<string, MeshTemplate>();
  const { sourceVersion, format } = input;
  const sourcePath = input.sourcePath;
  const result = compileStl(input.bytes, {
    format: input.stlFormat,
    includeBounds: true,
  });
  const templateKey = JSON.stringify(["stl", sourceVersion, sourcePath]);
  const quality = "source-derived";
  if (result.status === "ok" && result.mesh)
    templates.set(templateKey, { kind: "mesh", mesh: result.mesh, quality });
  const diagnostics = stlDiagnostics(result, sourcePath);
  const object: LocalGeometryObject = {
    visible: true,
    localToSource: identity,
    range: stlRange(result, sourcePath),
    ports: [],
    diagnostics,
    availability:
      result.status === "ok"
        ? "available"
        : result.status === "empty"
          ? "empty"
          : "unavailable",
    ...(templates.has(templateKey)
      ? { geometry: { templateKey, quality } }
      : {}),
  };
  return {
    sourceVersion,
    sourcePath,
    format,
    requestedLod: options.lod,
    stlFormat: result.format,
    templates,
    objects: [object],
    diagnostics: [],
  };
}

function compileModSource(
  input: Extract<GeometryInput, { format: "xml-mod" }>,
  options: GeometryCompileOptions,
): CompiledGeometrySource {
  const templates = new Map<string, MeshTemplate>();
  const { sourceVersion, format } = input;
  const doc = input.document;
  const compiled = compileXmlModDocument(doc, options);
  for (const [key, result] of compiled.templates) {
    const template = modMeshTemplate(result);
    if (template) templates.set(key, template);
  }
  const analyses = new Map<string, AnalysisGeometry>();
  const diagnostics = doc.diagnostics
    .filter((d) => d.ordinal === undefined)
    .map(parseIssue);
  const objects = compiled.entities.map((row): LocalGeometryObject => {
    const { source, templateKey, interpretation } = row;
    const issues = row.diagnostics;
    const primitive = interpretation.canonical;
    const result =
      templateKey === undefined
        ? undefined
        : compiled.templates.get(templateKey);
    let analysis =
      templateKey === undefined ? undefined : analyses.get(templateKey);
    if (primitive && !analysis) {
      analysis = analyzePrimitive(primitive);
      if (templateKey !== undefined) analyses.set(templateKey, analysis);
    }
    const local = {
      ordinal: source.ordinal,
      entityId: source.id,
      visible: source.visible,
      localToSource: source.transformMatrix,
      range: analysis?.range ?? unknown,
      ports: analysis?.ports ?? [],
    };
    if (
      templateKey === undefined ||
      !result ||
      !result.mesh ||
      result.status === "none"
    )
      return { ...local, availability: "unavailable", diagnostics: issues };
    const location = {
      path: doc.sourcePath,
      ordinal: source.ordinal,
      entityId: source.id,
      sourceTag: source.primitive?.sourceTag,
    };
    return {
      ...local,
      geometry: {
        templateKey,
        quality: result.status,
        lod: result.lod,
        sourceColor: source.color,
      },
      availability: issues.some(
        (d) => d.stage === "parse" && d.severity !== "info",
      )
        ? "partial"
        : "available",
      diagnostics: [
        ...issues,
        ...result.diagnostics.map((issue) => ({
          ...issue,
          location: { ...location, ...issue.location },
        })),
      ],
    };
  });
  if (!objects.length)
    objects.push({
      visible: true,
      localToSource: identity,
      ports: [],
      availability: doc.status === "empty" ? "empty" : "unavailable",
      range: doc.status === "empty" ? empty : unknown,
      diagnostics,
    });
  return {
    sourceVersion,
    sourcePath: doc.sourcePath,
    format,
    requestedLod: options.lod,
    templates,
    objects,
    diagnostics,
  };
}

/** Source-local bounds only. MOD includes the visible roots' declaration transforms. */
export function queryGeometryRange(
  input: GeometryInput,
  options: { purpose: BoundsPurpose } & GeometryCompileOptions,
): BoundsCoverage {
  if (input.format === "xml-mod")
    return queryXmlModBounds(input.document, options);
  return stlRange(
    queryStlBounds(input.bytes, input.stlFormat),
    input.sourcePath,
  );
}
