import type { SourceAlias } from "../shared/contracts.js";
import type { EntryIndex } from "./entryResolver.js";
import { visitCbmOccurrence } from "./graph/cbmOccurrenceTraversal.js";
import {
  compareSourcePaths,
  createSourceGraphContext,
  type SourceGraphOptions,
} from "./graph/sourceGraphContext.js";
import type { SourceDocument } from "./sourceDocuments.js";
import type { SourceRecord } from "./sourceEvidence.js";
import type { SourceReference } from "./sourceReferenceResolver.js";

export type { SourceDocument } from "./sourceDocuments.js";
export type { SourceReference } from "./sourceReferenceResolver.js";
export { materializeEngineeringFamilies } from "./sourceFamilyIndex.js";

export interface SourceFileReader {
  /** Actual archive paths, including files not reached by CBM GUID references. */
  paths: readonly string[];
  entryIndex?: EntryIndex;
  readDocument?(path: string): Promise<SourceDocument>;
  prefetchDocuments?(paths: readonly string[]): void;
  readText(path: string): Promise<string>;
}
export interface CbmOccurrence {
  id: string;
  documentPath: string;
  parentId: string | null;
  viaField: string;
  relationKind?: "organization" | "composition";
  /** Original GIM entity level, used only for the source view. */
  entityName?: string;
}
export interface EngineeringSourceGraph {
  revision?: number;
  familyAssignments?: Array<{ sourceId: string; path: string }>;
  documents: SourceDocument[];
  cbmOccurrences: CbmOccurrence[];
  records: SourceRecord[];
  attributeRecords?: SourceRecord[];
  aliases: SourceAlias[];
  references: SourceReference[];
  /** File discovery is independent of IFCGUID joins. */
  ifcPaths: string[];
  diagnostics: Array<{
    kind: "cycle" | "missing-object-model" | "read-failed" | "ambiguous-field";
    source: string;
    field?: string;
    lines?: number[];
  }>;
}

/** Logical attribute sources and physical sources have independent addresses. */
export { engineeringSourceRecords } from "../shared/sourceRecordSelectors.js";

/** No use of CbmNode, current UI grain, F-levels or geometry seed predicates. */
export async function extractEngineeringSourceGraph(
  files: SourceFileReader,
  options: SourceGraphOptions = {},
): Promise<EngineeringSourceGraph> {
  const result: EngineeringSourceGraph = {
    documents: [],
    cbmOccurrences: [],
    records: [],
    aliases: [],
    references: [],
    ifcPaths: files.paths
      .filter((p) => /\.ifc$/i.test(p))
      .sort(compareSourcePaths),
    diagnostics: [],
    familyAssignments: [],
  };
  options.onProgress?.("source-index");
  const context = createSourceGraphContext(files, options, result);
  const root = context.resolve("", "project-entry", "project.cbm");
  if (!root)
    throw new Error("Engineering source graph requires a unique project.cbm");
  options.onProgress?.("source-traverse");
  await visitCbmOccurrence(
    context,
    root,
    `cbm:${root}`,
    null,
    "",
    new Set(),
    [],
    0,
  );
  if (options.signal?.aborted)
    throw new DOMException("Source extraction cancelled", "AbortError");
  options.onProgress?.("source-sort");
  result.documents.sort((a, b) => compareSourcePaths(a.path, b.path));
  result.revision = 1;
  result.familyAssignments!.push(...context.families.assignments);
  return result;
}
