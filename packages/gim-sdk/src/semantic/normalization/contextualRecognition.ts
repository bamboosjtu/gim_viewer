import { interpretRecognitionObject as interpretObject } from "../classify.js";
import type {
  EngineeringEntity,
  ObjectEvidence,
  ObjectInterpretation,
} from "../types.js";

/**
 * Contextual recognition, not ownership assignment.
 *
 * The same source object can be interpreted as an equipment member inside a
 * cabinet or equipment assembly, while an independent object keeps its base
 * interpretation. This stage only reinterprets the object; the ownership
 * strategy remains in ownershipResolver.
 */
export function contextualInterpretation(
  row: ObjectEvidence,
  current: ObjectInterpretation,
  parentEquipment: boolean,
  host: EngineeringEntity | undefined,
  parents: ReadonlySet<string | undefined>,
): ObjectInterpretation {
  if (!parentEquipment) return current;
  const cabinet =
    host !== undefined &&
    ["二次屏柜", "开关柜"].includes(host.standardClass?.catalogCategory ?? "");
  const variant = cabinet
    ? (row.cabinetMemberVariant ?? row.equipmentMemberVariant)
    : row.equipmentMemberVariant;
  return variant
    ? interpretObject(variant, parents.has(row.sourceId))
    : current;
}
