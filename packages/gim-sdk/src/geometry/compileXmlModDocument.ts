import type { RawXmlModDocument } from "../parser/rawXmlMod.js";
import { compilePrimitive, xmlModCompilerVersion } from "./compilePrimitive.js";
import {
  interpretXmlModPrimitive,
  xmlModInterpretationPolicy,
} from "./interpretXmlModPrimitive.js";
import type {
  CanonicalPrimitive,
  GeometryCompileOptions,
  GeometryCompileResult,
  GeometryDiagnostic,
  GeometryDocumentCompileResult,
  GeometryInterpretationResult,
} from "./primitiveContracts.js";

function shapeKey(p: CanonicalPrimitive, lod: number, policy: string): string {
  const dimensions =
    p.kind === "Cuboid" ? [p.length, p.width, p.height] : [p.radius, p.height];
  return [xmlModCompilerVersion, policy, p.kind, ...dimensions, lod].join("/");
}

/** One result per declaration; only successfully compiled local shapes become templates. */
export function compileXmlModDocument(
  source: RawXmlModDocument,
  options: GeometryCompileOptions = {},
): GeometryDocumentCompileResult {
  const templates = new Map<string, GeometryCompileResult>();
  const failed = new Map<string, GeometryCompileResult>();
  const parseIssues = new Map<number, GeometryDiagnostic[]>();
  for (const issue of source.diagnostics) {
    if (issue.ordinal === undefined) continue;
    const issues = parseIssues.get(issue.ordinal) ?? [];
    issues.push({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      stage: "parse",
      location: {
        path: source.sourcePath,
        ordinal: issue.ordinal,
        entityId: issue.entityId,
        sourceTag: issue.sourceTag,
        field: issue.field,
      },
    });
    parseIssues.set(issue.ordinal, issues);
  }
  const entities = source.entities.map((entity) => {
    const diagnostics = parseIssues.get(entity.ordinal) ?? [];
    const location = {
      path: source.sourcePath,
      ordinal: entity.ordinal,
      entityId: entity.id,
      sourceTag: entity.primitive?.sourceTag,
    };
    const locate = (issue: GeometryDiagnostic): GeometryDiagnostic => ({
      ...issue,
      location: { ...location, ...issue.location },
    });
    const interpretation: GeometryInterpretationResult = entity.primitive
      ? interpretXmlModPrimitive(entity.primitive)
      : {
          status: "invalid",
          diagnostics: [],
          policyVersion: xmlModInterpretationPolicy,
        };
    for (const issue of interpretation.diagnostics) {
      if (issue.stage !== "parse") diagnostics.push(locate(issue));
    }
    const binding = { source: entity, interpretation, diagnostics };
    if (
      interpretation.status !== "standard" ||
      entity.id === undefined ||
      source.entitiesById.get(entity.id) !== entity
    )
      return binding;
    const key = shapeKey(
      interpretation.canonical,
      options.lod ?? 2,
      interpretation.policyVersion,
    );
    let template = templates.get(key) ?? failed.get(key);
    if (!template) {
      template = compilePrimitive(interpretation.canonical, options);
      if (template.mesh) templates.set(key, template);
      else failed.set(key, template);
    }
    if (!template.mesh) {
      diagnostics.push(...template.diagnostics.map(locate));
      return binding;
    }
    return { ...binding, templateKey: key };
  });
  return { source, entities, templates };
}
