import { isUsableAffineMatrix } from "./affineMatrix.js";
import type { ParseDiagnostic } from "./types.js";

export type MatrixLayout = "a3-21-example" | "project-column-major";

const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
export function xmlModNumber(value: string | undefined): number {
  const text = value?.trim();
  return text && decimal.test(text) ? Number(text) : NaN;
}

export function parseXmlModEntityId(
  value: string | undefined,
): number | undefined {
  const text = value?.trim() ?? "";
  if (!/^\d+$/.test(text)) return undefined;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function decodeXmlModMatrix(
  rawValue: string | undefined,
  layout: MatrixLayout,
): {
  matrix: number[];
  diagnostic?: ParseDiagnostic;
  rawValue?: string;
} {
  const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (rawValue === undefined) return { matrix: identity() };
  const values = rawValue.split(",").map(xmlModNumber);
  let message =
    "TransformMatrix must contain exactly 16 complete finite numbers";
  if (values.length === 16 && values.every(Number.isFinite)) {
    const matrix =
      layout === "project-column-major"
        ? values
        : values.map((_, i) => values[(i % 4) * 4 + Math.floor(i / 4)]);
    if (isUsableAffineMatrix(matrix)) return { matrix };
    message = "TransformMatrix is not a usable affine placement";
  }
  return {
    matrix: identity(),
    rawValue,
    diagnostic: { severity: "warning", code: "invalid-source-matrix", message },
  };
}
