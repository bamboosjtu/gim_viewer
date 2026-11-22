import type { EvidenceValue } from "../types.js";
import { directoryDefinition } from "../catalog/catalogLabels.js";
import { directoryRecognitionCode } from "../catalogClassification.js";

import policy from "../catalog/sourceCompatibilityPolicy.json";
import { standardCatalogItem, standardTerms } from "../standardCatalog.js";

const defaults = new Map<string, string>(Object.entries(policy.typeDefaults));
const key = (value: string) => value.trim().normalize("NFKC").toLowerCase();

export interface StandardTermLike {
  id: string;
  kind: string;
  label: string;
  term: string;
  category: string;
  recognitionCode: string;
  catalogCategory: string;
  catalogGroup: string;
}

export interface StandardClassCandidate extends EvidenceValue {
  id: string;
  kind: "equipment" | "material" | "construction";
  label: string;
  term: string;
  category: string;
  recognitionCode: string;
  catalogCategory: string;
  catalogGroup: string;
}

/** Translate declared source terms into standard catalog classes. */
export function resolveStandardClasses(
  catalogDeclarations: readonly EvidenceValue[],
  modelTerms: (value: string) => readonly StandardTermLike[],
): StandardClassCandidate[] {
  return catalogDeclarations.flatMap((p) => {
    const items = modelTerms(p.value);
    const family = !items.length ? directoryDefinition(p.value) : undefined;
    const matches: readonly StandardTermLike[] = items.length
      ? items
      : family
        ? [
            {
              id: "category:" + family.code,
              kind: family.kind,
              label: family.label,
              term: family.code,
              category: family.code,
              recognitionCode: directoryRecognitionCode(family.code)!,
              catalogCategory: family.label,
              catalogGroup: family.groupLabel,
            },
          ]
        : [];
    return matches.map((item) => ({
      ...p,
      id: item.id,
      kind: item.kind as "equipment" | "material" | "construction",
      label: item.label,
      term: item.term,
      category: item.category,
      recognitionCode: item.recognitionCode,
      catalogCategory: item.catalogCategory,
      catalogGroup: item.catalogGroup,
    }));
  });
}

export function applyTypeDefaults(
  declarations: readonly EvidenceValue[],
): readonly EvidenceValue[] {
  if (!declarations.some((p) => defaults.has(key(p.value))))
    return declarations;
  const explicitFamilies = new Set(
    declarations
      .filter((p) => !defaults.has(key(p.value)))
      .flatMap((p) => standardTerms(p.value).map((item) => item.category)),
  );
  return declarations.flatMap((p) => {
    const id = defaults.get(key(p.value));
    const fallback = id && standardCatalogItem(id);
    if (!fallback) return [p];
    const genericSwitchCabinet =
      fallback.catalogCategory === "开关柜" && explicitFamilies.has("E17");
    return explicitFamilies.has(fallback.category) || genericSwitchCabinet
      ? []
      : [{ ...p, value: fallback.term }];
  });
}

/** Positions are declared by the source adapter. Missing/crossing/contradictory
 * boundary evidence keeps a generic road at the family level. */
export function roadPositionType(
  positions: readonly EvidenceValue[],
): EvidenceValue | undefined {
  if (!positions.length) return undefined;
  const id = (value: string) =>
    /^(?:站内|围墙内|inside)$/i.test(value.trim())
      ? "StationInRoadWays"
      : /^(?:站外|围墙外|outside)$/i.test(value.trim())
        ? "StationOutRoadWays"
        : undefined;
  const value = id(positions[0].value);
  if (value && positions.every((p) => id(p.value) === value))
    return { ...positions[0], value };
  return undefined;
}
