import sourceVocabulary from "../catalog/sourceVocabulary.json";
import { standardTerms } from "../standardCatalog.js";
import { compatibilityCategoryAlias } from "./sourceTypeDecision.js";
import type { ObjectEvidence } from "../types.js";
import type {
  SemanticDecisionInput,
  ObjectCandidates,
} from "./objectEvidenceCandidates.js";

interface KeywordSourceEvidence {
  sheet: string;
  cell: string;
  workbookSha256: string;
  verification: string;
  sourceLocation?: string;
  sourceKind?: string;
}
const keywordEvidenceText = new WeakMap<KeywordSourceEvidence, string>();
/** Immutable dictionary metadata is shared, not reserialized for every occurrence. */
function keywordEvidence(evidence: KeywordSourceEvidence): string {
  let text = keywordEvidenceText.get(evidence);
  if (text === undefined) {
    text = JSON.stringify([
      evidence.workbookSha256,
      evidence.sheet,
      evidence.cell,
      evidence.verification,
      evidence.sourceKind,
      evidence.sourceLocation,
    ]);
    keywordEvidenceText.set(evidence, text);
  }
  return text;
}

const dictionary = sourceVocabulary.keywordDictionary;
export const keywordEntries = dictionary.entries as Record<
  string,
  {
    equipmentType?: string;
    defaultCatalogId?: string;
    evidence: KeywordSourceEvidence;
  }
>;
export const confidence = (entry: (typeof keywordEntries)[string]) =>
  "defaultCatalogId" in entry ||
  "defaultComponentId" in entry ||
  (entry.evidence.verification === "verified" && entry.evidence.sourceLocation)
    ? ("confirmed" as const)
    : ("candidate" as const);
export const componentEntries = sourceVocabulary.componentDictionary
  .entries as Record<
  string,
  {
    componentType?: string;
    componentIds: string[];
    defaultComponentId?: string;
    evidence: KeywordSourceEvidence;
    evidences?: KeywordSourceEvidence[];
  }
>;

export function collectVocabularyObservations(
  { facts }: SemanticDecisionInput,
  {
    declarations,
    componentDeclarations,
    namespaceAmbiguities,
  }: ObjectCandidates,
): ObjectEvidence["vocabularyObservations"] {
  const vocabularyObservations = facts.vocabularyDeclarations.map(
    ({ field, property }) => {
      const entry = keywordEntries[property.value.trim().toLowerCase()];
      const component = componentEntries[property.value.trim().toLowerCase()],
        selected = componentDeclarations.some(
          (p) => p.evidenceId === property.evidenceId,
        )
          ? component
          : entry;
      const terms = standardTerms(property.value),
        ambiguous =
          namespaceAmbiguities.includes(property.value) ||
          terms.length > 1 ||
          (selected?.evidence.verification === "ambiguous" &&
            !(
              selected &&
              ("defaultCatalogId" in selected ||
                "defaultComponentId" in selected)
            ));
      const evidences =
        selected && "evidences" in selected
          ? (selected.evidences as KeywordSourceEvidence[])
          : selected
            ? [selected.evidence]
            : [];
      return {
        field,
        rawValue: property.value,
        status: ambiguous
          ? ("ambiguous" as const)
          : selected
            ? ("mapped" as const)
            : ("unresolved" as const),
        evidenceId: property.evidenceId,
        dictionaryVersion: dictionary.version,
        ...(selected
          ? {
              verification: ambiguous
                ? ("ambiguous" as const)
                : (selected.evidence.verification as
                    "verified" | "unverified" | "ambiguous"),
              sourceLocation: selected.evidence.sourceLocation,
              dictionaryEvidence: JSON.stringify(
                evidences.map(keywordEvidence),
              ),
            }
          : {}),
      };
    },
  );
  for (const p of declarations) {
    const terms = standardTerms(p.value),
      alias = compatibilityCategoryAlias(p.value);
    if (
      namespaceAmbiguities.includes(p.value) ||
      terms.length > 1 ||
      componentEntries[p.value.trim().toLowerCase()]?.evidence.verification ===
        "ambiguous" ||
      (terms.length === 1 && alias && alias !== terms[0].recognitionCode)
    ) {
      vocabularyObservations.push({
        field: "declaration",
        rawValue: p.value,
        status: "ambiguous",
        evidenceId: p.evidenceId,
        dictionaryVersion: dictionary.version,
        verification: "ambiguous",
        dictionaryEvidence: JSON.stringify({
          standard: terms.map((t) => ({ id: t.id, evidence: t.evidence })),
          component: componentEntries[p.value.trim().toLowerCase()],
          compatibility: alias,
        }),
      });
    }
  }
  return vocabularyObservations;
}
