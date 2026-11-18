import type { SourceRecord } from "../../shared/sourceRecord.js";
import type { EngineeringSourceGraph } from "./sourceGraph.js";

export function engineeringSourceRecords(
  graph: EngineeringSourceGraph,
  extra: readonly SourceRecord[] = [],
): SourceRecord[] {
  return [...graph.records, ...(graph.attributeRecords ?? []), ...extra];
}
