import { engineeringSourceRecords } from "../shared/sourceRecordSelectors.js";
import { updateSourceNames } from "./graph/sourceRecordEvidence.js";
import type { EngineeringSourceGraph } from "./sourceGraph.js";
import type { SourceDocument } from "./sourceDocuments.js";
import type { SourceProperty } from "./sourceEvidence.js";
import { parseFamSectionsWithDiagnostics } from "./famParser.js";
import { resolveBaseFamilyReferences } from "./gimValueSemantics.js";

export interface SourceFamilyHost {
  readDocument(path: string): Promise<SourceDocument>;
  resolveReference(owner: string, field: string, value: string): string | null;
  deferFamilies?: boolean;
}

export interface FamilyAssignment {
  sourceId: string;
  path: string;
}

/**
 * FAM demand is a source-graph side concern, not traversal.
 *
 * The index keeps the original document cache contract: one read per family
 * path, family fields replace the parsed document fields, and deferred mode
 * records assignments without opening FAM files.
 */
export class SourceFamilyIndex {
  readonly assignments: FamilyAssignment[] = [];
  private readonly familyCache = new Map<string, Promise<SourceProperty[]>>();
  private readonly familyPaths = new Map<string, string[]>();
  private readonly assigned = new Set<string>();

  constructor(private readonly host: SourceFamilyHost) {}

  assignFamilies(doc: SourceDocument, sourceId: string): void {
    for (const path of this.referencedFamilies(doc)) {
      const key = JSON.stringify([sourceId, path]);
      if (this.assigned.has(key)) continue;
      this.assigned.add(key);
      this.assignments.push({ sourceId, path });
    }
  }

  referencedFamilies(doc: SourceDocument): string[] {
    const cached = this.familyPaths.get(doc.path);
    if (cached) return cached;
    const paths: string[] = [];
    for (const field of doc.fields) {
      for (const edge of resolveBaseFamilyReferences({
        [field.keys[0]]: field.value,
      })) {
        const path = this.host.resolveReference(doc.path, edge.key, edge.path);
        if (path && !paths.includes(path)) paths.push(path);
      }
    }
    this.familyPaths.set(doc.path, paths);
    return paths;
  }

  family(doc: SourceDocument): Promise<SourceProperty[]> {
    let promise = this.familyCache.get(doc.path);
    if (!promise) {
      promise = (async () => {
        const properties: SourceProperty[] = [];
        for (const path of this.referencedFamilies(doc)) {
          if (this.host.deferFamilies) continue;
          const familyDoc = await this.host.readDocument(path);
          const parsed = parseFamSectionsWithDiagnostics(
            familyDoc.rawLines.join("\n"),
            path,
          );
          familyDoc.attributeStatus = parsed.diagnostics.malformedLineCount
            ? "partial"
            : "complete";
          const fields = parsed.properties.map((p) => ({
            path,
            line: p.sourceLine,
            keys: [...new Set([p.label, p.rawKey])],
            value: p.rawValue,
            rawLine: p.rawLine,
            section: p.section,
          }));
          familyDoc.fields = fields;
          properties.push(...fields);
        }
        return properties;
      })();
      this.familyCache.set(doc.path, promise);
    }
    return promise;
  }
}

/** Explicit recognition demand, after the physical catalog has been published. */
export async function materializeEngineeringFamilies(
  graph: EngineeringSourceGraph,
  readText: (path: string) => Promise<string>,
  parsedDocument?: (path: string) => SourceDocument | undefined,
): Promise<void> {
  let changed = false;
  const docs = new Map(graph.documents.map((d) => [d.path, d]));
  const properties = new Map<string, SourceProperty[]>();
  for (const { path } of graph.familyAssignments ?? []) {
    if (properties.has(path)) continue;
    let doc = docs.get(path);
    if (!doc) {
      doc = parsedDocument?.(path);
      if (doc) {
        docs.set(path, doc);
        graph.documents.push(doc);
        changed = true;
      }
    }
    if (!doc) {
      try {
        const rawLines = (await readText(path)).split(/\r?\n/);
        doc = { path, rawLines, fields: [] };
        docs.set(path, doc);
        graph.documents.push(doc);
        changed = true;
      } catch {
        if (
          !graph.diagnostics.some(
            (d) => d.kind === "read-failed" && d.source === path,
          )
        ) {
          graph.diagnostics.push({ kind: "read-failed", source: path });
          changed = true;
        }
        properties.set(path, []);
        continue;
      }
    }
    const diagnostics = graph.diagnostics.filter(
      (d) => !(d.kind === "read-failed" && d.source === path),
    );
    if (diagnostics.length !== graph.diagnostics.length) {
      graph.diagnostics = diagnostics;
      changed = true;
    }
    if (doc.attributeStatus) {
      properties.set(path, doc.fields);
      continue;
    }
    const parsed = parseFamSectionsWithDiagnostics(
      doc.rawLines.join("\n"),
      path,
    );
    doc.attributeStatus = parsed.diagnostics.malformedLineCount
      ? "partial"
      : "complete";
    changed = true;
    properties.set(
      path,
      parsed.properties.map((p) => ({
        path,
        line: p.sourceLine,
        keys: [...new Set([p.label, p.rawKey])],
        value: p.rawValue,
        rawLine: p.rawLine,
        section: p.section,
      })),
    );
    if (!doc.fields.length)
      doc.fields = properties
        .get(path)!
        .map((p) => ({ ...p, path, keys: p.keys ?? [] }));
  }
  const records = new Map(
    engineeringSourceRecords(graph).map((r) => [r.id, r]),
  );
  for (const { sourceId, path } of graph.familyAssignments ?? []) {
    const row = records.get(sourceId);
    if (!row || row.properties.some((p) => p.path === path)) continue;
    row.properties = [...row.properties, ...(properties.get(path) ?? [])];
    updateSourceNames(row);
  }
  if (changed) graph.revision = (graph.revision ?? 0) + 1;
}
