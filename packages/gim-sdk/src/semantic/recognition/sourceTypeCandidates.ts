import aliases from "../catalog/sourceCompatibilityPolicy.json";
import { standardTerms } from "../standardCatalog.js";
import {
  cabinetModelType,
  canonicalSourceType,
  ifcModelType,
} from "../sourceTypePolicy.js";
import { directoryRecognitionCode } from "../catalogClassification.js";
import type { SourceRecord } from "../../shared/sourceRecord.js";
import type { EvidenceValue } from "../types.js";

export const TYPE_FIELDS = [
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
] as const;

export const MODEL_KEYS = [
  "屏柜型号",
  "设备型号",
  "型号",
  "MODEL",
  "MODELSPEC",
] as const;

export interface SourceTypeCandidates {
  rawType: string;
  sourceTypeEvidenceId: string;
  type: string;
  devTypes: Readonly<Record<string, string>>;
  ifcTypes: Readonly<Record<string, string>>;
  standardTypes: ReturnType<typeof standardTerms>;
  devCategory: string | undefined;
  typeFields: readonly string[];
  typeProperties: EvidenceValue[];
  typeModels: EvidenceValue[];
  fineCabinetModel: boolean;
  predefinedCategories: EvidenceValue[];
  categoryValue: (value: string) => string;
}

/** Read only source type/model declarations; business identity stays downstream. */
export function sourceTypeCandidates(
  record: SourceRecord,
  values: (
    labels: readonly string[],
    skipDevFields?: boolean,
  ) => EvidenceValue[],
  completeNeutralAssembly: boolean,
): SourceTypeCandidates {
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
    return "U-OBJECT";
  };
  const typeFields = TYPE_FIELDS;
  const typeProperties = values(typeFields);
  const modelKeys: string[] = [...MODEL_KEYS];
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
  return {
    rawType,
    sourceTypeEvidenceId,
    type,
    devTypes,
    ifcTypes,
    standardTypes,
    devCategory,
    typeFields,
    typeProperties,
    typeModels,
    fineCabinetModel,
    predefinedCategories,
    categoryValue,
  };
}
