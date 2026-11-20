import type { FamSourceProperty } from "../parser/fam.js";
import { isGimEmptyValue } from "../parser/values.js";

/**
 * Candidate business identity is source evidence, never a synthesized code.
 * This interpretation belongs to the source layer, not to the FAM parser.
 */
export function resolveSubstationBusinessIdentity(
  properties: readonly FamSourceProperty[],
) {
  const kinds = [
    "三维设计模型编码",
    "电网工程标识系统编码",
    "设备编码",
    "调度编码",
    "实物ID",
  ];
  for (const kind of kinds) {
    const property = properties.find(
      (p) =>
        (p.label === kind || p.rawKey === kind) && !isGimEmptyValue(p.rawValue),
    );
    if (property)
      return {
        value: property.rawValue,
        kind,
        source: {
          path: property.sourcePath,
          key: property.rawKey,
          section: property.section,
        },
      };
  }
  return null;
}
