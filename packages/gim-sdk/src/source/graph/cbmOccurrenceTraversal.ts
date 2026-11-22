import { cbmRelationKind } from "../sourceComposition.js";
import type { SourceDocument } from "../sourceDocuments.js";
import type { SourceRecord } from "../sourceEvidence.js";
import { expandDevOccurrences } from "./devOccurrenceExpansion.js";
import type { PhysicalScope } from "./physicalScopeIndex.js";
import type { SourceGraphContext } from "./sourceGraphContext.js";
import { objectFields, updateSourceNames } from "./sourceRecordEvidence.js";

export async function visitCbmOccurrence(
  context: SourceGraphContext,
  path: string,
  id: string,
  parentId: string | null,
  viaField: string,
  ancestors: Set<string>,
  physicalScopes: PhysicalScope[],
  depth: number,
): Promise<void> {
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
    physicalScopeIndex,
  } = context;
  check(depth);
  if (ancestors.has(path)) {
    result.diagnostics.push({ kind: "cycle", source: id });
    return;
  }
  let doc: SourceDocument;
  try {
    doc = await document(path);
  } catch (error) {
    if (
      parentId === null ||
      options.signal?.aborted ||
      /Engineering source unavailable/.test(String(error))
    )
      throw error;
    result.diagnostics.push({ kind: "read-failed", source: path });
    return;
  }
  const edges = edgesFor(doc, /^(?:SUBSYSTEM\d*|SUBDEVICE\d+)$/i).filter((p) =>
    /\.cbm$/i.test(p.value),
  );
  prefetch(doc, [
    ...doc.fields.filter(
      (p) => /^OBJECTMODELPOINTER$/i.test(p.keys[0]) && /\.dev$/i.test(p.value),
    ),
    ...edges,
  ]);
  const entityName = scalar(doc, "ENTITYNAME")?.trim() || undefined;
  // GUID is a scalar association fact, not a list or a first-value hint.
  scalar(doc, "IFCGUID");
  families.referencedFamilies(doc);
  const node = {
    id,
    documentPath: path,
    parentId,
    viaField,
    relationKind: cbmRelationKind(viaField),
    ...(entityName ? { entityName } : {}),
  };
  result.cbmOccurrences.push(node);
  let scopes = physicalScopes;
  const omp = scalar(doc, "OBJECTMODELPOINTER");
  if (omp) {
    const target = resolve(path, "OBJECTMODELPOINTER", omp);
    if (target) {
      // A CBM ancestor is context only. Join actual descendants by DEV identity,
      // excluding the root itself, even if the same template is referenced twice.
      const nearest = physicalScopes[physicalScopes.length - 1];
      const candidates = nearest
        ? physicalScopeIndex.matchingDescendants(nearest, target)
        : [];
      if (candidates.length && nearest) {
        result.aliases.push({
          sourceId: id,
          status: candidates.length === 1 ? "confirmed" : "ambiguous",
          candidates: candidates.map((row) => row.id),
        });
        if (candidates.length === 1) {
          const row = candidates[0];
          families.assignFamilies(doc, row.id);
          row.sources = [...row.sources, path];
          row.properties = [
            ...row.properties,
            ...(await families.family(doc)),
            ...objectFields(doc),
          ];
          updateSourceNames(row);
        }
        scopes = [
          ...physicalScopes,
          physicalScopeIndex.child(nearest, target, candidates),
        ];
      } else if (entityName?.toUpperCase() === "PARTINDEX") {
        // Attribute-only occurrence: preserve evidence without creating a physical root.
        result.aliases.push({
          sourceId: id,
          status: "unresolved",
          candidates: [],
        });
        const attributeId = `attribute:${id}:${target}`;
        let targetDoc: SourceDocument;
        try {
          targetDoc = await document(target);
        } catch (error) {
          if (options.signal?.aborted) throw error;
          result.diagnostics.push({ kind: "read-failed", source: target });
          targetDoc = { path: target, rawLines: [], fields: [] };
        }
        const row: SourceRecord = {
          id: attributeId,
          track: "dev",
          source: target,
          source_type:
            scalar(targetDoc, "TYPE") || scalar(targetDoc, "DEVICETYPE"),
          name: "",
          parent: "",
          properties: [
            ...(await families.family(doc)),
            ...(await families.family(targetDoc)),
            ...objectFields(targetDoc),
            ...objectFields(doc),
          ],
          sources: [path, target],
          context: [id],
          guid: "",
          attributeOnly: true,
          attributeContextId: id,
          relations: [],
        };
        updateSourceNames(row);
        (result.attributeRecords ??= []).push(row);
        families.assignFamilies(doc, attributeId);
        families.assignFamilies(targetDoc, attributeId);
      } else {
        const subtree = await expandDevOccurrences(
          context,
          target,
          `dev:${id}:${target}`,
          "",
          node,
          new Set(),
          0,
        );
        scopes = [...physicalScopes, physicalScopeIndex.root(subtree)];
      }
    } else
      result.diagnostics.push({ kind: "missing-object-model", source: id });
  }
  for (const field of edgesFor(doc, /^(?:IFCFILE|IFC\d+)$/i).filter(
    (p) => p.value,
  ))
    resolve(path, field.keys[0], field.value);
  const next = new Set(ancestors);
  next.add(path);
  const edgeCounts = new Map<string, number>();
  for (const field of edges) {
    const key = field.keys[0].toUpperCase();
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  }
  for (let i = 0; i < edges.length; i++) {
    if (i > 0 && i % 128 === 0) prefetch(doc, edges, i);
    const field = edges[i];
    const child = resolve(path, field.keys[0], field.value);
    const duplicateKey = (edgeCounts.get(field.keys[0].toUpperCase()) ?? 0) > 1;
    const edgeId = `${field.keys[0].toUpperCase()}${duplicateKey ? `@line:${field.line}` : ""}`;
    if (child)
      await visitCbmOccurrence(
        context,
        child,
        `${id}/${edgeId}:${child}`,
        id,
        field.keys[0],
        next,
        scopes,
        depth + 1,
      );
  }
}
