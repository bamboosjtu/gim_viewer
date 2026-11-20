import type { EvidenceValue } from "../types.js";
import { modelPreferredTerms, type ContextRule } from "./recognitionPolicy.js";
import type { StandardTermLike } from "./standardClassResolver.js";

export interface ComponentEntry {
  componentIds: readonly string[];
  defaultComponentId?: string;
  evidence?: unknown;
}

export interface ComponentResolution {
  componentDeclarations: EvidenceValue[];
  namespaceAmbiguities: string[];
  useComponent: (value: string) => boolean;
  componentIds: (value: string) => string[];
}

/** Ordered component-vs-standard decision; namespace ambiguities stay explicit. */
export function resolveComponents(input: {
  declarations: readonly EvidenceValue[];
  componentEntries: Readonly<Record<string, ComponentEntry>>;
  componentHint: { componentIds: readonly string[] } | undefined;
  cabinetMember: boolean;
  independent: boolean;
  componentContext: boolean;
  modelTerms: (value: string) => readonly StandardTermLike[];
  groundWord: (value: string) => boolean;
  ruleFor: (value: string) => ContextRule | undefined;
  namespaceAmbiguities: string[];
}): ComponentResolution {
  const {
    declarations,
    componentEntries,
    componentHint,
    cabinetMember,
    independent,
    componentContext,
    modelTerms,
    groundWord,
    ruleFor,
    namespaceAmbiguities,
  } = input;

  const useComponent = (value: string): boolean => {
    const key = value.trim().toLowerCase();
    const entry = componentEntries[key];
    if (!entry || groundWord(value)) return false;
    if (ruleFor(value)?.hostKind === "cabinet")
      return cabinetMember && !independent;
    const items = modelTerms(value);
    if (!items.length) return !independent;
    if (independent) return false;
    if (componentContext) return true;
    if (ruleFor(value))
      return !!componentHint?.componentIds.some((id) =>
        entry.componentIds.includes(id),
      );
    if (modelPreferredTerms.includes(key))
      return !!componentHint?.componentIds.some((id) =>
        entry.componentIds.includes(id),
      );
    namespaceAmbiguities.push(value);
    return false;
  };

  const componentDeclarations = declarations.filter((p) =>
    useComponent(p.value),
  );
  const componentIds = (value: string): string[] => {
    const entry = componentEntries[value.trim().toLowerCase()];
    if (!entry) return [];
    if (!entry.defaultComponentId && componentHint) {
      const ids = entry.componentIds.filter((id) =>
        componentHint.componentIds.includes(id),
      );
      if (ids.length) return ids;
    }
    return entry.defaultComponentId
      ? [entry.defaultComponentId]
      : [...entry.componentIds];
  };
  return {
    componentDeclarations,
    namespaceAmbiguities,
    useComponent,
    componentIds,
  };
}
