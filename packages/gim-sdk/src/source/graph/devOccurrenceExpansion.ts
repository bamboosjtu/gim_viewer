import type { CbmOccurrence } from "../sourceGraph.js";
import type { SourceDocument } from "../sourceDocuments.js";
import type { SourceRecord } from "../sourceEvidence.js";
import type { SourceGraphContext } from "./sourceGraphContext.js";
import { objectFields, updateSourceNames } from "./sourceRecordEvidence.js";

export async function expandDevOccurrences(
  context: SourceGraphContext,
  path: string,
  id: string,
  parent: string,
  cbm: CbmOccurrence,
  ancestry: Set<string>,
  depth: number,
  rootSourceId = id,
  assemblyPath = "",
): Promise<SourceRecord[]> {
  const {
    result,
    options,
    document,
    resolve,
    scalar,
    edgesFor,
    prefetch,
    families,
    check,
  } = context;
  check(depth);
  if (ancestry.has(path)) {
    result.diagnostics.push({ kind: "cycle", source: id });
    return [];
  }
  let doc: SourceDocument;
  try {
    doc = await document(path);
  } catch (error) {
    if (
      options.signal?.aborted ||
      /Engineering source unavailable/.test(String(error))
    )
      throw error;
    result.diagnostics.push({ kind: "read-failed", source: path });
    return [];
  }
  const edges = edgesFor(doc, /^SUBDEVICE\d+$/i).filter((p) =>
    /\.dev$/i.test(p.value),
  );
  prefetch(doc, edges);
  const cbmDoc = await document(cbm.documentPath);
  families.assignFamilies(doc, id);
  if (!parent) families.assignFamilies(cbmDoc, id);
  const props = [
    ...(!parent ? await families.family(cbmDoc) : []),
    ...(await families.family(doc)),
    ...objectFields(doc),
    ...(!parent ? objectFields(cbmDoc) : []),
  ];
  const row: SourceRecord = {
    id,
    track: "dev",
    source: path,
    name: "",
    source_type: scalar(doc, "TYPE") || scalar(doc, "DEVICETYPE"),
    parent,
    properties: props,
    sources: [cbm.documentPath, path],
    context: [cbm.id],
    guid: "",
    devOccurrence: { rootSourceId, cbmOccurrenceId: cbm.id, assemblyPath },
  };
  updateSourceNames(row);
  result.records.push(row);
  const subtree = [row];
  const next = new Set(ancestry);
  next.add(path);
  const keyCounts = new Map<string, number>();
  for (const field of doc.fields) {
    const key = field.keys[0].toUpperCase();
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  for (let i = 0; i < edges.length; i++) {
    if (i > 0 && i % 128 === 0) prefetch(doc, edges, i);
    const field = edges[i];
    const target = resolve(path, field.keys[0], field.value);
    const duplicateKey = (keyCounts.get(field.keys[0].toUpperCase()) ?? 0) > 1;
    const edgeId = `${field.keys[0].toUpperCase()}${duplicateKey ? `@line:${field.line}` : ""}`;
    const step = `sub:${Number(field.keys[0].match(/\d+$/)![0])}`;
    if (target)
      subtree.push(
        ...(await expandDevOccurrences(
          context,
          target,
          `${id}/${edgeId}:${target}`,
          id,
          cbm,
          next,
          depth + 1,
          rootSourceId,
          assemblyPath ? `${assemblyPath}/${step}` : step,
        )),
      );
  }
  return subtree;
}
