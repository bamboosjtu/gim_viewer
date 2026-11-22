import { createEntryIndex } from "../entryResolver.js";
import { SourceDocumentReader } from "../sourceDocumentReader.js";
import type { SourceDocument } from "../sourceDocuments.js";
import { SourceFamilyIndex } from "../sourceFamilyIndex.js";
import type {
  EngineeringSourceGraph,
  SourceFileReader,
} from "../sourceGraph.js";
import { createSourceReferenceResolver } from "../sourceReferenceResolver.js";
import { PhysicalScopeIndex } from "./physicalScopeIndex.js";

export interface SourceGraphOptions {
  deferFamilies?: boolean;
  maxOccurrences?: number;
  maxDepth?: number;
  signal?: AbortSignal;
  onProgress?: (
    stage: "source-index" | "source-traverse" | "source-sort",
  ) => void;
}

export const compareSourcePaths = (a: string, b: string) =>
  a < b ? -1 : a > b ? 1 : 0;

/** One set of caches, counters and evidence collections for both traversals. */
export function createSourceGraphContext(
  files: SourceFileReader,
  options: SourceGraphOptions,
  result: EngineeringSourceGraph,
) {
  const maxOccurrences = options.maxOccurrences ?? 500_000;
  const maxDepth = options.maxDepth ?? 128;
  const entryIndex =
    files.entryIndex ??
    createEntryIndex([...files.paths].sort(compareSourcePaths));
  const prefetch = (
    doc: SourceDocument,
    fields: SourceDocument["fields"],
    offset = 0,
  ) => {
    files.prefetchDocuments?.(
      fields.slice(offset, offset + 256).flatMap((field) => {
        const target = entryIndex.resolve(field.value, doc.path);
        return target ? [target] : [];
      }),
    );
  };
  const references = createSourceReferenceResolver(
    entryIndex,
    result.references,
    (diagnostic) => result.diagnostics.push(diagnostic),
  );
  const reader = new SourceDocumentReader(files);
  result.documents = reader.documents;
  const document = (path: string): Promise<SourceDocument> =>
    reader.document(path);
  const families = new SourceFamilyIndex({
    readDocument: document,
    resolveReference: references.resolve,
    deferFamilies: options.deferFamilies,
  });
  let lastProgressCount = 0;
  function check(depth: number) {
    const count = result.records.length + result.cbmOccurrences.length;
    if (count - lastProgressCount >= 512) {
      lastProgressCount = count;
      options.onProgress?.("source-traverse");
    }
    if (options.signal?.aborted)
      throw new DOMException("Source extraction cancelled", "AbortError");
    if (
      depth > maxDepth ||
      count + (result.attributeRecords?.length ?? 0) >= maxOccurrences
    )
      throw new Error("Engineering source occurrence budget exceeded");
  }
  return {
    ...references,
    options,
    result,
    document,
    prefetch,
    families,
    check,
    physicalScopeIndex: new PhysicalScopeIndex(),
  };
}

export type SourceGraphContext = ReturnType<typeof createSourceGraphContext>;
