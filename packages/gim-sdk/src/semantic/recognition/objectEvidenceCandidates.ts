import recognitionPolicy from "../catalog/recognitionPolicy.json";
import aliases from "../catalog/sourceCompatibilityPolicy.json";
import { directoryRecognitionCode } from "../catalogClassification.js";
import { standardTerms } from "../standardCatalog.js";
import type {
  SourceEvidenceFacts,
  SourceEvidenceOptions,
} from "./sourceEvidenceFacts.js";
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

export function prepareObjectDecision(
  facts: SourceEvidenceFacts,
  options: SourceEvidenceOptions,
) {
  const { sourceTypesComplete, completeNeutralAssembly } = options;
  const record = facts.record;
  const values = facts.values;
  const {
    rawType,
    sourceTypeEvidenceId,
    type,
    devTypes,
    ifcTypes,
    typeFields,
    typeProperties,
    predefinedCategories,
  } = facts;
  const normalize = facts.normalize;
  const typeModels = facts.typeModels.flatMap((p) => {
    const value = standardTerms(p.value).length
      ? p.value
      : (normalize.cabinetModelType(p.value) ??
        (record.track === "ifc"
          ? normalize.ifcModelType(type, p.value)
          : undefined));
    return value ? [{ ...p, value }] : [];
  });
  const fineCabinetModel = typeModels.some(
    (model) =>
      model.value === "MeasurementAndControlCabinet" ||
      model.value === "ProtectionCabinet",
  );
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
    return "U-OBJECT";
  };
  return {
    record,
    values,
    rawType,
    sourceTypeEvidenceId,
    type,
    devTypes,
    ifcTypes,
    typeFields,
    typeProperties,
    predefinedCategories,
    normalize,
    typeModels,
    fineCabinetModel,
    standardTypes,
    devCategory,
    categoryValue,
    sourceTypesComplete,
    completeNeutralAssembly,
  };
}

export type ObjectDecision = ReturnType<typeof prepareObjectDecision>;

export function resolveObjectCandidates(
  decision: ObjectDecision,
  equipmentMember: boolean,
  cabinetMember: boolean,
) {
  const {
    record,
    values,
    type,
    typeProperties,
    typeModels,
    fineCabinetModel,
    normalize,
    predefinedCategories,
    sourceTypesComplete,
    typeFields,
    sourceTypeEvidenceId,
    completeNeutralAssembly,
    rawType,
  } = decision;
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
      normalize.isTypeDeclaration(p.value),
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
          : normalize.canonicalSourceType(p.value);
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
  const material = resolveMaterial({
    declarations,
    materialDeclarations: values(["MATERIALTYPE", "材料类型"]).filter(
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
    allowNameFallback &&
    type.trim().toLowerCase() === "secondarycabinet" &&
    !componentDeclarations.length
      ? [
          ...values(["设备名称", "DEVICENAME", "工程中名称", "PROJECTNAME"]),
          ...(record.nameEvidence ?? []),
          { value: record.name, evidenceId: `name:${record.id}` },
        ].find((p) => normalize.cabinetModelType(p.value))
      : undefined;
  const catalogDeclarations = cabinetNameCandidate
    ? [
        {
          ...cabinetNameCandidate,
          value: normalize.cabinetModelType(cabinetNameCandidate.value)!,
          confidence: "candidate" as const,
        },
      ]
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
