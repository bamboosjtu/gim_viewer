import type { RawPrimitiveSource } from "../parser/rawXmlMod.js";
import { xmlModNumber } from "../parser/xmlModValues.js";
import type { Point3 } from "./analysisGeometry.js";
import {
  DEFAULT_GEOMETRY_LIMITS,
  checkGeometryBudget,
} from "./geometryBudget.js";
import type {
  CanonicalPrimitive,
  GeometryCompileOptions,
  GeometryDiagnostic,
  GeometryInterpretationResult,
} from "./primitiveContracts.js";

export const xmlModInterpretationPolicy = "standard-xml-mod-v1";

export function interpretXmlModPrimitive(
  source: RawPrimitiveSource,
  options: GeometryCompileOptions = {},
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
  const attrs = source.rawAttributes;
  function signed(field: string): number {
    const n = xmlModNumber(attrs[field]);
    if (!Number.isFinite(n))
      diagnostics.push({
        stage: "interpret",
        code: "invalid-field-value",
        severity: "error",
        message: `${field} requires a finite decimal`,
        location: { field, sourceTag: source.sourceTag },
      });
    return n;
  }
  const dialect = options.compatibility;
  if (dialect && !dialect.evidence.trim())
    throw new TypeError(
      "A compatibility rule needs identified source evidence",
    );
  let rule: typeof dialect;
  let canonical: CanonicalPrimitive;
  function count(field: string): number {
    const n = signed(field);
    if (!Number.isSafeInteger(n) || n < 0)
      diagnostics.push({
        stage: "interpret",
        severity: "error",
        code: "invalid-field-value",
        message: `${field} requires a non-negative integer`,
        location: { sourceTag: source.sourceTag, field },
      });
    return n;
  }
  switch (source.sourceTag) {
    case "TERMINALBLOCK":
    case "TerminalBlock":
    case "RECTANGULARFIXEDPLATE":
    case "RectangularFixedPlate":
    case "CIRCULARFIXEDPLATE":
    case "CircularFixedPlate": {
      const size = {
        length: dimension("L"),
        width: dimension("W"),
        thickness: dimension("T"),
      };
      const tag = source.sourceTag.toUpperCase();
      const mh = tag === "TERMINALBLOCK" ? 0 : count("MH");
      if (mh > 1)
        diagnostics.push({
          stage: "interpret",
          severity: "error",
          code: "invalid-field-value",
          message: "MH requires 0 or 1",
          location: { field: "MH" },
        });
      if (tag === "CIRCULARFIXEDPLATE")
        canonical = {
          kind: "CircularFixedPlate",
          ...size,
          count: count("N"),
          diameter: dimension("D"),
          pitchRadius: dimension("CS"),
          middle: mh === 1,
        };
      else {
        const grid = {
          rows: count("RN"),
          columns: count("CN"),
          rowSpacing: dimension("RS"),
          columnSpacing: dimension("CS"),
        };
        canonical =
          tag === "TERMINALBLOCK"
            ? {
                kind: "TerminalBlock",
                ...size,
                ...grid,
                holeRadius: dimension("R"),
                bevel: dimension("CL"),
                bottomMargin: dimension("BL"),
              }
            : {
                kind: "RectangularFixedPlate",
                ...size,
                ...grid,
                diameter: dimension("D"),
                middle: mh === 1,
              };
      }
      break;
    }
    case "SPHERE":
    case "Sphere":
      canonical = { kind: "Sphere", radius: dimension("R") };
      break;
    case "OFFSETRECTANGULARTABLE":
    case "OffsetRectangularTable":
      canonical = {
        kind: "OffsetRectangularTable",
        bottomLength: dimension("LL"),
        bottomWidth: dimension("LW"),
        topLength: dimension("TL"),
        topWidth: dimension("TW"),
        height: dimension("H"),
        offsetX: signed("XOFF"),
        offsetY: signed("YOFF"),
      };
      break;
    case "TRUNCATEDCONE":
    case "TruncatedCone":
    case "ECCENTRICTRUNCATEDCONE":
    case "EccentricTruncatedCone": {
      const bottomRadius = dimension("BR"),
        tr = dimension("TR"),
        height = dimension("H");
      const eccentric =
        source.sourceTag.toLowerCase() === "eccentrictruncatedcone";
      if (!eccentric && dialect?.rule === "cone-top-ratio-v1") rule = dialect;
      const topRadius = rule ? tr * bottomRadius : tr;
      if (!Number.isFinite(topRadius) && Number.isFinite(tr))
        diagnostics.push({
          stage: "interpret",
          severity: "error",
          code: "invalid-field-value",
          message: "Top radius exceeds numeric range",
          location: { field: "TR" },
        });
      canonical = eccentric
        ? {
            kind: "EccentricTruncatedCone",
            bottomRadius,
            topRadius,
            height,
            offsetX: signed("TOPXOFF"),
            offsetY: signed("TOPYOFF"),
          }
        : { kind: "TruncatedCone", bottomRadius, topRadius, height };
      break;
    }
    case "STRETCHEDBODY":
    case "StretchedBody": {
      const triple = (s: string): Point3 | undefined => {
        const v = s.split(",").map(xmlModNumber);
        return v.length === 3 && v.every(Number.isFinite)
          ? [v[0], v[1], v[2]]
          : undefined;
      };
      const normal = triple(attrs.Normal ?? ""),
        length = dimension("L");
      const contour: Point3[] = [];
      const data = (attrs.Array ?? "").trim();
      let inputPoints = 0;
      for (let start = 0; start < data.length;) {
        const end = data.indexOf(";", start);
        const point = triple(data.slice(start, end < 0 ? data.length : end));
        if (!point) {
          diagnostics.push({
            stage: "interpret",
            code: "invalid-field-value",
            severity: "error",
            message: "Expected three finite coordinates per point",
            location: { field: "Array" },
          });
          break;
        }
        if (
          ++inputPoints >
          (options.limits?.maxContourPoints ??
            DEFAULT_GEOMETRY_LIMITS.maxContourPoints)
        ) {
          const limit = checkGeometryBudget(
            { maxContourPoints: inputPoints },
            options.limits,
          )!;
          return {
            status: "unsupported",
            diagnostics: [
              { ...limit, stage: "interpret", location: { field: "Array" } },
            ],
            policyVersion,
          };
        }
        const previous = contour[contour.length - 1];
        if (!previous || point.some((v, i) => v !== previous[i]))
          contour.push(point);
        if (end < 0) break;
        start = end + 1;
      }
      const last = contour[contour.length - 1];
      if (contour.length > 1 && last.every((v, i) => v === contour[0][i]))
        contour.pop();
      const magnitude = normal ? Math.hypot(...normal) : 0;
      if (
        !normal ||
        !magnitude ||
        !Number.isFinite(magnitude) ||
        contour.length < 3
      ) {
        diagnostics.push({
          stage: "interpret",
          code: "invalid-field-value",
          severity: "error",
          message:
            "Extrusion requires a nonzero direction and at least three contour points",
          location: { field: !magnitude ? "Normal" : "Array" },
        });
        return { status: "invalid", diagnostics, policyVersion };
      }
      if (dialect?.rule === "stretch-displacement-v1") rule = dialect;
      const displacement: Point3 = rule
        ? [...normal]
        : [
            (normal[0] / magnitude) * length,
            (normal[1] / magnitude) * length,
            (normal[2] / magnitude) * length,
          ];
      canonical = {
        kind: "StretchedBody",
        contour,
        normal,
        length,
        displacement,
      };
      break;
    }
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
    : {
        status: rule ? "compatible" : "standard",
        canonical,
        diagnostics: rule
          ? [
              ...diagnostics,
              {
                stage: "interpret",
                severity: "info",
                code: "confirmed-compatibility",
                message: `${rule.rule}: ${rule.evidence}`,
              },
            ]
          : diagnostics,
        policyVersion: rule ? rule.rule : policyVersion,
      };
}
