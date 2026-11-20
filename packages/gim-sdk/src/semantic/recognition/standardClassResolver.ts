import type { EvidenceValue } from "../types.js";
import { directoryDefinition } from "../catalog/catalogLabels.js";
import { directoryRecognitionCode } from "../catalogClassification.js";

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
