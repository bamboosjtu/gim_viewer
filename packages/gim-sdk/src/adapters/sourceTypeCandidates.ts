import aliases from "../semantic/catalog/sourceCompatibilityPolicy.json";
import { canonicalSourceType } from "./sourceTypePolicy.js";
import type { SourceRecord } from "../shared/sourceRecord.js";
import type { EvidenceValue } from "../semantic/types.js";

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
  typeFields: readonly string[];
  typeProperties: EvidenceValue[];
  typeModels: EvidenceValue[];
  predefinedCategories: EvidenceValue[];
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
  const typeFields = TYPE_FIELDS;
  const typeProperties = values(typeFields);
  const modelKeys: string[] = [...MODEL_KEYS];
  if (record.track === "ifc")
    modelKeys.push("类型名称", "族与类型", "族名称", "结构材料", "结构材质");
  const typeModels = values(modelKeys);
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
    typeFields,
    typeProperties,
    typeModels,
    predefinedCategories,
  };
}
