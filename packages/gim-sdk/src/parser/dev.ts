/** DEV references and matrices use block-local slots; source rows are never overwritten. */
import type {
  DevDocument,
  DevSolidModelEntry,
  DevSubDeviceEntry,
} from "@gim/powerline-core/geometry/ir.js";
import { parseBoundedCount } from "@gim/powerline-core/parserLimits.js";
import {
  parseSourceDocument,
  sourceDiagnostic,
  sourceReferenceFields,
  sourceScalar,
  type SourceDiagnostic,
  type SourceDocument,
  type SourceField,
} from "@gim/powerline-core/sourceDocument.js";
import { isUsableAffineMatrix } from "./affineMatrix.js";
import type { ParseResult } from "./types.js";
import { fromSourceDiagnostic, parseStatus } from "./diagnostics.js";
import { isGimEmptyValue } from "./values.js";

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function parseDev(text: string, devPath: string): DevDocument {
  return parseDevDocument(parseSourceDocument(devPath, text));
}

/** Project DEV slots from the lossless document; block spelling stays on its fields. */
function parseDevDocument(doc: SourceDocument): DevDocument {
  const diagnostics: SourceDiagnostic[] = [];
  const ambiguous = (key: string, fields: readonly SourceField[]) =>
    diagnostics.push(sourceDiagnostic(doc, key, fields));
  const scalar = (key: string) => {
    const result = sourceScalar(doc, key);
    if (result.status === "ambiguous") ambiguous(key, result.fields);
    return isGimEmptyValue(result.value) ? "" : result.value;
  };
  const solidCount = parseBoundedCount(
    scalar("SOLIDMODELS.NUM"),
    "SOLIDMODELS.NUM",
  );
  const subCount = parseBoundedCount(
    scalar("SUBDEVICES.NUM"),
    "SUBDEVICES.NUM",
  );
  const matrix = (index: number, block: "solid" | "sub"): number[] => {
    const key = `TRANSFORMMATRIX${index}`,
      result = sourceScalar(doc, key, block);
    if (result.status === "ambiguous") {
      ambiguous(key, result.fields);
      return identity();
    }
    if (result.status === "empty") {
      if (result.fields.length)
        diagnostics.push(
          sourceDiagnostic(doc, key, result.fields, "invalid-source-matrix"),
        );
      return identity();
    }
    const parts = result.value.split(","),
      values = parts.map((value) => Number(value.trim()));
    if (parts.every((value) => value.trim()) && isUsableAffineMatrix(values))
      return values;
    diagnostics.push(
      sourceDiagnostic(doc, key, result.fields, "invalid-source-matrix"),
    );
    return identity();
  };
  const solidSlots: Array<DevSolidModelEntry | undefined> = [],
    subSlots: Array<DevSubDeviceEntry | undefined> = [];
  for (const field of sourceReferenceFields(
    doc,
    /^(?:SOLIDMODEL|SUBDEVICE)\d+$/,
    ambiguous,
  )) {
    const key = field.keys[0].toUpperCase(),
      index = Number(key.match(/\d+$/)![0]);
    if (isGimEmptyValue(field.value)) continue;
    if (key.startsWith("SOLIDMODEL") && index < solidCount)
      solidSlots[index] = {
        solidModelPath: field.value,
        transformMatrix: matrix(index, "solid"),
      };
    if (key.startsWith("SUBDEVICE") && index < subCount)
      subSlots[index] = {
        sourceIndex: index,
        devPath: field.value,
        transformMatrix: matrix(index, "sub"),
      };
  }
  const solidModels = solidSlots.filter(
    (entry): entry is DevSolidModelEntry => entry !== undefined,
  );
  const subDevices = subSlots.filter(
    (entry): entry is DevSubDeviceEntry => entry !== undefined,
  );
  const baseFamily = scalar("BASEFAMILY") || scalar("BASEFAMILYPOINTER");
  const type = scalar("TYPE") || scalar("DEVICETYPE"),
    symbolName = scalar("SYMBOLNAME");
  return {
    devPath: doc.path,
    baseFamily,
    type,
    symbolName,
    solidModels,
    subDevices,
    isEmpty: solidModels.length === 0 && subDevices.length === 0,
    ...(diagnostics.length ? { sourceDiagnostics: diagnostics } : {}),
  };
}

/** Unified diagnostic envelope for new Browser/Validate consumers. */
export function parseDevResult(
  text: string,
  devPath: string,
): ParseResult<DevDocument> {
  const value = parseDev(text, devPath);
  const diagnostics = (value.sourceDiagnostics ?? []).map(fromSourceDiagnostic);
  return {
    value,
    diagnostics,
    status: parseStatus(diagnostics, !value.isEmpty),
  };
}
