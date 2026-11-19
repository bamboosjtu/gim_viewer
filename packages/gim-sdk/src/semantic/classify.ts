import { mainNumber } from "../shared/designation.js";
export { mainNumber } from "../shared/designation.js";
import { POLICY_CONTENT } from "./policyFingerprints.js";
import { independentRole } from "./compositionPolicy.js";
import { classificationDetails } from "./classificationDetails.js";
import type { ObjectEvidence, ObjectInterpretation } from "./types.js";
import {
  standardTermsFromName,
  standardEquipmentId,
  STANDARD_CATALOG_VERSION,
} from "./standardCatalog.js";
import {
  recognitionLabel as categoryLabel,
  publishDirectoryClassification,
  directoryRecognitionCode,
} from "./catalogClassification.js";
import { ENGINEERING_CATEGORIES } from "./catalog/catalogLabels.js";

export const ENGINEERING_RULES_VERSION = `recognition-evidence-policy-v1|${STANDARD_CATALOG_VERSION}|${POLICY_CONTENT}`;
export function normalizedObjectName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "");
}
const nameCategories = new Map<string, string>();
/** Catalog vocabulary supplies candidates only; it never establishes membership. */
export function categoryFromName(name: string): string {
  const old = nameCategories.get(name);
  if (old !== undefined) return old;
  const normalized = normalizedObjectName(name);
  const roles = new Set(
    standardTermsFromName(normalized).map((item) => item.recognitionCode),
  );
  if (!roles.size) {
    const matches = ENGINEERING_CATEGORIES.filter((row) =>
      normalized.includes(row.label),
    );
    const longest = Math.max(0, ...matches.map((row) => row.label.length));
    for (const row of matches)
      if (row.label.length === longest) {
        const code = directoryRecognitionCode(row.code);
        if (code) roles.add(code);
      }
  }
  const category = roles.size === 1 ? [...roles][0] : "U-OBJECT";
  if (name.length <= 128) {
    if (nameCategories.size >= 4096)
      nameCategories.delete(nameCategories.keys().next().value!);
    nameCategories.set(name, category);
  }
  return category;
}
export function explicitMain(object: ObjectEvidence): string {
  const tokens = new Set(
    object.designations.map((p) => mainNumber(p.value)).filter(Boolean),
  );
  return tokens.size === 1 ? [...tokens][0] : "";
}
export function isNumberedDesignation(value: string): boolean {
  const text = value.replace(
    /(?:AC|DC)?\d+(?:\.\d+)?\s*(?:kV|千伏)|模型\d+|\d+(?:[x×*]\d+)+/gi,
    "",
  );
  return /#\s*\d+|\d+\s*(?:号|#)|(?:主变|组合电器|避雷器|互感器|电抗器组|电容器组|开关柜|屏柜|设备|装置|支架|基础)\s*\d+(?![\p{L}\p{N}_])|[ⅠⅡⅢⅣⅤ]/u.test(
    text,
  );
}
const refinements: Record<string, string[]> = {
  "E-T": ["E01", "E03"],
  "E-R": ["E02", "E11"],
  E16: ["E16.panel_cabinet", "E16.control_cabinet"],
  "C-B4": ["C-B2", "C-B3", "C-B9"],
  "C-B5": ["C-B6", "C-B7"],
  "C-A1": ["C-C1", "C-C4"],
  "C-A2": ["C-C1", "C-C5", "C-B3"],
  "C-A5": ["C-C1", "M08"],
  "C-A4": ["C-A4.steel"],
  "C-A3": ["C-A3.steel"],
};
const compatible = (coarse: string, fine: string) =>
  coarse === fine || !!refinements[coarse]?.includes(fine);
const preferredFallbackName = (object: ObjectEvidence) => {
  const names = [...object.identityNames.map((p) => p.value), object.name];
  return (
    names.find(
      (value) =>
        /[\u3400-\u9fff]/.test(value) && categoryFromName(value) !== "U-OBJECT",
    ) ??
    names.find((value) => categoryFromName(value) !== "U-OBJECT") ??
    object.name
  );
};

function interpretClassification(
  object: ObjectEvidence,
  hasChildren = false,
): ObjectInterpretation {
  const name = object.name.trim();
  const componentTerms = new Set(
    object.componentTypeCandidates
      ?.filter((p) => p.confidence !== "candidate")
      .map((p) => p.value),
  );
  const typed =
    object.typeCategory ??
    (componentTerms.size === 1 && !object.standardClasses?.length
      ? "part"
      : undefined);
  const declaredRoles = new Set(object.objectRoles?.map((p) => p.value));
  const result = (
    meaning: ObjectInterpretation["meaning"],
    basis: string,
    category = "",
  ): ObjectInterpretation => ({
    category,
    meaning,
    basis,
    conflict: "",
    independent: false,
    classificationStatus: "unresolved",
    classificationEvidence: [],
  });
  const neutral = (
    basis: string,
    evidence: string[],
    confirmed = false,
  ): ObjectInterpretation => ({
    ...result("neutral_set", basis, "E01"),
    subtype: "neutral_set",
    subtypeLabel: "中性点成套装置",
    classificationStatus: confirmed ? "confirmed" : "candidate",
    classificationEvidence: evidence,
  });
  if (object.traits.nonphysical || declaredRoles.has("source_only"))
    return result("source_only", "nonphysical_or_interface");
  if (object.traits.fastener || declaredRoles.has("detail"))
    return result("detail", "internal_fastener");
  if (declaredRoles.has("container"))
    return result("container", "declared_container");
  if (declaredRoles.has("part") && declaredRoles.has("independent"))
    return {
      ...result("object", "attribute_conflict", "U-OBJECT"),
      conflict: "part!=independent",
    };
  if (typed === "part" && declaredRoles.has("independent"))
    return {
      ...result("object", "independent_component_role", "U-OBJECT"),
      independent: true,
    };
  if (typed === "part" || declaredRoles.has("part"))
    return {
      ...result(
        "part",
        "object_component_attribute",
        typed && typed !== "part" ? typed : "",
      ),
      classificationStatus:
        typed && typed !== "part" ? "confirmed" : "unresolved",
    };
  const properties = [
    ...new Set(object.propertyCategories?.map((p) => p.value) ?? []),
  ];
  const contexts = new Set(
    object.propertyCategories?.map((p) => JSON.stringify(p.context ?? {})) ??
      [],
  );
  if (contexts.size > 1 && properties.length > 1) {
    const category = typed && typed !== "neutral_set" ? typed : "U-OBJECT";
    return {
      ...result("object", "contextual_category_candidates", category),
      classificationStatus:
        category === "U-OBJECT" ? "unresolved" : "candidate",
      classificationEvidence:
        object.propertyCategories?.map((p) => p.evidenceId) ?? [],
    };
  }
  const validTyped = typed && typed !== "neutral_set" ? typed : undefined;
  const canRefine = (coarse: string, fine: string) =>
    compatible(coarse, fine) ||
    (coarse === validTyped && !!object.typeRefinements?.includes(fine));
  const hasIdentity = !!typed || properties.length > 0;
  if (object.traits.assemblyContainer && hasChildren && !hasIdentity)
    return result("container", "source_container");
  if (typed === "neutral_set")
    return neutral(
      "neutral_set_identity",
      [object.typeEvidenceId ?? `type:${object.sourceId}`],
      true,
    );
  let category = validTyped ?? "U-OBJECT",
    basis = validTyped ? "type" : "unknown",
    conflict = "";
  const evidence = validTyped
    ? [object.typeEvidenceId ?? `type:${object.sourceId}`]
    : [];
  for (const property of properties) {
    if (
      (category === "U-OBJECT" && basis === "unknown") ||
      canRefine(category, property)
    ) {
      category = property;
      basis = "object_attribute";
    } else if (!canRefine(property, category)) {
      conflict = [category, ...properties].join("!=");
      category = "U-OBJECT";
      basis = "attribute_conflict";
      break;
    }
  }
  if (properties.length)
    evidence.push(...object.propertyCategories!.map((p) => p.evidenceId));
  if (basis !== "attribute_conflict") {
    if (
      category === "U-OBJECT" &&
      object.allowNameFallback !== false &&
      !object.traits.luminaireTerminal
    ) {
      const fallbackName = preferredFallbackName(object),
        named = categoryFromName(fallbackName);
      const identities =
        named === "U-OBJECT"
          ? object.identityNames
              .map((p) => ({
                category: categoryFromName(p.value),
                evidence: p.evidenceId,
              }))
              .filter((p) => p.category !== "U-OBJECT")
          : [];
      category =
        named !== "U-OBJECT" ? named : (identities[0]?.category ?? "U-OBJECT");
      basis =
        named !== "U-OBJECT"
          ? fallbackName === name
            ? "object_name"
            : "family_identity_candidate"
          : identities.length
            ? "family_identity_candidate"
            : "unknown";
      evidence.push(
        ...object.identityNames
          .filter((p) => p.value === fallbackName)
          .map((p) => p.evidenceId),
      );
      evidence.push(
        ...(object.names
          ?.filter((n) => n.value === name)
          .map((n) => n.evidenceId) ?? [`name:${object.sourceId}`]),
        ...identities
          .filter((p) => p.category === category)
          .map((p) => p.evidence),
      );
    }
    if ((category === "E-T" || category === "E01") && explicitMain(object)) {
      category = "E01";
      evidence.push(...object.designations.map((p) => p.evidenceId));
    }
    if (category === "U-OBJECT" && object.traits.materialType) {
      category = "M09";
      basis = "material_type_fallback";
    }
  }
  const isIndependent =
    declaredRoles.has("independent") ||
    (hasIdentity && independentRole(category));
  const details = classificationDetails(category);
  return {
    ...result("object", basis, category),
    ...details,
    independent: basis === "attribute_conflict" ? false : isIndependent,
    conflict,
    classificationEvidence: [...new Set(evidence)],
    classificationStatus:
      category === "U-OBJECT"
        ? "unresolved"
        : category === "E-T" ||
            category === "C-B4" ||
            basis === "family_identity_candidate" ||
            basis === "material_type_fallback" ||
            conflict
          ? "candidate"
          : "confirmed",
    ...(basis === "attribute_conflict"
      ? { unknownReason: "conflicting_object_attributes" }
      : {}),
  };
}

/** Category, vocabulary type and engineering purpose have independent evidence. */
export function interpretRecognitionObject(
  object: ObjectEvidence,
  hasChildren = false,
): ObjectInterpretation {
  const result = interpretClassification(object, hasChildren);
  result.sourceName = object.name;
  const classes = object.standardClasses ?? [],
    unique = new Map(classes.map((c) => [c.id, c]));
  const perDeclaration = new Map<string, string>();
  const ambiguous = classes.some((item) => {
    const previous = perDeclaration.get(item.evidenceId);
    perDeclaration.set(item.evidenceId, item.id);
    return previous !== undefined && previous !== item.id;
  });
  if (ambiguous || object.vocabularyAmbiguities?.length) {
    result.category = "U-OBJECT";
    result.classificationStatus = "unresolved";
    result.basis = "standard_category_ambiguous";
    result.classificationEvidence = [
      ...new Set(classes.map((c) => c.evidenceId)),
    ];
  }
  if (unique.size === 1) {
    const item = [...unique.values()][0];
    result.standardClass = {
      ...item,
      status: classes.every((c) => c.confidence === "candidate")
        ? "candidate"
        : "confirmed",
      evidence: [...new Set(classes.map((c) => c.evidenceId))],
    };
    if (
      item.kind !== "equipment" &&
      item.label !== categoryLabel(result.category) &&
      (!result.subtype ||
        result.subtype === "unresolved" ||
        result.subtype === "body")
    ) {
      result.subtype = `standard:${item.id}`;
      result.subtypeLabel = item.label;
      if (
        [
          "material_subtype_evidence_insufficient",
          "equipment_subtype_evidence_insufficient",
        ].includes(result.unknownReason ?? "")
      )
        delete result.unknownReason;
    }
  } else if (
    !classes.length &&
    !object.typeCategory &&
    !object.propertyCategories?.length &&
    object.allowNameFallback !== false &&
    !object.traits.luminaireTerminal &&
    result.meaning === "object" &&
    result.basis !== "attribute_conflict"
  ) {
    const fallbackName = preferredFallbackName(object),
      names = standardTermsFromName(fallbackName);
    const namedCategory = categoryFromName(fallbackName);
    // A generic catalog substring (电缆) cannot replace a more specific head
    // already recognized in the full name (电缆桥架).
    if (
      names.length === 1 &&
      (namedCategory === "U-OBJECT" ||
        namedCategory === categoryFromName(names[0].label))
    ) {
      const item = names[0],
        evidenceId =
          object.names?.find((n) => n.value === fallbackName)?.evidenceId ??
          object.identityNames.find((p) => p.value === fallbackName)
            ?.evidenceId ??
          `name:${object.sourceId}`;
      result.standardClass = {
        ...item,
        kind: item.kind as "equipment" | "material" | "construction",
        value: item.term,
        evidenceId,
        status: "candidate",
        evidence: [evidenceId],
      };
      if (!object.typeCategory && !object.propertyCategories?.length) {
        if (!result.category.startsWith(`${item.recognitionCode}.`))
          result.category = item.recognitionCode;
        result.classificationStatus = "candidate";
        result.basis = "standard_name_candidate";
      }
      if (item.kind === "equipment" && !object.equipmentTypeCandidates?.length)
        result.equipmentType = {
          id: standardEquipmentId(item),
          status: "candidate",
          evidence: [evidenceId],
        };
    }
  }
  if (object.vocabularyAmbiguities?.length) {
    result.category = "U-OBJECT";
    result.classificationStatus = "unresolved";
    result.basis = "vocabulary_namespace_ambiguous";
    result.independent = false;
  }
  if (object.vocabularyObservations?.length)
    result.vocabularyObservations = object.vocabularyObservations;
  if (
    result.basis.includes("name") ||
    result.basis === "family_identity_candidate" ||
    result.basis === "type+object_identity"
  )
    result.classificationStatus =
      result.category === "U-OBJECT" ? "unresolved" : "candidate";
  const purposes = [...new Set(object.purposes?.map((p) => p.value) ?? [])];
  result.purpose =
    purposes.length === 1
      ? {
          id: purposes[0],
          status: "confirmed",
          evidence: object.purposes!.map((p) => p.evidenceId),
        }
      : ["E01", "E-T", "E03"].includes(result.category) && explicitMain(object)
        ? {
            id: "main_transformer",
            status: "confirmed",
            evidence: object.designations.map((p) => p.evidenceId),
          }
        : { status: "unresolved", evidence: [] };
  if (
    result.purpose.status === "confirmed" &&
    ["E01", "E03"].includes(result.category) &&
    !result.conflict
  )
    result.classificationStatus = "confirmed";
  if (purposes.length > 1) {
    const contexts = new Set(
      object.purposes?.map((p) => JSON.stringify(p.context ?? {})),
    );
    if (contexts.size > 1) {
      result.category = object.typeCategory ?? "U-OBJECT";
      result.basis = "contextual_purpose_candidates";
      result.classificationStatus =
        result.category === "U-OBJECT" ? "unresolved" : "candidate";
      result.purpose = {
        status: "unresolved",
        evidence: object.purposes!.map((p) => p.evidenceId),
      };
    } else {
      result.category = "U-OBJECT";
      result.basis = "attribute_conflict";
      result.conflict = "engineering_purpose_conflict";
      result.classificationStatus = "unresolved";
    }
  }
  const equipmentCandidates = object.equipmentTypeCandidates ?? [],
    componentCandidates = object.componentTypeCandidates ?? [];
  if (new Set(equipmentCandidates.map((p) => p.value)).size === 1)
    result.equipmentType = {
      id: equipmentCandidates[0].value,
      status: equipmentCandidates.every((p) => p.confidence === "candidate")
        ? "candidate"
        : "confirmed",
      evidence: [...new Set(equipmentCandidates.map((p) => p.evidenceId))],
    };
  if (new Set(componentCandidates.map((p) => p.value)).size === 1)
    result.componentType = {
      id: componentCandidates[0].value,
      status: componentCandidates.every((p) => p.confidence === "candidate")
        ? "candidate"
        : "confirmed",
      evidence: [...new Set(componentCandidates.map((p) => p.evidenceId))],
    };
  if (new Set(equipmentCandidates.map((p) => p.value)).size > 1) {
    result.equipmentType = {
      status: "unresolved",
      evidence: equipmentCandidates.map((p) => p.evidenceId),
    };
    const contexts = new Set(
      equipmentCandidates.map((p) => JSON.stringify(p.context ?? {})),
    );
    result.category =
      contexts.size > 1 ? (object.typeCategory ?? "U-OBJECT") : "U-OBJECT";
    result.classificationStatus =
      result.category === "U-OBJECT" ? "unresolved" : "candidate";
    result.basis =
      contexts.size > 1 ? "contextual_type_candidates" : "attribute_conflict";
    result.conflict = contexts.size > 1 ? "" : "equipment_type_conflict";
  }
  if (new Set(componentCandidates.map((p) => p.value)).size > 1) {
    result.componentType = {
      status: "unresolved",
      evidence: componentCandidates.map((p) => p.evidenceId),
    };
    result.conflict = "component_type_conflict";
    result.classificationStatus =
      result.category && result.category !== "U-OBJECT"
        ? "candidate"
        : "unresolved";
  }
  // A vocabulary lookup is not proof that its mapping was checked against the standard.
  if (
    result.classificationStatus === "confirmed" &&
    !object.typeCategory &&
    object.propertyCategories?.length &&
    object.propertyCategories.every((p) => p.confidence === "candidate")
  )
    result.classificationStatus = "candidate";
  result.categoryStatus = result.classificationStatus ?? "unresolved";
  const roleEvidence = [
    ...new Set([
      ...(object.objectRoles?.map((p) => p.evidenceId) ?? []),
      ...(object.typeCategory === "part"
        ? [
            ...(object.componentTypeCandidates?.map((p) => p.evidenceId) ?? []),
            ...(object.typeEvidenceId ? [object.typeEvidenceId] : []),
          ]
        : []),
    ]),
  ];
  result.objectRole = {
    id: result.meaning,
    status:
      result.basis === "attribute_conflict"
        ? "unresolved"
        : roleEvidence.length ||
            object.traits.nonphysical ||
            object.traits.fastener ||
            object.typeCategory === "part"
          ? "confirmed"
          : "candidate",
    evidence: roleEvidence,
  };
  return result;
}

/** Public classification uses only workbook family codes; purpose stays independent. */
export function interpretObject(
  object: ObjectEvidence,
  hasChildren = false,
): ObjectInterpretation {
  const result = interpretRecognitionObject(object, hasChildren);
  return publishDirectoryClassification(result);
}
