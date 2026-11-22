import recognitionPolicy from "../catalog/recognitionPolicy.json";
import { directoryRecognitionCode } from "../catalogClassification.js";
import { standardTerms } from "../standardCatalog.js";
import type { EvidenceValue } from "../types.js";
import type { SourceFormatFacts } from "./sourceFormatFacts.js";
import {
  resolveSourceType,
  sourceCategoryAlias,
} from "./sourceTypeDecision.js";
import { resolveMaterial } from "./materialResolver.js";
import { resolveComponents } from "./componentResolver.js";
import {
  applyTypeDefaults,
  resolveStandardClasses,
  roadPositionType,
} from "./standardClassResolver.js";
import { contextualRule as contextRule } from "./recognitionPolicy.js";
import {
  keywordEntries,
  confidence,
  componentEntries,
} from "./objectVocabularyEvidence.js";

function categoryValue(value: string): string {
  const standard = standardTerms(value);
  if (standard.length)
    return standard.length === 1 ? standard[0].recognitionCode : "U-OBJECT";
  const direct = directoryRecognitionCode(value);
  if (direct) return direct;
  const alias = sourceCategoryAlias(value);
  return alias === "E01" ? "E-T" : (alias ?? "U-OBJECT");
}

export function prepareObjectDecision(
  facts: SourceFormatFacts,
  completeNeutralAssembly = false,
) {
  const sourceType = resolveSourceType(facts, completeNeutralAssembly);
  const type = sourceType.declaration.value;
  const standardTypes = standardTerms(type);
  const standardCategories = [
    ...new Set(standardTypes.map((item) => item.recognitionCode)),
  ];
  const typeCategoryHint =
    standardCategories.length === 1
      ? standardCategories[0]
      : (directoryRecognitionCode(type) ?? sourceType.compatibilityCategory);
  return {
    facts,
    sourceType,
    standardTypes,
    typeCategoryHint,
    categoryValue,
    independent: facts.roles.some((p) => /独立|independent/i.test(p.value)),
  };
}

export type SemanticDecisionInput = ReturnType<typeof prepareObjectDecision>;

export function resolveObjectCandidates(
  decision: SemanticDecisionInput,
  equipmentMember: boolean,
  cabinetMember: boolean,
) {
  const { facts, independent, sourceType } = decision;
  const { keywordDeclarations } = sourceType;
  const luminaireTerminal =
    !independent && !cabinetMember
      ? sourceType.luminaireDeclaration
      : undefined;
  const partRole = facts.roles.some((p) =>
    /内部|组成|部件|component|part/i.test(p.value),
  );
  const componentContext =
    equipmentMember ||
    partRole ||
    !!facts.declaredHostSourceIds?.length ||
    facts.componentTypeDeclarations.length > 0 ||
    facts.hostCodes.length > 0 ||
    facts.hostDesignations.length > 0;
  const namespaceAmbiguities: string[] = [];
  const cabinetName = partRole
    ? undefined
    : sourceType.cabinetFamilyDeclaration;
  const roadPosition = roadPositionType(sourceType.roadPositions);
  const allowNameFallback =
    facts.sourceTypesComplete &&
    !sourceType.hasTypeProperties &&
    !sourceType.models.length &&
    !sourceType.predefinedCategories.length &&
    !keywordDeclarations.some(
      ({ rawValue }) =>
        keywordEntries[rawValue.trim().toLowerCase()] ||
        componentEntries[rawValue.trim().toLowerCase()],
    );
  const rawDeclarations: EvidenceValue[] = [
    sourceType.declaration,
    ...(cabinetName ? [cabinetName] : []),
    ...(roadPosition ? [roadPosition] : []),
    ...sourceType.properties,
    ...sourceType.models,
    ...keywordDeclarations.map(({ rawValue, declaration }) => {
      const key = rawValue.trim().toLowerCase();
      const entry = keywordEntries[key] ?? componentEntries[key];
      return {
        ...declaration,
        confidence: entry ? confidence(entry) : ("candidate" as const),
      };
    }),
  ];
  const resolved = applyTypeDefaults(rawDeclarations).filter(
    (p) =>
      !sourceType.fineCabinetModel ||
      !["secondarycabinet", "controlcabinet", "二次屏柜", "控制柜"].includes(
        p.value.trim().toLowerCase(),
      ),
  );
  const chinese = resolved.filter(
    (p) =>
      /[\u3400-\u9fff]/.test(p.value) &&
      (standardTerms(p.value).length ||
        componentEntries[p.value.trim().toLowerCase()]),
  );
  const declarations = (chinese.length ? chinese : resolved).filter(
    (p) => !luminaireTerminal || p.value.trim().toLowerCase() !== "led",
  );
  const needsChineseHint = declarations.some((p) => {
    const entry = componentEntries[p.value.trim().toLowerCase()];
    return (
      entry &&
      (entry.componentIds.length > 1 ||
        entry.defaultComponentId ||
        standardTerms(p.value).length)
    );
  });
  const chineseName =
    needsChineseHint && allowNameFallback
      ? [...facts.deviceNames.map((p) => p.value), facts.name].find(
          (name) =>
            /[\u3400-\u9fff]/.test(name) &&
            componentEntries[name.trim().toLowerCase()],
        )
      : undefined;
  const componentHint = chineseName
    ? componentEntries[chineseName.trim().toLowerCase()]
    : undefined;
  const material = resolveMaterial({
    declarations,
    materialDeclarations: facts.materialDeclarations.filter(
      (p) => !!contextRule(p.value)?.materialRecognitionCode,
    ),
    componentContext,
    independent,
    componentHint,
    ruleFor: contextRule,
  });
  const { groundWord, materialRule, groundMaterial, groundMember, modelTerms } =
    material;
  const materialDeclarations = material.materialDeclarations;
  const componentResolution = resolveComponents({
    declarations,
    componentEntries,
    componentHint,
    cabinetMember,
    independent,
    componentContext,
    modelTerms,
    groundWord,
    ruleFor: contextRule,
    namespaceAmbiguities,
  });
  const { componentDeclarations, componentIds } = componentResolution;
  const standardDeclarations = declarations.filter(
    (p) =>
      !componentDeclarations.includes(p) &&
      !namespaceAmbiguities.includes(p.value),
  );
  const cabinetNameCandidate =
    allowNameFallback && !componentDeclarations.length
      ? sourceType.cabinetNameDeclaration
      : undefined;
  const catalogDeclarations = cabinetNameCandidate
    ? [cabinetNameCandidate]
    : standardDeclarations;
  const standardClasses = resolveStandardClasses(
    catalogDeclarations,
    modelTerms,
  );
  const neutralAttachment = independent
    ? undefined
    : standardClasses.find(
        (p) =>
          p.id === recognitionPolicy.neutralAttachmentCatalogId &&
          p.confidence !== "candidate",
      );
  return {
    declarations,
    standardDeclarations,
    standardClasses,
    componentDeclarations,
    componentHint,
    componentIds,
    groundWord,
    materialRule,
    groundMaterial,
    groundMember,
    modelTerms,
    materialDeclarations,
    namespaceAmbiguities,
    neutralAttachment,
    allowNameFallback,
    chinese,
    luminaireTerminal,
  };
}

export type ObjectCandidates = ReturnType<typeof resolveObjectCandidates>;
