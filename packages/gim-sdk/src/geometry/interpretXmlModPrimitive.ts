import type { RawPrimitiveSource } from "../parser/rawXmlMod.js";
import { xmlModNumber } from "../parser/xmlModValues.js";
import type {
  GeometryDiagnostic,
  GeometryInterpretationResult,
} from "./primitiveContracts.js";

export const xmlModInterpretationPolicy = "standard-xml-mod-v1";

export function interpretXmlModPrimitive(
  source: RawPrimitiveSource,
): GeometryInterpretationResult {
  const policyVersion = xmlModInterpretationPolicy;
  const diagnostics: GeometryDiagnostic[] = source.diagnostics.map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    stage: "parse",
    location: {
      path: issue.path,
      ordinal: issue.ordinal,
      entityId: issue.entityId,
      sourceTag: source.sourceTag,
      field: issue.field,
    },
  }));
  if (diagnostics.some((issue) => issue.code === "conflicting-field"))
    return { status: "ambiguous", policyVersion, diagnostics };
  function dimension(field: string): number {
    const number = xmlModNumber(source.rawAttributes[field]);
    if (!(number > 0 && Number.isFinite(number))) {
      diagnostics.push({
        stage: "interpret",
        code: "invalid-field-value",
        severity: "error",
        message: `${field} requires a positive finite decimal`,
        location: { sourceTag: source.sourceTag, field },
      });
    }
    return number;
  }
  let canonical;
  switch (source.sourceTag) {
    case "CUBOID":
    case "Cuboid":
      canonical = {
        kind: "Cuboid" as const,
        length: dimension("L"),
        width: dimension("W"),
        height: dimension("H"),
      };
      break;
    case "CYLINDER":
    case "Cylinder":
      canonical = {
        kind: "Cylinder" as const,
        radius: dimension("R"),
        height: dimension("H"),
      };
      break;
    default:
      diagnostics.push({
        code: "unsupported-primitive",
        severity: "warning",
        stage: "interpret",
        message: `Unsupported primitive: ${source.sourceTag}`,
        location: { sourceTag: source.sourceTag },
      });
      return { status: "unsupported", diagnostics, policyVersion };
  }
  return diagnostics.some((issue) => issue.severity === "error")
    ? { status: "invalid", diagnostics, policyVersion }
    : { status: "standard", canonical, diagnostics, policyVersion };
}
