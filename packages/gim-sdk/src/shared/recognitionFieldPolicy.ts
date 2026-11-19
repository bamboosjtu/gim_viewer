import fields from "./recognitionFields.json";
/** Small immutable projection configuration; no source-file hashing. */
let hash = 2166136261;
for (const field of fields)
  for (const character of field + "\0")
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
export const RECOGNITION_FIELDS_FINGERPRINT = (hash >>> 0).toString(16);
export const ENGINEERING_EVIDENCE_FIELDS: readonly string[] = fields;
