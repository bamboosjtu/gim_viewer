import recognitionPolicy from "../catalog/recognitionPolicy.json";
import proxyCategories from "../catalog/proxyCategories.json";
import aliases from "../catalog/sourceCompatibilityPolicy.json";
import { RECOGNITION_FIELDS_FINGERPRINT } from "../../shared/recognitionFieldPolicy.js";
import { ENGINEERING_RULES_VERSION } from "../classify.js";
import { VOCABULARY_CONTENT } from "../policyFingerprints.js";
import type { ObjectEvidence } from "../types.js";
import type { SourceFormatFacts } from "./sourceFormatFacts.js";
import { canonicalSourceType } from "./sourceTypePolicy.js";
import { contextualRule as contextRule } from "./recognitionPolicy.js";
import { RECOGNITION_LABELS as ENGINEERING_CATEGORY_LABELS } from "../catalogClassification.js";
import sourceVocabulary from "../catalog/sourceVocabulary.json";
import {
  standardTerms,
  standardEquipmentId,
  STANDARD_CATALOG_VERSION,
} from "../standardCatalog.js";
import {
  prepareObjectDecision,
  resolveObjectCandidates,
  type SemanticDecisionInput,
  type ObjectCandidates,
} from "./objectEvidenceCandidates.js";
import {
  collectVocabularyObservations,
  confidence,
  componentEntries,
} from "./objectVocabularyEvidence.js";

export const ENGINEERING_RECOGNITION_VERSION = [
  ENGINEERING_RULES_VERSION,
  STANDARD_CATALOG_VERSION,
  sourceVocabulary.version,
  sourceVocabulary.keywordDictionary.version,
  aliases.version,
  proxyCategories.version,
  `vocabulary-content:${VOCABULARY_CONTENT}`,
  `recognition-fields:${RECOGNITION_FIELDS_FINGERPRINT}`,
].join("|");

const vocabulary: Record<string, string> = {
  ...sourceVocabulary.equipment,
  ...sourceVocabulary.equipmentAliases,
};
const components: Record<string, string> = sourceVocabulary.components;
const componentWords = Object.keys(sourceVocabulary.componentDictionary.entries)
  .filter((word) => /[\u3400-\u9fff]/.test(word) && word.length >= 3)
  .sort((a, b) => b.length - a.length);
const componentNameExpression = new RegExp(
  componentWords
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
);
function interpretObjectCandidates(
  decision: SemanticDecisionInput,
  candidates: ObjectCandidates,
) {
  const { facts, sourceType, typeCategoryHint, categoryValue, standardTypes } =
    decision;
  const { name } = facts;
  const { predefinedCategories } = sourceType;
  const sourceTypeEvidenceId = sourceType.declaration.evidenceId;
  const {
    groundMaterial,
    materialRule,
    materialDeclarations,
    chinese,
    declarations,
    groundWord,
    standardClasses,
    componentDeclarations,
    namespaceAmbiguities,
    allowNameFallback,
    neutralAttachment,
  } = candidates;
  const propertyCategories = [
    ...(groundMaterial && materialRule
      ? materialDeclarations.map((p) => ({
          ...p,
          value: materialRule.materialRecognitionCode!,
        }))
      : []),
    ...(chinese.length ? [] : predefinedCategories),
    ...declarations
      .filter(
        (p) =>
          p.evidenceId !== sourceTypeEvidenceId &&
          !(groundMaterial && groundWord(p.value)) &&
          !standardClasses.some((c) => c.evidenceId === p.evidenceId) &&
          !componentDeclarations.some((c) => c.evidenceId === p.evidenceId) &&
          !namespaceAmbiguities.includes(p.value),
      )
      .flatMap((p) => {
        const category = categoryValue(p.value);
        return category !== "U-OBJECT" && category !== "part"
          ? [{ ...p, value: category }]
          : [];
      }),
    ...facts.modelProperties
      .filter((p) => !chinese.length || /[\u3400-\u9fff]/.test(p.value))
      .flatMap((p) => {
        const category = categoryValue(p.value);
        return category !== "U-OBJECT" && category !== "part"
          ? [{ ...p, value: category }]
          : [];
      }),
    ...sourceType.authoringCategories,
  ];
  const proxyCategory = new Set(propertyCategories.map((p) => p.value));
  const proxyName =
    sourceType.useCategoryLabel &&
    proxyCategory.size === 1 &&
    !["E19", "C-D6"].includes([...proxyCategory][0])
      ? ENGINEERING_CATEGORY_LABELS[[...proxyCategory][0]]
      : undefined;
  const observedCategories = [
    ...new Set(propertyCategories.map((p) => p.value)),
  ];
  const declaredCategories = [
    ...new Set(standardClasses.map((p) => p.recognitionCode)),
  ];
  const typed = groundMaterial
    ? materialRule?.materialRecognitionCode
    : declaredCategories.length === 1
      ? declaredCategories[0]
      : predefinedCategories.length === 1
        ? predefinedCategories[0].value
        : (typeCategoryHint ??
          sourceType.exactFallbackCategory ??
          (observedCategories.length === 1
            ? observedCategories[0]
            : undefined));
  for (const p of facts.purposes) {
    const category = /^(?:站用|station_service_transformer)$/i.test(
      p.value.trim(),
    )
      ? "E03"
      : /^(?:主变|main_transformer)$/i.test(p.value.trim())
        ? "E01"
        : categoryValue(p.value);
    // A service target such as “主变控制” is not this cabinet's identity.
    if (
      ((typed === "E01" || typed === "E-T") &&
        ["E01", "E03"].includes(category)) ||
      (typed === "C-B4" && ["C-B2", "C-B3"].includes(category)) ||
      (sourceType.drainageCategory && /^(?:给排水设施|排水设施)$/.test(p.value))
    )
      propertyCategories.push({
        ...p,
        value: sourceType.drainageCategory ?? category,
      });
  }
  const needsNameCandidate =
    allowNameFallback &&
    !components[sourceType.declaration.value.toLowerCase()] &&
    !standardTypes.length &&
    !standardClasses.length &&
    !componentDeclarations.length &&
    !groundMaterial &&
    !propertyCategories.length &&
    (!typeCategoryHint || typeCategoryHint === "part") &&
    !standardTerms(name).length;
  const nameTerm = needsNameCandidate
    ? (componentEntries[name.trim().toLowerCase()] ??
      componentEntries[
        (name.split(/[_－:：]/).pop() ?? "").trim().toLowerCase()
      ])
    : undefined;
  const namedComponent = needsNameCandidate
    ? (nameTerm ??
      componentEntries[componentNameExpression.exec(name)?.[0] ?? ""])
    : undefined;
  const componentNameCandidate = namedComponent?.componentType
    ? [
        {
          value: namedComponent.componentType,
          evidenceId:
            facts.names?.find((n) => n.value === name)?.evidenceId ??
            `name:${facts.sourceId}`,
          confidence: "candidate" as const,
        },
      ]
    : [];
  const sourceTypeApplies =
    declarations.some((p) => p.evidenceId === sourceTypeEvidenceId) &&
    !(
      standardTypes.length === 0 &&
      new Set(standardClasses.map((p) => p.id)).size === 1 &&
      standardClasses.some((p) => p.evidenceId !== sourceTypeEvidenceId)
    );
  const classifiedSourceType =
    standardClasses.find((p) => p.evidenceId === sourceTypeEvidenceId)
      ?.recognitionCode ?? typeCategoryHint;
  let typeCategory: string | undefined;
  if (groundMaterial) typeCategory = materialRule?.materialRecognitionCode;
  else if (!namespaceAmbiguities.length) {
    if (componentDeclarations.length && !standardClasses.length)
      typeCategory = "part";
    else if (neutralAttachment) typeCategory = "neutral_set";
    else if (sourceTypeApplies) {
      typeCategory =
        predefinedCategories.length === 1
          ? predefinedCategories[0].value
          : classifiedSourceType === "E01" &&
              sourceType.declaration.value !== "E01"
            ? "E-T"
            : (classifiedSourceType ?? sourceType.fallbackCategory);
    }
  }
  return {
    propertyCategories,
    proxyName,
    typed,
    componentNameCandidate,
    typeCategory,
  };
}

function assembleObjectEvidence(
  decision: SemanticDecisionInput,
  candidates: ObjectCandidates,
  classification: ReturnType<typeof interpretObjectCandidates>,
  vocabularyObservations: ObjectEvidence["vocabularyObservations"],
): ObjectEvidence {
  const { facts, sourceType, typeCategoryHint } = decision;
  const { predefinedCategories } = sourceType;
  const sourceTypeEvidenceId = sourceType.declaration.evidenceId;
  const {
    allowNameFallback,
    standardClasses,
    namespaceAmbiguities,
    standardDeclarations,
    modelTerms,
    groundMaterial,
    groundWord,
    groundMember,
    materialRule,
    declarations,
    componentDeclarations,
    componentIds,
    componentHint,
    neutralAttachment,
    luminaireTerminal,
  } = candidates;
  const {
    propertyCategories,
    proxyName,
    typed,
    componentNameCandidate,
    typeCategory,
  } = classification;
  return {
    allowNameFallback,
    declaredHostSourceIds: facts.declaredHostSourceIds,
    standardClasses,
    vocabularyAmbiguities: namespaceAmbiguities,
    hostCodes: facts.hostCodes,
    hostDesignations: facts.hostDesignations,
    vocabularyObservations,
    equipmentTypeCandidates: standardDeclarations.flatMap((p) => {
      const items = modelTerms(p.value).filter(
        (item) => item.kind === "equipment",
      );
      return groundMaterial && groundWord(p.value)
        ? []
        : items.length
          ? items.map((item) => ({ ...p, value: standardEquipmentId(item) }))
          : vocabulary[p.value.trim().toLowerCase()]
            ? [{ ...p, value: vocabulary[p.value.trim().toLowerCase()] }]
            : [];
    }),
    componentTypeCandidates: [
      ...(groundMember && materialRule
        ? [
            {
              value: materialRule.componentId,
              evidenceId: declarations.find((p) => groundWord(p.value))!
                .evidenceId,
              confidence: "confirmed" as const,
            },
          ]
        : []),
      ...componentNameCandidate,
      ...componentDeclarations.flatMap((p) => {
        const entry = componentEntries[p.value.trim().toLowerCase()];
        return componentIds(p.value).map((id) => ({
          ...p,
          value: id,
          confidence:
            entry.defaultComponentId || componentHint
              ? ("confirmed" as const)
              : confidence(entry),
        }));
      }),
    ],
    purposes: sourceType.impliedPurpose
      ? [sourceType.impliedPurpose]
      : ["E01", "E-T", "E03"].includes(typed ?? "")
        ? facts.purposes.flatMap((p) =>
            /^(?:主变|主变压器|main_transformer)$/i.test(p.value.trim())
              ? [{ ...p, value: "main_transformer" }]
              : /^(?:站用|站用变压器|station_service_transformer)$/i.test(
                    p.value.trim(),
                  )
                ? [{ ...p, value: "station_service_transformer" }]
                : [],
          )
        : [],
    sourceId: facts.sourceId,
    name: proxyName || facts.name,
    assemblyParentId: facts.assemblyParentId,
    composition: facts.composition,
    names: facts.names,
    typeCategory,
    typeEvidenceId:
      neutralAttachment?.evidenceId ??
      (groundMaterial
        ? declarations.find((p) => groundWord(p.value))!.evidenceId
        : componentDeclarations.length && !standardClasses.length
          ? componentDeclarations[0].evidenceId
          : predefinedCategories.length === 1
            ? predefinedCategories[0].evidenceId
            : sourceType.canonicalEvidenceId),
    propertyCategories: [
      ...propertyCategories,
      ...standardClasses
        .filter((p) => p.evidenceId !== sourceTypeEvidenceId)
        .map((p) => ({ ...p, value: p.recognitionCode })),
    ],
    typeRefinements: sourceType.refinements,
    objectRoles: [
      ...(groundMember && materialRule
        ? [
            {
              value: "part",
              evidenceId:
                "policy:" +
                recognitionPolicy.version +
                ":material_member:" +
                materialRule.componentId,
            },
          ]
        : []),
      ...facts.roles.flatMap((p) =>
        /^(?:source_only|非物理来源)$/i.test(p.value)
          ? [{ ...p, value: "source_only" }]
          : /^(?:detail|细部)$/i.test(p.value)
            ? [{ ...p, value: "detail" }]
            : /^(?:container|装配容器)$/i.test(p.value)
              ? [{ ...p, value: "container" }]
              : /内部|组成|部件|component|part/i.test(p.value)
                ? [{ ...p, value: "part" }]
                : /独立|independent/i.test(p.value)
                  ? [{ ...p, value: "independent" }]
                  : [],
      ),
      ...(sourceType.impliedRole ? [sourceType.impliedRole] : []),
    ],
    traits: {
      ...sourceType.traits,
      materialType: groundMaterial || !!typeCategoryHint?.startsWith("M"),
      ...(luminaireTerminal ? { luminaireTerminal } : {}),
    },
    designations: facts.designations,
    identityCodes: facts.identityCodes,
    identityNames: facts.identityNames,
    phases: facts.phases.map((p) => ({
      ...p,
      value: /^(?:1|单相)$/.test(p.value) ? "单相" : p.value,
    })),
    phaseLabels: facts.phaseLabels,
  };
}

export function resolveObjectEvidence(
  facts: SourceFormatFacts,
  completeNeutralAssembly = false,
): ObjectEvidence {
  const decision = prepareObjectDecision(facts, completeNeutralAssembly);
  const resolve = (
    equipmentMember = false,
    cabinetMember = false,
  ): ObjectEvidence => {
    const candidates = resolveObjectCandidates(
      decision,
      equipmentMember,
      cabinetMember,
    );
    return assembleObjectEvidence(
      decision,
      candidates,
      interpretObjectCandidates(decision, candidates),
      collectVocabularyObservations(decision, candidates),
    );
  };
  const result = resolve();
  const resolvedPart =
    result.objectRoles?.some((p) => p.value === "part") ||
    result.componentTypeCandidates?.some((p) => p.confidence !== "candidate");
  if (!decision.independent) {
    const rules = [
      facts.sourceType.declaration,
      ...facts.contextualDeclarations,
    ]
      .map(({ value }) => contextRule(canonicalSourceType(value)))
      .filter((rule) => rule !== undefined);
    if (!resolvedPart && rules.some((rule) => !rule.hostKind))
      result.equipmentMemberVariant = resolve(true);
    if (rules.some((rule) => rule.hostKind === "cabinet"))
      result.cabinetMemberVariant = resolve(true, true);
  }
  return result;
}
