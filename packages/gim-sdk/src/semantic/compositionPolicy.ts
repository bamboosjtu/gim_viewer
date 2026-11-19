import policy from "./catalog/compositionPolicy.json";
import type {
  EngineeringEntity,
  ObjectEvidence,
  ObjectInterpretation,
} from "./types.js";

/** Product composition policy, distinct from standard term evidence. */
export const COMPOSITION_POLICY = policy;
export type HostCompatibility = "compatible" | "incompatible" | "unconfigured";
export function isEquipmentHost(
  host: Pick<EngineeringEntity, "category" | "recognitionCode">,
): boolean {
  return (host.recognitionCode ?? host.category).startsWith("E");
}
export function componentHostCompatibility(
  _meaning: { componentType?: { id?: string } },
  host: Pick<EngineeringEntity, "category" | "recognitionCode">,
): HostCompatibility {
  if (isEquipmentHost(host)) return "compatible";
  return !host.category || host.category === "U-OBJECT"
    ? "unconfigured"
    : "incompatible";
}
export const independentRole = (code: string) =>
  policy.independentRoles.includes(code) || code.startsWith("C-D");
export const separateInstallation = (code: string, host: string) =>
  (policy.separateInstallations.includes(code) && host.startsWith("E")) ||
  (code === "E09" && host === "E18") ||
  (host.startsWith("C") &&
    ((code.startsWith("C") && code !== host) || code.startsWith("E")));

/** A real assembly edge can retain an unclassified source as a candidate part.
 * Identity/type declarations still prevent an unknown independent object from
 * being swallowed. Display words never establish the relation. */
export function unclassifiedAssemblyCandidate(
  row: ObjectEvidence,
  meaning: ObjectInterpretation,
): boolean {
  return (
    policy.unclassifiedAssemblyMembers.status === "candidate" &&
    meaning.meaning === "object" &&
    !meaning.independent &&
    !meaning.conflict &&
    meaning.classificationStatus !== "confirmed" &&
    meaning.equipmentType?.status !== "confirmed" &&
    meaning.standardClass?.status !== "confirmed" &&
    (!row.typeCategory || row.typeCategory === "U-OBJECT") &&
    !row.propertyCategories?.length &&
    !row.identityCodes.length &&
    !row.designations.length
  );
}

export const COMPOSITION_SUBTYPE_COMPONENTS = new Set(
  policy.hostSubtypes.flatMap((rule) => [
    ...rule.requiresComponents,
    ...rule.conflictsWith,
  ]),
);
export const compositionSubtypeHost = (code: string) =>
  policy.hostSubtypes.some((rule) => rule.hostRecognitionCodes.includes(code));
export function compositionSubtype(
  entity: Pick<EngineeringEntity, "category" | "classificationStatus">,
  components: ReadonlyMap<string, readonly string[]> | undefined,
) {
  if (!components || entity.classificationStatus !== "confirmed")
    return undefined;
  const matches = policy.hostSubtypes.filter(
    (rule) =>
      rule.hostRecognitionCodes.includes(entity.category) &&
      rule.requiresComponents.every((id) => components.has(id)) &&
      !rule.conflictsWith.some((id) => components.has(id)),
  );
  if (matches.length !== 1) return undefined;
  const rule = matches[0];
  return {
    subtype: rule.id,
    subtypeLabel: rule.label,
    subtypeStatus: "confirmed" as const,
    subtypeEvidence: [
      `policy:${policy.version}:host-subtype:${rule.id}`,
      ...rule.requiresComponents.flatMap((id) => components.get(id) ?? []),
    ],
  };
}
