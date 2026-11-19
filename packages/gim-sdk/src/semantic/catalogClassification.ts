import catalog from "./catalog/catalog.json";
import { STANDARD_CATALOG } from "./standardCatalog.js";
import policy from "./catalog/recognitionPolicy.json";
import { directoryDefinition } from "./catalog/catalogLabels.js";
import type { EngineeringEntity } from "./types.js";

const indexed = new Map(STANDARD_CATALOG.map((item) => [item.id, item]));
const byRecognition = new Map<string, typeof STANDARD_CATALOG>();
const codes = new Map(policy.recognitionCodes.map((item) => [item.code, item]));
const directoryRoles = new Map<string, string[]>();
for (const item of STANDARD_CATALOG) {
  const roles = byRecognition.get(item.recognitionCode) ?? [];
  roles.push(item);
  byRecognition.set(item.recognitionCode, roles);
  const directory = directoryRoles.get(item.category) ?? [];
  if (!directory.includes(item.recognitionCode))
    directory.push(item.recognitionCode);
  directoryRoles.set(item.category, directory);
}

export const RECOGNITION_LABELS: Readonly<Record<string, string>> =
  Object.fromEntries(policy.recognitionCodes.map((c) => [c.code, c.label]));
export const recognitionLabel = (code: string) =>
  RECOGNITION_LABELS[code] ?? code;
export const categoryDefinition = (code: string) => codes.get(code);

/** Apply the configured directory after identity and membership decisions. */
export function directoryClassification(
  code: string,
  specific?: EngineeringEntity["standardClass"],
): { category: string; recognitionCode: string } {
  if (code === "U-OBJECT" || !code)
    return { category: code, recognitionCode: code };
  if (specific) return { category: specific.category, recognitionCode: code };
  const definition = codes.get(code),
    matches = byRecognition.get(code) ?? [];
  const preferred =
    definition && "catalogId" in definition
      ? indexed.get(definition.catalogId!)
      : undefined;
  const unique = [...new Set(matches.map((item) => item.category))];
  const family =
    definition && "catalogFamily" in definition
      ? catalog.categories.find(
          (row) =>
            row.kind === definition.catalogFamily!.kind &&
            row.label === definition.catalogFamily!.label,
        )
      : undefined;
  return {
    category:
      preferred?.category ??
      (unique.length === 1 ? unique[0] : (family?.code ?? "U-OBJECT")),
    recognitionCode: code,
  };
}
export function publishDirectoryClassification<
  T extends {
    category: string;
    recognitionCode?: string;
    standardClass?: EngineeringEntity["standardClass"];
    classificationStatus?: string;
    categoryStatus?: string;
    conflict?: string;
  },
>(value: T): T {
  const result = {
    ...value,
    ...directoryClassification(value.category, value.standardClass),
  };
  if (result.category === "U-OBJECT") {
    result.classificationStatus = "unresolved";
    result.categoryStatus = "unresolved";
  }
  if (
    result.category !== "U-OBJECT" &&
    value.standardClass?.status === "confirmed" &&
    !value.conflict
  ) {
    result.classificationStatus = "confirmed";
    result.categoryStatus = "confirmed";
  }
  return result;
}
export function directoryRecognitionCode(code: string): string | undefined {
  code = directoryDefinition(code)?.code ?? code;
  const roles = directoryRoles.get(code) ?? [];
  if (code === "E01") return "E-T";
  if (code === "E02") return "E-R";
  return roles[0];
}
