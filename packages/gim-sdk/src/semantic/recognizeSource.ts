import { VOCABULARY_CONTENT } from "./policyFingerprints.js";
import recognitionPolicy from "./catalog/recognitionPolicy.json";
import {
  ENGINEERING_EVIDENCE_FIELDS,
  RECOGNITION_FIELDS_FINGERPRINT,
} from "../shared/recognitionFieldPolicy.js";
import {
  isIfcFeatureSourceType,
  type SourceRecord,
} from "../shared/sourceRecord.js";
import aliases from "./catalog/sourceCompatibilityPolicy.json";
import type { ObjectEvidence } from "./types.js";
import { ENGINEERING_RULES_VERSION } from "./classify.js";
import { createValueReader } from "./recognition/evidenceReader.js";
import {
  RECOGNITION_LABELS as ENGINEERING_CATEGORY_LABELS,
  directoryRecognitionCode,
} from "./catalogClassification.js";
import { directoryDefinition } from "./catalog/catalogLabels.js";
import proxyCategories from "./catalog/proxyCategories.json";
import sourceVocabulary from "./catalog/sourceVocabulary.json";
import {
  standardTerms,
  standardCatalogItem,
  standardEquipmentId,
  STANDARD_CATALOG_VERSION,
} from "./standardCatalog.js";
import {
  applyTypeDefaults,
  cabinetModelType,
  canonicalSourceType,
  ifcModelType,
  isTypeDeclaration,
  roadPositionType,
} from "./sourceTypePolicy.js";
const vocabulary: Record<string, string> = {
  ...sourceVocabulary.equipment,
  ...sourceVocabulary.equipmentAliases,
};
const components: Record<string, string> = sourceVocabulary.components;
type ContextRule = {
  componentId: string;
  materialRecognitionCode?: string;
  materialCatalogId?: string;
  materialTerms?: readonly string[];
  hostKind?: string;
};
const contextTerms: Readonly<Record<string, string>> =
  recognitionPolicy.contextualTerms;
const contextModels: Readonly<Record<string, ContextRule>> =
  recognitionPolicy.contextualModels;
const contextRule = (value: string) =>
  contextModels[contextTerms[value.trim().toLowerCase()]];
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

// Only classification fields enter this transient index; raw properties stay intact.
export { ENGINEERING_EVIDENCE_FIELDS };
export type { SourceRecord, SourceProperty } from "../shared/sourceRecord.js";
/** Format labels and type enums end here; the engineering core does not read them. */
export function toObjectEvidence(record: SourceRecord): ObjectEvidence {
  return adaptSourceEvidence(record, {
    sourceTypesComplete: true,
    completeNeutralAssembly: false,
  });
}

export function adaptSourceEvidence(
  record: SourceRecord,
  {
    sourceTypesComplete,
    completeNeutralAssembly,
  }: { sourceTypesComplete: boolean; completeNeutralAssembly: boolean },
): ObjectEvidence {
  const values = createValueReader(record);
  const adapt = (
    equipmentMember = false,
    cabinetMember = false,
  ): ObjectEvidence => {
    const rawType = record.source_type;
    const sourceTypeEvidenceId = `${record.id}:source_type:${rawType}`;
    const type = completeNeutralAssembly
      ? "NeutralPointEquipment"
      : canonicalSourceType(rawType);
    const devTypes: Readonly<Record<string, string>> = aliases.dev;
    const ifcTypes: Readonly<Record<string, string>> = aliases.ifc;
    const standardTypes = standardTerms(type);
    const standardCategories = [
      ...new Set(standardTypes.map((item) => item.recognitionCode)),
    ];
    const devCategory =
      standardCategories.length === 1
        ? standardCategories[0]
        : (directoryRecognitionCode(type) ?? devTypes[type.toLowerCase()]);
    const categoryValue = (value: string): string => {
      const standard = standardTerms(value);
      if (standard.length)
        return standard.length === 1 ? standard[0].recognitionCode : "U-OBJECT";
      const direct = directoryRecognitionCode(value);
      const alias =
        (aliases.structured as Record<string, string>)[value.trim()] ??
        devTypes[value.toLowerCase()] ??
        ifcTypes[value.toUpperCase()];
      if (direct) return direct;
      if (alias) return alias === "E01" ? "E-T" : alias;
      // Model/spec strings are free text ("220kV变压器模型04_散热器"), not a
      // category fact. Structured fields accept exact mappings only.
      return "U-OBJECT";
    };
    const typeFields = [
      "TYPE",
      "类型",
      "模型分类名称",
      "装置名称",
      "设备类型",
      "设备类别",
      "设备分类",
      "材料类型",
      "材料类别",
      "构件类型",
      "构件类别",
      "DEVICETYPE",
      "EQUIPMENTTYPE",
      "MATERIALTYPE",
      "CONSTRUCTIONTYPE",
      "MATERIALSUBTYPE",
      "EQUIPMENTSUBTYPE",
      "材料子类",
      "设备子类",
      "设计类型",
      "IFC.OBJECTTYPE",
      "绝缘方式",
    ];
    const typeProperties = values(typeFields);
    const modelKeys = ["屏柜型号", "设备型号", "型号", "MODEL", "MODELSPEC"];
    if (record.track === "ifc")
      modelKeys.push("类型名称", "族与类型", "族名称", "结构材料", "结构材质");
    const typeModels = values(modelKeys).flatMap((p) => {
      const value = standardTerms(p.value).length
        ? p.value
        : (cabinetModelType(p.value) ??
          (record.track === "ifc" ? ifcModelType(type, p.value) : undefined));
      return value ? [{ ...p, value }] : [];
    });
    const fineCabinetModel = typeModels.some(
      (model) =>
        model.value === "MeasurementAndControlCabinet" ||
        model.value === "ProtectionCabinet",
    );
    const predefinedCategories = values(["IFC.PredefinedType"]).flatMap((p) => {
      const value = (aliases.ifcPredefined as Record<string, string>)[
        `${type}.${p.value.trim().toUpperCase()}`
      ];
      return value ? [{ ...p, value }] : [];
    });
    const dictionary = sourceVocabulary.keywordDictionary;
    const keywordEntries = dictionary.entries as Record<
      string,
      {
        equipmentType?: string;
        defaultCatalogId?: string;
        evidence: KeywordSourceEvidence;
      }
    >;
    const confidence = (entry: (typeof keywordEntries)[string]) =>
      "defaultCatalogId" in entry ||
      "defaultComponentId" in entry ||
      (entry.evidence.verification === "verified" &&
        entry.evidence.sourceLocation)
        ? ("confirmed" as const)
        : ("candidate" as const);
    const componentEntries = sourceVocabulary.componentDictionary
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
    const independent = values([
      "对象角色",
      "组件角色",
      "OBJECTROLE",
      "COMPONENTROLE",
    ]).some((p) => /独立|independent/i.test(p.value));
    const luminaireTerminal =
      !independent && !cabinetMember && /端子板\s*$/.test(record.name)
        ? typeProperties.find((p) => p.value.trim().toUpperCase() === "LED")
        : undefined;
    const partRole = values([
      "对象角色",
      "组件角色",
      "OBJECTROLE",
      "COMPONENTROLE",
    ]).some((p) => /内部|组成|部件|component|part/i.test(p.value));
    const componentContext =
      equipmentMember ||
      partRole ||
      (record.attributeOnly &&
        !!record.relations?.some((r) => r.kind === "host")) ||
      values([
        "COMPONENTTYPE",
        "部件类型",
        "所属设备编码",
        "宿主设备编码",
        "HOSTEQUIPMENTID",
        "HOSTEQUIPMENTCODE",
        "PARENTEQUIPMENTID",
        "所属设备名称",
        "所属设备工程中名称",
        "宿主设备名称",
        "HOSTEQUIPMENTNAME",
        "PARENTEQUIPMENTNAME",
      ]).length > 0;
    const namespaceAmbiguities: string[] = [];
    const cabinetAliases: Readonly<Record<string, string>> =
      aliases.cabinetTypeWithFamilyName;
    const cabinetAlias = [type, ...typeProperties.map((p) => p.value)].find(
      (value) => cabinetAliases[value.trim().toLowerCase()],
    );
    const cabinetName =
      cabinetAlias && !partRole && !typeModels.length
        ? values(["屏柜名称"]).find((p) => /[柜屏]/.test(p.value))
        : undefined;
    const roadPosition = roadPositionType(
      type,
      values(["道路位置", "围墙关系", "STATIONFENCERELATION"]),
    );
    const keywordsForType = values([
      "SYSCLASSIFYNAME",
      "PARTNAME",
      "COMPONENTTYPE",
      "部件类型",
    ]);
    const allowNameFallback =
      sourceTypesComplete &&
      !values(typeFields, record.track === "dev").some((p) =>
        isTypeDeclaration(p.value),
      ) &&
      !typeModels.length &&
      !predefinedCategories.length &&
      !keywordsForType.some(
        (p) =>
          keywordEntries[p.value.trim().toLowerCase()] ||
          componentEntries[p.value.trim().toLowerCase()],
      );
    const rawDeclarations = [
      { value: type, evidenceId: sourceTypeEvidenceId },
      ...(cabinetName
        ? [
            {
              ...cabinetName,
              value: cabinetAliases[cabinetAlias!.trim().toLowerCase()],
            },
          ]
        : []),
      ...(roadPosition ? [roadPosition] : []),
      ...typeProperties,
      ...typeModels,
      ...keywordsForType.map((p) => ({
        ...p,
        confidence: keywordEntries[p.value.trim().toLowerCase()]
          ? confidence(keywordEntries[p.value.trim().toLowerCase()])
          : componentEntries[p.value.trim().toLowerCase()]
            ? confidence(componentEntries[p.value.trim().toLowerCase()])
            : ("candidate" as const),
      })),
    ];
    const resolved = applyTypeDefaults(
      rawDeclarations.map((p) => {
        const value =
          completeNeutralAssembly &&
          p.value.trim().toLowerCase() === rawType.trim().toLowerCase()
            ? "NeutralPointEquipment"
            : canonicalSourceType(p.value);
        return value === p.value ? p : { ...p, value };
      }),
    ).filter(
      (p) =>
        !fineCabinetModel ||
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
        ? [
            ...values(["设备名称", "DEVICENAME"]).map((p) => p.value),
            record.name,
          ].find(
            (name) =>
              /[\u3400-\u9fff]/.test(name) &&
              componentEntries[name.trim().toLowerCase()],
          )
        : undefined;
    const componentHint = chineseName
      ? componentEntries[chineseName.trim().toLowerCase()]
      : undefined;
    const groundWord = (value: string) =>
      !!contextRule(value)?.materialRecognitionCode;
    const materialRule = declarations
      .map((p) => contextRule(p.value))
      .find((rule) => rule?.materialRecognitionCode);
    const materialDeclarations = values(["MATERIALTYPE", "材料类型"]).filter(
      (p) => groundWord(p.value),
    );
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
    const modelTerms = (value: string) =>
      groundMaterial && groundWord(value)
        ? materialItem
          ? [materialItem]
          : []
        : standardTerms(value);
    const useComponent = (value: string) => {
      const key = value.trim().toLowerCase(),
        entry = componentEntries[key];
      if (!entry || groundWord(value)) return false;
      if (contextRule(value)?.hostKind === "cabinet")
        return cabinetMember && !independent;
      const items = modelTerms(value);
      if (!items.length) return !independent;
      if (independent) return false;
      if (componentContext) return true;
      if (contextRule(value))
        return (
          !!componentHint &&
          componentHint.componentIds.some((id) =>
            entry.componentIds.includes(id),
          )
        );
      if (recognitionPolicy.modelPreferredTerms.includes(key))
        return (
          !!componentHint &&
          componentHint.componentIds.some((id) =>
            entry.componentIds.includes(id),
          )
        );
      namespaceAmbiguities.push(value);
      return false;
    };
    const componentDeclarations = declarations.filter((p) =>
      useComponent(p.value),
    );
    const standardDeclarations = declarations.filter(
      (p) =>
        !componentDeclarations.includes(p) &&
        !namespaceAmbiguities.includes(p.value),
    );
    const componentIds = (value: string) => {
      const entry = componentEntries[value.trim().toLowerCase()];
      if (!entry.defaultComponentId && componentHint) {
        const ids = entry.componentIds.filter((id) =>
          componentHint.componentIds.includes(id),
        );
        if (ids.length) return ids;
      }
      return entry.defaultComponentId
        ? [entry.defaultComponentId]
        : entry.componentIds;
    };
    const cabinetNameCandidate =
      allowNameFallback &&
      type.trim().toLowerCase() === "secondarycabinet" &&
      !componentDeclarations.length
        ? [
            ...values(["设备名称", "DEVICENAME", "工程中名称", "PROJECTNAME"]),
            ...(record.nameEvidence ?? []),
            { value: record.name, evidenceId: `name:${record.id}` },
          ].find((p) => cabinetModelType(p.value))
        : undefined;
    const catalogDeclarations = cabinetNameCandidate
      ? [
          {
            ...cabinetNameCandidate,
            value: cabinetModelType(cabinetNameCandidate.value)!,
            confidence: "candidate" as const,
          },
        ]
      : standardDeclarations;
    const standardClasses = catalogDeclarations.flatMap((p) => {
      const items = modelTerms(p.value),
        family = !items.length ? directoryDefinition(p.value) : undefined;
      const matches = items.length
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
    const neutralAttachment = independent
      ? undefined
      : standardClasses.find(
          (p) =>
            p.id === recognitionPolicy.neutralAttachmentCatalogId &&
            p.confidence !== "candidate",
        );
    const keywords = dictionary.fields.flatMap((field) =>
      values([field]).map((p) => ({
        field,
        property: p,
        entry: keywordEntries[p.value.trim().toLowerCase()],
      })),
    );
    const vocabularyObservations = keywords.map(
      ({ field, property, entry }) => {
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
        alias =
          devTypes[p.value.trim().toLowerCase()] ??
          ifcTypes[p.value.trim().toUpperCase()];
      if (
        namespaceAmbiguities.includes(p.value) ||
        terms.length > 1 ||
        componentEntries[p.value.trim().toLowerCase()]?.evidence
          .verification === "ambiguous" ||
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
    const modelProperties = values(["型号", "MODEL", "MODELSPEC"]);
    const propertyCategories = [
      ...(groundMaterial
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
      ? materialRule.materialRecognitionCode
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
    if (groundMaterial) typeCategory = materialRule.materialRecognitionCode;
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
        ...(groundMember
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
        ...(groundMember
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
  };
  const result = adapt();
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
    .map((value) => contextRule(canonicalSourceType(value)))
    .filter(Boolean);
  if (!role.some((p) => /独立|independent/i.test(p.value))) {
    if (!resolvedPart && rules.some((rule) => !rule.hostKind))
      result.equipmentMemberVariant = adapt(true);
    if (rules.some((rule) => rule.hostKind === "cabinet"))
      result.cabinetMemberVariant = adapt(true, true);
  }
  return result;
}
