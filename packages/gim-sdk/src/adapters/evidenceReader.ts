import { ENGINEERING_EVIDENCE_FIELDS } from "../shared/recognitionFieldPolicy.js";
import type { SourceRecord } from "../shared/sourceRecord.js";
import type { EvidenceValue } from "../semantic/types.js";

const recognitionKeys = new Set(ENGINEERING_EVIDENCE_FIELDS);
const empty = new Set(["", "-", "/", "-100", "软件自动生成"]);
const noEvidence: readonly EvidenceValue[] = [];

/**
 * Build the transient property reader for one source record.
 *
 * Only classification fields enter this index; raw properties stay intact and
 * evidence IDs keep their original path/line provenance.
 */
export function createValueReader(
  record: SourceRecord,
): (
  labels: readonly string[],
  skipDevFields?: boolean,
) => readonly EvidenceValue[] {
  const byKey = new Map<string, number[]>();
  record.properties.forEach((property, index) => {
    const keys = property.keys;
    if (!keys) return;
    for (const rawKey of keys) {
      const key = rawKey.toUpperCase();
      if (!recognitionKeys.has(key)) continue;
      if (empty.has(property.value.trim())) continue;
      const positions = byKey.get(key) ?? [];
      if (positions[positions.length - 1] !== index) positions.push(index);
      byKey.set(key, positions);
    }
  });
  const evidence = new Map<number, EvidenceValue>();
  return (labels, skipDevFields = false) => {
    if (!byKey.size) return noEvidence;
    const matched = labels.flatMap(
      (label) => byKey.get(label.toUpperCase()) ?? [],
    );
    if (!matched.length) return noEvidence;
    const positions =
      labels.length === 1
        ? matched
        : [...new Set(matched)].sort((a, b) => a - b);
    const filtered = skipDevFields
      ? positions.filter(
          (index) =>
            !/\.dev$/i.test(
              record.properties[index].path ??
                record.properties[index].source ??
                "",
            ),
        )
      : positions;
    return filtered.map((index) => {
      const p = record.properties[index];
      let value = evidence.get(index);
      if (!value) {
        value = {
          value: p.value,
          evidenceId: JSON.stringify([
            record.id,
            p.path ?? p.source,
            p.line ?? index,
            p.keys,
          ]),
          context: {
            section: p.section,
            container: p.containerId ?? p.source,
            rawContainerName: p.rawContainerName,
            applicability: p.applicability,
          },
        };
        evidence.set(index, value);
      }
      return value;
    });
  };
}
