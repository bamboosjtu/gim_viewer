import type { EvidenceValue } from "../types.js";
import { standardCatalogItem, standardTerms } from "../standardCatalog.js";
import type { ContextRule } from "./recognitionPolicy.js";

export interface MaterialComponentHint {
  componentIds: readonly string[];
}

interface MaterialResolutionBase {
  materialDeclarations: EvidenceValue[];
  groundMember: boolean;
  materialItem: ReturnType<typeof standardCatalogItem>;
  groundWord: (value: string) => boolean;
  modelTerms: (value: string) => ReturnType<typeof standardTerms>;
}

export type MaterialResolution = MaterialResolutionBase &
  (
    | { groundMaterial: true; materialRule: ContextRule; materialCode: string }
    | {
        groundMaterial: false;
        materialRule: ContextRule | undefined;
        materialCode: string | undefined;
      }
  );

/** Decide whether a declaration is an explicit material variant of a host. */
export function resolveMaterial(input: {
  declarations: readonly EvidenceValue[];
  materialDeclarations: readonly EvidenceValue[];
  componentContext: boolean;
  independent: boolean;
  componentHint: MaterialComponentHint | undefined;
  ruleFor: (value: string) => ContextRule | undefined;
}): MaterialResolution {
  const {
    declarations,
    componentContext,
    independent,
    componentHint,
    ruleFor,
  } = input;
  const groundWord = (value: string): boolean =>
    !!ruleFor(value)?.materialRecognitionCode;
  const materialRule = declarations
    .map((p) => ruleFor(p.value))
    .find((rule) => rule?.materialRecognitionCode);
  const materialDeclarations = [...input.materialDeclarations];
  const groundMaterial =
    !!materialRule &&
    ((componentContext && !independent) ||
      materialDeclarations.length > 0 ||
      declarations.some((p) =>
        materialRule.materialTerms?.includes(p.value.trim()),
      ) ||
      !!componentHint?.componentIds.includes(materialRule.componentId));
  const groundMember = groundMaterial && componentContext && !independent;
  const materialItem =
    groundMaterial && materialRule.materialCatalogId
      ? standardCatalogItem(materialRule.materialCatalogId)
      : undefined;
  const modelTerms = (value: string): ReturnType<typeof standardTerms> =>
    groundMaterial && groundWord(value)
      ? materialItem
        ? [materialItem]
        : []
      : standardTerms(value);
  const common = {
    materialDeclarations,
    groundMember,
    materialItem,
    groundWord,
    modelTerms,
  };
  return groundMaterial && materialRule
    ? {
        ...common,
        groundMaterial: true,
        materialRule,
        materialCode: materialRule.materialRecognitionCode!,
      }
    : {
        ...common,
        groundMaterial: false,
        materialRule,
        materialCode: materialRule?.materialRecognitionCode,
      };
}
