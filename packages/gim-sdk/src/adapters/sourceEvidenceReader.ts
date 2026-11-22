import type { SourceRecord } from "../shared/sourceRecord.js";
import type { SourceFormatFacts } from "../semantic/recognition/sourceFormatFacts.js";
import { createValueReader } from "./evidenceReader.js";
import { readSourceTypeDeclarations } from "./sourceTypeDeclarations.js";

const componentFields = ["COMPONENTTYPE", "部件类型"];
const vocabularyFields = [
  "SYSCLASSIFYNAME",
  "PARTNAME",
  "类型",
  "模型分类名称",
  "装置名称",
];
const contextualFields = [
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
];

/** Read one occurrence into named evidence groups from a single field index. */
export function readSourceFormatFacts(
  record: SourceRecord,
  sourceTypesComplete: boolean,
): SourceFormatFacts {
  const values = createValueReader(record);
  return {
    sourceTypesComplete,
    sourceType: readSourceTypeDeclarations(record, values),
    sourceId: record.id,
    name: record.name,
    names: record.nameEvidence,
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
    declaredHostSourceIds: record.attributeOnly
      ? record.relations
          ?.filter((relation) => relation.kind === "host")
          .map((relation) => ({
            value: relation.targetSourceId,
            evidenceId: relation.evidence,
          }))
      : [],
    roles: values(["对象角色", "组件角色", "OBJECTROLE", "COMPONENTROLE"]),
    purposes: values(["用途", "设备用途", "PURPOSE"]),
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
    componentTypeDeclarations: values(componentFields),
    keywordDeclarations: values([
      "SYSCLASSIFYNAME",
      "PARTNAME",
      "COMPONENTTYPE",
      "部件类型",
    ]),
    vocabularyDeclarations: vocabularyFields.flatMap((field) =>
      values([field]).map((property) => ({ field, property })),
    ),
    contextualDeclarations: values(contextualFields),
    materialDeclarations: values(["MATERIALTYPE", "材料类型"]),
    deviceNames: values(["设备名称", "DEVICENAME"]),
    modelProperties: values(["型号", "MODEL", "MODELSPEC"]),
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
    phases: values(["相数", "PHASECOUNT"]),
    phaseLabels: values(["相别", "PHASE", "PHASELABEL"]),
  };
}
