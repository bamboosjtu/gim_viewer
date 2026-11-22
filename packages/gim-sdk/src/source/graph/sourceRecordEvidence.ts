import type { ObjectNameEvidence } from "../../shared/contracts.js";
import { ENGINEERING_EVIDENCE_FIELDS } from "../recognitionFieldPolicy.js";
import type { SourceDocument } from "../sourceDocuments.js";
import type { SourceRecord } from "../sourceEvidence.js";

const objectKeys = new Set(
  [...ENGINEERING_EVIDENCE_FIELDS, "SYMBOLNAME", "NAME", "OBJECTNAME"].map(
    (key) => key.toUpperCase(),
  ),
);

/** Only attach object fields from documents associated with the occurrence. */
export function objectFields(doc: SourceDocument) {
  return doc.fields.filter((p) => objectKeys.has(p.keys[0].toUpperCase()));
}

export function updateSourceNames(row: SourceRecord): void {
  const names: ObjectNameEvidence[] = [];
  for (const [kind, labels] of [
    ["object", ["SYMBOLNAME"]],
    ["engineering", ["工程中名称", "PROJECTNAME"]],
    ["family", ["设备名称", "DEVICENAME"]],
    ["source", ["NAME", "OBJECTNAME", "PARTNAME"]],
  ] as const) {
    for (const p of row.properties)
      if (
        p.keys?.some((k) =>
          (labels as readonly string[]).includes(k.toUpperCase()),
        ) &&
        p.value.trim() &&
        !["-", "/", "-100", "软件自动生成"].includes(p.value.trim())
      ) {
        names.push({
          kind,
          value: p.value,
          evidenceId: JSON.stringify([row.id, p.path, p.line, p.keys]),
        });
      }
  }
  row.nameEvidence = names;
  row.name = names[0]?.value ?? "";
}
