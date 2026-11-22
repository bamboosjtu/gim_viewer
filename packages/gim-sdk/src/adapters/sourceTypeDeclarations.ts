import type { SourceRecord } from "../shared/sourceRecord.js";
import type {
  SourceTypeDeclarations,
  SourceTypeObservation,
} from "../semantic/recognition/sourceFormatFacts.js";
import type { createValueReader } from "./evidenceReader.js";

const TYPE_FIELDS = [
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

const MODEL_KEYS = [
  "屏柜型号",
  "设备型号",
  "型号",
  "MODEL",
  "MODELSPEC",
] as const;

const IFC_MODEL_KEYS = [
  ...MODEL_KEYS,
  "类型名称",
  "族与类型",
  "族名称",
  "结构材料",
  "结构材质",
] as const;

export function readSourceTypeDeclarations(
  record: SourceRecord,
  values: ReturnType<typeof createValueReader>,
): SourceTypeDeclarations {
  const properties = values(TYPE_FIELDS);
  return {
    declaration: {
      value: record.source_type,
      evidenceId: `${record.id}:source_type:${record.source_type}`,
    },
    modelDialect: record.track,
    properties,
    supplementalTypeProperties:
      record.track === "dev" ? values(TYPE_FIELDS, true) : properties,
    models: values(record.track === "ifc" ? IFC_MODEL_KEYS : MODEL_KEYS),
    predefinedTypes: values(["IFC.PredefinedType"]),
    cabinetNames: values(["屏柜名称"]),
    roadPositions: values(["道路位置", "围墙关系", "STATIONFENCERELATION"]),
    authoringCategories: values(["类别(Category)", "类别", "Category"]),
  };
}

export function readSourceTypeObservation(
  record: SourceRecord,
): SourceTypeObservation {
  return {
    sourceId: record.id,
    declaredType: record.source_type,
    physicalParentId:
      record.track === "dev" ? record.parent || undefined : undefined,
  };
}
