import type { SourceRecord } from "./sourceRecord.js";
import type { EngineeringSourceGraph } from "../source/sourceGraph.js";

export function engineeringSourceRecords(
  graph: EngineeringSourceGraph,
  extra: readonly SourceRecord[] = [],
): SourceRecord[] {
  return [...graph.records, ...(graph.attributeRecords ?? []), ...extra];
}
