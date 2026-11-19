import policy from "./catalog/sourceCompatibilityPolicy.json";
import { standardCatalogItem, standardTerms } from "./standardCatalog.js";
import type { EvidenceValue } from "./types.js";

const orderedTypes = new Map<string, string>(
  Object.entries(policy.orderedTypeValues),
);
const defaults = new Map<string, string>(Object.entries(policy.typeDefaults));
const key = (value: string) => value.trim().normalize("NFKC").toLowerCase();
const neutralNames = new Set([
  "消弧线圈及接地变压器成套装置",
  "消弧线圈/接地变压器成套装置",
  "中性点接地成套装置",
]);
const coarseRoadNames = new Set(["road", "道路", "ifcroad"]);
const nonTypes = new Set([
  "",
  "-",
  "—",
  "/",
  "-100",
  "软件自动生成",
  "暂无",
  "无",
  "通用",
  "标准",
  "默认",
  "其他",
  "others",
  "unknown",
  "null",
  "none",
  "notdefined",
  "userdefined",
]);

export function isTypeDeclaration(value: string): boolean {
  const word = key(value);
  return !nonTypes.has(word) && !/^[\d\s.+*x×/：:毫米米kva]+$/i.test(word);
}

/** Resolve only recorded lists and complete, recognizable slash declarations.
 * Catalog aliases and opaque vendor strings (including semicolons) stay whole. */
export function canonicalSourceType(value: string): string {
  const explicit = orderedTypes.get(key(value));
  if (explicit) return explicit;
  if (neutralNames.has(value.trim())) return "NeutralPointEquipment";
  if (!value.includes("/") || standardTerms(value).length) return value;
  const words = value.split("/").map((part) => part.trim());
  return words.every((word) => standardTerms(word).length === 1)
    ? words[0]
    : value;
}

export function applyTypeDefaults(
  declarations: readonly EvidenceValue[],
): readonly EvidenceValue[] {
  if (!declarations.some((p) => defaults.has(key(p.value))))
    return declarations;
  const explicitFamilies = new Set(
    declarations
      .filter((p) => !defaults.has(key(p.value)))
      .flatMap((p) => standardTerms(p.value).map((item) => item.category)),
  );
  return declarations.flatMap((p) => {
    const id = defaults.get(key(p.value));
    const fallback = id && standardCatalogItem(id);
    if (!fallback) return [p];
    const genericSwitchCabinet =
      fallback.catalogCategory === "开关柜" && explicitFamilies.has("E17");
    return explicitFamilies.has(fallback.category) || genericSwitchCabinet
      ? []
      : [{ ...p, value: fallback.term }];
  });
}

/** Cabinet model is an object-owned type field, separate from its display name. */
export function cabinetModelType(value: string): string | undefined {
  if (/保护/.test(value) && /测控/.test(value)) return undefined;
  const measurement = /测控柜|测控屏/.test(value),
    protection = /保护(?:[ABＡＢ])?[柜屏]/i.test(value);
  if (measurement === protection) return undefined;
  return measurement ? "MeasurementAndControlCabinet" : "ProtectionCabinet";
}

/** The input is an IFC type/model property, never the object's display name. */
export function ifcModelType(
  ifcType: string,
  value: string,
): string | undefined {
  const parts = value.split(/[:：]/).map((part) => part.trim());
  for (const part of parts) {
    if (
      /^IFCBEAM(?:STANDARDCASE)?$/.test(ifcType) &&
      /^(?:钢|steel)$|钢梁/i.test(part)
    )
      return "SteelBeam";
    if (
      /^IFCCOLUMN(?:STANDARDCASE)?$/.test(ifcType) &&
      /^(?:钢|steel)$|钢柱/i.test(part)
    )
      return "SteelColumn";
    if (
      /^IFC(?:DUCTSEGMENT|DUCTFITTING|FLOWSEGMENT|FLOWFITTING)$/.test(
        ifcType,
      ) &&
      /风管$/.test(part) &&
      !/风机/.test(part)
    )
      return "Airduct";
    if (ifcType === "IFCBUILDINGELEMENTPROXY") {
      if (/^(?:户内|户外|室内|室外)?照明箱$/.test(part)) return "LightingBox";
      if (/^(?:户内|户外|室内|室外)?检修箱(?:模型\d+)?$/.test(part))
        return "MaintenanceBox";
      if (/^事故油池$/.test(part)) return "OilPool";
    }
  }
  return undefined;
}

/** Positions are declared by the source adapter. Missing/crossing/contradictory
 * boundary evidence keeps a generic road at the family level. */
export function roadPositionType(
  type: string,
  positions: readonly EvidenceValue[],
): EvidenceValue | undefined {
  if (!coarseRoadNames.has(key(type)) || !positions.length) return undefined;
  const id = (value: string) =>
    /^(?:站内|围墙内|inside)$/i.test(value.trim())
      ? "StationInRoadWays"
      : /^(?:站外|围墙外|outside)$/i.test(value.trim())
        ? "StationOutRoadWays"
        : undefined;
  const value = id(positions[0].value);
  if (value && positions.every((p) => id(p.value) === value))
    return { ...positions[0], value };
  return undefined;
}
