/**
 * PHM (Physical Model / Assembly) parser.
 *
 * PHM is KEY=VALUE text. SOLIDSn and SOLIDMODELn each pair with
 * TRANSFORMMATRIXn / COLORn by index. A missing or invalid matrix falls back to
 * identity; nested PHM traversal belongs to the caller.
 */
import type {
  PhmDocument,
  PhmSolidModelEntry,
  XmlModColor,
} from "@gim/powerline-core/geometry/ir.js";
import { parseBoundedCount } from "@gim/powerline-core/parserLimits.js";
import {
  parseSourceDocument,
  sourceConflicts,
  sourceDiagnostic,
  sourceScalar,
} from "@gim/powerline-core/sourceDocument.js";
import { isUsableAffineMatrix } from "./affineMatrix.js";
import { isGimEmptyValue } from "./values.js";

const IDENTITY_MATRIX: number[] = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

export function parsePhm(text: string, phmPath: string): PhmDocument {
  const doc = parseSourceDocument(phmPath, text),
    sourceDiagnostics = sourceConflicts(doc);
  const solidModels: PhmSolidModelEntry[] = [];
  for (const [group, reference, block] of [
    ["SOLIDS", "SOLIDS", "phm-solids"],
    ["SOLIDMODELS", "SOLIDMODEL", "phm-models"],
  ] as const) {
    const count = parseBoundedCount(
      sourceScalar(doc, group + ".NUM").value,
      group + ".NUM",
    );
    for (let i = 0; i < count; i++) {
      const path = sourceScalar(doc, reference + i, block);
      if (path.status !== "resolved" || isGimEmptyValue(path.value)) continue;
      const placement = sourceScalar(doc, "TRANSFORMMATRIX" + i, block),
        color = sourceScalar(doc, "COLOR" + i, block);
      let matrix = [...IDENTITY_MATRIX];
      if (placement.fields.length && placement.status !== "ambiguous") {
        const parts = placement.value.split(","),
          values = parts.map((value) => Number(value.trim()));
        if (
          parts.every((value) => value.trim()) &&
          isUsableAffineMatrix(values)
        )
          matrix = values;
        else
          sourceDiagnostics.push(
            sourceDiagnostic(
              doc,
              "TRANSFORMMATRIX" + i,
              placement.fields,
              "invalid-source-matrix",
            ),
          );
      }
      solidModels.push({
        solidModelPath: path.value,
        transformMatrix: matrix,
        color: parseColor(color.value),
      });
    }
  }
  return {
    phmPath,
    solidModels,
    isEmpty: solidModels.length === 0,
    colorMaxA: solidModels.reduce(
      (max, row) => Math.max(max, row.color?.a ?? 0),
      0,
    ),
    ...(sourceDiagnostics.length ? { sourceDiagnostics } : {}),
  };
}

function parseColor(raw: string | undefined): XmlModColor | undefined {
  if (typeof raw !== "string" || isGimEmptyValue(raw)) return undefined;
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 4) return undefined;
  const [r, g, b, a] = parts.map((p) => parseInt(p, 10));
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return undefined;
  if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255)
    return undefined;
  if (a < 0 || a > 255) return undefined;
  return { r, g, b, a };
}
