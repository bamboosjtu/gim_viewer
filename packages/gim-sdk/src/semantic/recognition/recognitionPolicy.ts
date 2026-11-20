import recognitionPolicy from "../catalog/recognitionPolicy.json";

export interface ContextRule {
  componentId: string;
  materialRecognitionCode?: string;
  materialCatalogId?: string;
  materialTerms?: readonly string[];
  hostKind?: string;
}

const contextTerms: Readonly<Record<string, string>> =
  recognitionPolicy.contextualTerms;
const contextModels: Readonly<Record<string, ContextRule>> =
  recognitionPolicy.contextualModels;

/** Resolve an exporter/model term to its explicit contextual rule. */
export function contextualRule(value: string): ContextRule | undefined {
  return contextModels[contextTerms[value.trim().toLowerCase()]];
}

export const modelPreferredTerms: readonly string[] =
  recognitionPolicy.modelPreferredTerms;
