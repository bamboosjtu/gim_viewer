import { isIfcFeatureSourceType } from "../../shared/ifcFeatureSourceType.js";
import proxyCategories from "../catalog/proxyCategories.json";
import aliases from "../catalog/sourceCompatibilityPolicy.json";
import { standardTerms } from "../standardCatalog.js";
import type { EvidenceValue } from "../types.js";
import type { SourceFormatFacts } from "./sourceFormatFacts.js";
import {
  cabinetModelType,
  canonicalSourceType,
  ifcModelType,
  isTypeDeclaration,
} from "./sourceTypePolicy.js";

const devTypes: Readonly<Record<string, string>> = aliases.dev;
const ifcTypes: Readonly<Record<string, string>> = aliases.ifc;
const structuredTypes: Readonly<Record<string, string>> = aliases.structured;
const cabinetFamilyTypes: Readonly<Record<string, string>> =
  aliases.cabinetTypeWithFamilyName;
const predefinedTypes: Readonly<Record<string, string>> = aliases.ifcPredefined;
const authoredCategories: Readonly<Record<string, string>> =
  proxyCategories.categories;
const genericRoadTypes = new Set(["road", "道路", "ifcroad"]);
const emptyEvidence: readonly EvidenceValue[] = [];

export const sourceCategoryAlias = (value: string): string | undefined =>
  structuredTypes[value.trim()] ??
  devTypes[value.toLowerCase()] ??
  ifcTypes[value.toUpperCase()];

export const compatibilityCategoryAlias = (value: string): string | undefined =>
  devTypes[value.trim().toLowerCase()] ?? ifcTypes[value.trim().toUpperCase()];

/** Interpret occurrence-wide type evidence once, before contextual decisions. */
export function resolveSourceType(
  facts: SourceFormatFacts,
  completeNeutralAssembly: boolean,
) {
  const source = facts.sourceType;
  const rawType = source.declaration.value.trim().toLowerCase();
  const type = completeNeutralAssembly
    ? "NeutralPointEquipment"
    : canonicalSourceType(source.declaration.value);
  const canonicalEvidenceId = `${facts.sourceId}:source_type:${type}`;
  const normalize = (p: EvidenceValue): EvidenceValue => {
    const value =
      completeNeutralAssembly && p.value.trim().toLowerCase() === rawType
        ? "NeutralPointEquipment"
        : canonicalSourceType(p.value);
    return value === p.value ? p : { ...p, value };
  };
  const models = source.models.flatMap((p) => {
    const value = standardTerms(p.value).length
      ? p.value
      : (cabinetModelType(p.value) ??
        (source.modelDialect === "ifc"
          ? ifcModelType(type, p.value)
          : undefined));
    return value ? [{ ...p, value }] : [];
  });
  const predefinedCategories = source.predefinedTypes.flatMap((p) => {
    const value = predefinedTypes[`${type}.${p.value.trim().toUpperCase()}`];
    return value ? [{ ...p, value }] : [];
  });
  let cabinetAlias = cabinetFamilyTypes[type.trim().toLowerCase()];
  if (!cabinetAlias) {
    for (const { value } of source.properties) {
      cabinetAlias = cabinetFamilyTypes[value.trim().toLowerCase()];
      if (cabinetAlias) break;
    }
  }
  const cabinetFamilyName =
    cabinetAlias && !models.length
      ? source.cabinetNames.find((p) => /[柜屏]/.test(p.value))
      : undefined;
  let cabinetNameDeclaration: EvidenceValue | undefined;
  if (type.trim().toLowerCase() === "secondarycabinet") {
    for (const p of [
      ...facts.identityNames,
      ...(facts.names ?? []),
      { value: facts.name, evidenceId: `name:${facts.sourceId}` },
    ]) {
      const value = cabinetModelType(p.value);
      if (value) {
        cabinetNameDeclaration = { ...p, value, confidence: "candidate" };
        break;
      }
    }
  }
  const genericProxy = type === "IFCBUILDINGELEMENTPROXY";
  const pumpOrValve = type === "IFCPUMP" || type === "IFCVALVE";
  const refinements = pumpOrValve
    ? ["C-D5"]
    : ["IFCBEAM", "IFCBEAMSTANDARDCASE"].includes(type)
      ? ["C-A4.steel"]
      : ["IFCCOLUMN", "IFCCOLUMNSTANDARDCASE"].includes(type)
        ? ["C-A3.steel"]
        : type === "IFCMEMBER"
          ? ["C-A14", "C-A3", "C-A4", "C-B5", "C-B7"]
          : [];
  return {
    declaration: normalize({ ...source.declaration, value: type }),
    canonicalEvidenceId,
    compatibilityCategory: devTypes[type.toLowerCase()],
    exactFallbackCategory: ifcTypes[type],
    fallbackCategory: ifcTypes[type.toUpperCase()],
    hasTypeProperties: source.supplementalTypeProperties.some((p) =>
      isTypeDeclaration(p.value),
    ),
    properties: source.properties.map(normalize),
    models: models.map(normalize),
    keywordDeclarations: facts.keywordDeclarations.map((p) => ({
      rawValue: p.value,
      declaration: normalize(p),
    })),
    fineCabinetModel: models.some(
      (p) =>
        p.value === "MeasurementAndControlCabinet" ||
        p.value === "ProtectionCabinet",
    ),
    predefinedCategories,
    cabinetFamilyDeclaration: cabinetFamilyName
      ? normalize({ ...cabinetFamilyName, value: cabinetAlias })
      : undefined,
    cabinetNameDeclaration,
    roadPositions: genericRoadTypes.has(
      type.trim().normalize("NFKC").toLowerCase(),
    )
      ? source.roadPositions
      : emptyEvidence,
    authoringCategories: genericProxy
      ? source.authoringCategories.flatMap((p) => {
          const value = authoredCategories[p.value.trim()];
          return value ? [{ ...p, value }] : [];
        })
      : emptyEvidence,
    useCategoryLabel:
      genericProxy &&
      /^(?:代理构件|IfcBuildingElementProxy)$/i.test(facts.name),
    drainageCategory: pumpOrValve ? "C-D5" : undefined,
    impliedPurpose: /^stationtransformer$/i.test(type)
      ? {
          value: "station_service_transformer",
          evidenceId: canonicalEvidenceId,
        }
      : undefined,
    impliedRole:
      type === "IFCPILE"
        ? {
            value: "part",
            evidenceId: `${facts.sourceId}:pile_foundation_component`,
          }
        : undefined,
    refinements,
    traits: {
      fastener: ["IFCMECHANICALFASTENER", "IFCFASTENER"].includes(type),
      assemblyContainer: type === "IFCELEMENTASSEMBLY" || genericProxy,
      nonphysical: isIfcFeatureSourceType(type),
    },
    luminaireDeclaration: /端子板\s*$/.test(facts.name)
      ? source.properties.find((p) => p.value.trim().toUpperCase() === "LED")
      : undefined,
  };
}
