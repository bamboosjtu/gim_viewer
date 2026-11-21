import { VOCABULARY_CONTENT } from "../policyFingerprints.js";
import recognitionPolicy from "../catalog/recognitionPolicy.json";
import { RECOGNITION_FIELDS_FINGERPRINT } from "../../shared/recognitionFieldPolicy.js";
import { isIfcFeatureSourceType } from "../../shared/sourceRecord.js";
import aliases from "../catalog/sourceCompatibilityPolicy.json";
import type { ObjectEvidence } from "../types.js";
import { ENGINEERING_RULES_VERSION } from "../classify.js";
import type {
  SourceEvidenceFacts,
  SourceEvidenceOptions,
} from "./sourceEvidenceFacts.js";
import { contextualRule as contextRule } from "./recognitionPolicy.js";
import { RECOGNITION_LABELS as ENGINEERING_CATEGORY_LABELS } from "../catalogClassification.js";
import proxyCategories from "../catalog/proxyCategories.json";
import sourceVocabulary from "../catalog/sourceVocabulary.json";
import {
  standardTerms,
  standardEquipmentId,
  STANDARD_CATALOG_VERSION,
} from "../standardCatalog.js";
import {
  prepareObjectDecision,
  resolveObjectCandidates,
  type ObjectDecision,
  type ObjectCandidates,
} from "./objectEvidenceCandidates.js";
import {
  collectVocabularyObservations,
  confidence,
  componentEntries,
} from "./objectVocabularyEvidence.js";

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

function interpretObjectCandidates(
  decision: ObjectDecision,
  candidates: ObjectCandidates,
) {
  const {
    record,
    values,
    type,
    sourceTypeEvidenceId,
    devCategory,
    ifcTypes,
    predefinedCategories,
    categoryValue,
    standardTypes,
  } = decision;
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
  const modelProperties = values(["型号", "MODEL", "MODELSPEC"]);
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
    ...modelProperties
      .filter((p) => !chinese.length || /[\u3400-\u9fff]/.test(p.value))
      .flatMap((p) => {
        const category = categoryValue(p.value);
        return category !== "U-OBJECT" && category !== "part"
          ? [{ ...p, value: category }]
          : [];
      }),
  ];
  // Generic IFC proxies may still carry explicit authoring categories. Keep
  // this conservative: generic models/electrical equipment are not a type.
  if (type === "IFCBUILDINGELEMENTPROXY")
    for (const p of values(["类别(Category)", "类别", "Category"])) {
      const category = (proxyCategories.categories as Record<string, string>)[
        p.value.trim()
      ];
      if (category) propertyCategories.push({ ...p, value: category });
    }
  const proxyCategory = new Set(propertyCategories.map((p) => p.value));
  const proxyName =
    type === "IFCBUILDINGELEMENTPROXY" &&
    /^(?:代理构件|IfcBuildingElementProxy)$/i.test(record.name) &&
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
        : (devCategory ??
          ifcTypes[type] ??
          (observedCategories.length === 1
            ? observedCategories[0]
            : undefined));
  for (const p of values(["用途", "设备用途", "PURPOSE"])) {
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
      (["IFCPUMP", "IFCVALVE"].includes(type) &&
        /^(?:给排水设施|排水设施)$/.test(p.value))
    )
      propertyCategories.push({
        ...p,
        value: ["IFCPUMP", "IFCVALVE"].includes(type) ? "C-D5" : category,
      });
  }
  const needsNameCandidate =
    allowNameFallback &&
    !components[type.toLowerCase()] &&
    !standardTypes.length &&
    !standardClasses.length &&
    !componentDeclarations.length &&
    !groundMaterial &&
    !propertyCategories.length &&
    (!devCategory || devCategory === "part") &&
    !standardTerms(record.name).length;
  const nameTerm = needsNameCandidate
    ? (componentEntries[record.name.trim().toLowerCase()] ??
      componentEntries[
        (record.name.split(/[_－:：]/).pop() ?? "").trim().toLowerCase()
      ])
    : undefined;
  const namedComponent = needsNameCandidate
    ? (nameTerm ??
      componentEntries[componentNameExpression.exec(record.name)?.[0] ?? ""])
    : undefined;
  const componentNameCandidate = namedComponent?.componentType
    ? [
        {
          value: namedComponent.componentType,
          evidenceId:
            record.nameEvidence?.find((n) => n.value === record.name)
              ?.evidenceId ?? `name:${record.id}`,
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
      ?.recognitionCode ?? devCategory;
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
          : classifiedSourceType === "E01" && type !== "E01"
            ? "E-T"
            : (classifiedSourceType ?? ifcTypes[type.toUpperCase()]);
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
  decision: ObjectDecision,
  candidates: ObjectCandidates,
  classification: ReturnType<typeof interpretObjectCandidates>,
  vocabularyObservations: ObjectEvidence["vocabularyObservations"],
): ObjectEvidence {
  const {
    record,
    values,
    type,
    sourceTypeEvidenceId,
    predefinedCategories,
    devCategory,
  } = decision;
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
    declaredHostSourceIds: record.attributeOnly
      ? record.relations
          ?.filter((r) => r.kind === "host")
          .map((r) => ({ value: r.targetSourceId, evidenceId: r.evidence }))
      : [],
    standardClasses,
    vocabularyAmbiguities: namespaceAmbiguities,
    hostCodes: values([
      "所属设备编码",
      "宿主设备编码",
      "HOSTEQUIPMENTID",
      "HOSTEQUIPMENTCODE",
      "PARENTEQUIPMENTID",
    ]),
    hostDesignations: values([
      "所属设备名称",
      "所属设备工程中名称",
      "宿主设备名称",
      "HOSTEQUIPMENTNAME",
      "PARENTEQUIPMENTNAME",
    ]),
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
    purposes: /^stationtransformer$/i.test(type)
      ? [
          {
            value: "station_service_transformer",
            evidenceId: `${record.id}:source_type:${type}`,
          },
        ]
      : ["E01", "E-T", "E03"].includes(typed ?? "")
        ? values(["用途", "设备用途", "PURPOSE"]).flatMap((p) =>
            /^(?:主变|主变压器|main_transformer)$/i.test(p.value.trim())
              ? [{ ...p, value: "main_transformer" }]
              : /^(?:站用|站用变压器|station_service_transformer)$/i.test(
                    p.value.trim(),
                  )
                ? [{ ...p, value: "station_service_transformer" }]
                : [],
          )
        : [],
    sourceId: record.id,
    name: proxyName || record.name,
    assemblyParentId: record.parent || undefined,
    composition: record.parent
      ? [
          {
            kind:
              record.track === "dev"
                ? "physical_assembly"
                : "object_decomposition",
            parentSourceIds: [record.parent],
            evidence: [`assembly:${record.parent}->${record.id}`],
            status: "confirmed",
          },
        ]
      : undefined,
    names: record.nameEvidence,
    typeCategory,
    typeEvidenceId:
      neutralAttachment?.evidenceId ??
      (groundMaterial
        ? declarations.find((p) => groundWord(p.value))!.evidenceId
        : componentDeclarations.length && !standardClasses.length
          ? componentDeclarations[0].evidenceId
          : predefinedCategories.length === 1
            ? predefinedCategories[0].evidenceId
            : `${record.id}:source_type:${type}`),
    propertyCategories: [
      ...propertyCategories,
      ...standardClasses
        .filter((p) => p.evidenceId !== sourceTypeEvidenceId)
        .map((p) => ({ ...p, value: p.recognitionCode })),
    ],
    typeRefinements: ["IFCPUMP", "IFCVALVE"].includes(type)
      ? ["C-D5"]
      : ["IFCBEAM", "IFCBEAMSTANDARDCASE"].includes(type)
        ? ["C-A4.steel"]
        : ["IFCCOLUMN", "IFCCOLUMNSTANDARDCASE"].includes(type)
          ? ["C-A3.steel"]
          : type === "IFCMEMBER"
            ? ["C-A14", "C-A3", "C-A4", "C-B5", "C-B7"]
            : [],
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
      ...values([
        "对象角色",
        "组件角色",
        "OBJECTROLE",
        "COMPONENTROLE",
      ]).flatMap((p) =>
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
      ...(type === "IFCPILE"
        ? [
            {
              value: "part",
              evidenceId: `${record.id}:pile_foundation_component`,
            },
          ]
        : []),
    ],
    traits: {
      fastener: ["IFCMECHANICALFASTENER", "IFCFASTENER"].includes(type),
      assemblyContainer: [
        "IFCELEMENTASSEMBLY",
        "IFCBUILDINGELEMENTPROXY",
      ].includes(type),
      materialType: groundMaterial || !!devCategory?.startsWith("M"),
      nonphysical: isIfcFeatureSourceType(type),
      ...(luminaireTerminal ? { luminaireTerminal } : {}),
    },
    designations: values(["工程中名称", "PROJECTNAME", "Projectname"]),
    identityCodes: values([
      "电网工程标识系统编码",
      "设备编码",
      "GRIDIDENTIFICATIONSYSTEMCODE",
    ]),
    identityNames: values([
      "设备名称",
      "DEVICENAME",
      "工程中名称",
      "PROJECTNAME",
      "Projectname",
    ]),
    phases: values(["相数", "PHASECOUNT"]).map((p) => ({
      ...p,
      value: /^(?:1|单相)$/.test(p.value) ? "单相" : p.value,
    })),
    phaseLabels: values(["相别", "PHASE", "PHASELABEL"]),
  };
}

export function resolveObjectEvidence(
  facts: SourceEvidenceFacts,
  options: SourceEvidenceOptions,
): ObjectEvidence {
  const decision = prepareObjectDecision(facts, options);
  const { record, values, normalize } = decision;
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
  const role = values(["对象角色", "组件角色", "OBJECTROLE", "COMPONENTROLE"]);
  const contextual = [
    record.source_type,
    ...values([
      "TYPE",
      "类型",
      "模型分类名称",
      "装置名称",
      "DEVICETYPE",
      "EQUIPMENTTYPE",
      "MATERIALTYPE",
      "SYSCLASSIFYNAME",
      "PARTNAME",
      "设备类型",
      "设备类别",
      "材料类型",
      "材料子类",
      "MATERIALSUBTYPE",
      "设备子类",
      "EQUIPMENTSUBTYPE",
      "COMPONENTTYPE",
      "部件类型",
    ]).map((p) => p.value),
  ];
  const resolvedPart =
    result.objectRoles?.some((p) => p.value === "part") ||
    result.componentTypeCandidates?.some((p) => p.confidence !== "candidate");
  const rules = contextual
    .map((value) => contextRule(normalize.canonicalSourceType(value)))
    .filter((rule) => rule !== undefined);
  if (!role.some((p) => /独立|independent/i.test(p.value))) {
    if (!resolvedPart && rules.some((rule) => !rule.hostKind))
      result.equipmentMemberVariant = resolve(true);
    if (rules.some((rule) => rule.hostKind === "cabinet"))
      result.cabinetMemberVariant = resolve(true, true);
  }
  return result;
}
