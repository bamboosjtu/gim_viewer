import { parseFamSectionsWithDiagnostics } from '../famParser.js';
import { resolveBaseFamilyReferences } from '../gimValueSemantics.js';
import type { ObjectNameEvidence, SourceAlias } from '../../engineering/types.js';
import type { SourceProperty, SourceRecord } from './sourceEvidence.js';

export interface SourceFileReader {
  /** Actual archive paths, including files not reached by CBM GUID references. */
  paths: readonly string[];
  readText(path: string): Promise<string>;
}
export interface SourceReference {
  owner: string;
  field: string;
  value: string;
  target: string | null;
  candidates: string[];
  status: 'resolved' | 'missing' | 'ambiguous';
}
export interface SourceDocument {
  path: string;
  /** Physical source lines, including sections, placeholders and malformed rows. */
  rawLines: string[];
  fields: Array<SourceProperty & { keys: readonly string[]; path: string }>;
}
export interface CbmOccurrence {
  id: string;
  documentPath: string;
  parentId: string | null;
  viaField: string;
  /** Original GIM entity level, used only for the source view. */
  entityName?: string;
}
export interface EngineeringSourceGraph {
  documents: SourceDocument[];
  cbmOccurrences: CbmOccurrence[];
  records: SourceRecord[];
  aliases: SourceAlias[];
  references: SourceReference[];
  /** File discovery is independent of IFCGUID joins. */
  ifcPaths: string[];
  diagnostics: Array<{ kind: 'cycle' | 'missing-object-model'; source: string }>;
}

const normalizePath = (value: string) => value.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').toLowerCase();
const ordered = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** No use of CbmNode, current UI grain, F-levels or geometry seed predicates. */
export async function extractEngineeringSourceGraph(files: SourceFileReader, options: { maxOccurrences?: number; maxDepth?: number; signal?: AbortSignal } = {}): Promise<EngineeringSourceGraph> {
  const maxOccurrences = options.maxOccurrences ?? 500_000;
  const maxDepth = options.maxDepth ?? 128;
  const result: EngineeringSourceGraph = { documents: [], cbmOccurrences: [], records: [], aliases: [], references: [],
    ifcPaths: files.paths.filter(p => /\.ifc$/i.test(p)).sort(ordered), diagnostics: [] };
  const exact = new Map<string, string[]>();
  const basename = new Map<string, string[]>();
  for (const path of [...files.paths].sort(ordered)) {
    for (const [map, key] of [[exact, normalizePath(path)], [basename, normalizePath(path).split('/').pop()!]] as const) {
      const hits = map.get(key) ?? []; hits.push(path); map.set(key, hits);
    }
  }
  function resolve(owner: string, field: string, value: string): string | null {
    const parent = owner.includes('/') ? owner.slice(0, owner.lastIndexOf('/')) : '';
    const ref = value.replace(/\.ifc\$$/i, '.ifc');
    let candidates: string[] = [];
    for (const key of [normalizePath(parent ? `${parent}/${ref}` : ref), normalizePath(ref)]) {
      candidates = exact.get(key) ?? [];
      if (candidates.length) break;
    }
    if (!candidates.length) candidates = basename.get(normalizePath(ref).split('/').pop()!) ?? [];
    const target = candidates.length === 1 ? candidates[0] : null;
    result.references.push({ owner, field, value, target, candidates: [...candidates], status: target ? 'resolved' : candidates.length ? 'ambiguous' : 'missing' });
    return target;
  }
  const cache = new Map<string, Promise<SourceDocument>>();
  function document(path: string): Promise<SourceDocument> {
    let promise = cache.get(path);
    if (!promise) {
      promise = files.readText(path).then(text => {
        const rawLines = text.split(/\r?\n/);
        const fields = rawLines.flatMap((rawLine, index) => {
          const line = rawLine.replace(/^\uFEFF/, '').trim();
          const at = line.indexOf('=');
          return at > 0 ? [{ path, line: index + 1, keys: [line.slice(0, at).trim()], value: line.slice(at + 1).trim(), rawLine }] : [];
        });
        const doc = { path, rawLines, fields }; result.documents.push(doc); return doc;
      });
      cache.set(path, promise);
    }
    return promise;
  }
  const scalar = (doc: SourceDocument, key: string) => doc.fields.find(p => p.keys[0].toUpperCase() === key)?.value ?? '';
  // Object fields are attached only to their actual OMP occurrence. SYSTEMNAME
  // and PARTNAME remain organizational context in the source documents.
  const objectFields = (doc: SourceDocument) => doc.fields.filter(p => /^(?:SYMBOLNAME|NAME|OBJECTNAME|PROJECTNAME|设备名称|工程中名称|设备编码|电网工程标识系统编码|GRIDIDENTIFICATIONSYSTEMCODE|相数)$/i.test(p.keys[0]));
  function updateNames(row: SourceRecord): void {
    const names: ObjectNameEvidence[] = [];
    for (const [kind, labels] of [
      ['object', ['SYMBOLNAME']], ['engineering', ['工程中名称', 'PROJECTNAME']],
      ['family', ['设备名称']], ['source', ['NAME', 'OBJECTNAME']],
    ] as const) {
      for (const p of row.properties) if (p.keys?.some(k => (labels as readonly string[]).includes(k.toUpperCase())) && p.value.trim() && !['-', '/', '-100', '软件自动生成'].includes(p.value.trim())) {
        names.push({ kind, value: p.value, evidenceId: JSON.stringify([row.id, p.path, p.line, p.keys]) });
      }
    }
    row.nameEvidence = names;
    row.name = names[0]?.value ?? '';
  }
  const familyCache = new Map<string, Promise<SourceProperty[]>>();
  async function family(doc: SourceDocument): Promise<SourceProperty[]> {
    let promise = familyCache.get(doc.path);
    if (!promise) {
      promise = (async () => {
        const properties: SourceProperty[] = [];
        const kv = Object.fromEntries(doc.fields.map(p => [p.keys[0], p.value]));
        for (const edge of resolveBaseFamilyReferences(kv)) {
          const path = resolve(doc.path, edge.key, edge.path);
          if (!path) continue;
          const text = (await document(path)).rawLines.join('\n');
          properties.push(...parseFamSectionsWithDiagnostics(text, path).properties.map(p => ({
            path, line: p.sourceLine, keys: [...new Set([p.label, p.rawKey])], value: p.rawValue, rawLine: p.rawLine, section: p.section,
          })));
        }
        return properties;
      })();
      familyCache.set(doc.path, promise);
    }
    return promise;
  }
  function check(depth: number) {
    if (options.signal?.aborted) throw new DOMException('Source extraction cancelled', 'AbortError');
    if (depth > maxDepth || result.records.length + result.cbmOccurrences.length >= maxOccurrences) throw new Error('Engineering source occurrence budget exceeded');
  }
  async function expandDev(path: string, id: string, parent: string, cbm: CbmOccurrence, ancestry: Set<string>, depth: number,
    rootSourceId = id, assemblyPath = ''): Promise<SourceRecord[]> {
    check(depth);
    if (ancestry.has(path)) { result.diagnostics.push({ kind: 'cycle', source: id }); return []; }
    const doc = await document(path);
    const cbmDoc = await document(cbm.documentPath);
    const props = [...(!parent ? await family(cbmDoc) : []), ...await family(doc), ...objectFields(doc), ...(!parent ? objectFields(cbmDoc) : [])];
    const row: SourceRecord = {
      id, track: 'dev', source: path, name: '',
      source_type: scalar(doc, 'TYPE') || scalar(doc, 'DEVICETYPE'), parent, properties: props,
      sources: [cbm.documentPath, path], context: [cbm.id], guid: '',
      devOccurrence: { rootSourceId, cbmOccurrenceId: cbm.id, assemblyPath },
    };
    updateNames(row);
    result.records.push(row);
    const subtree = [row];
    const next = new Set(ancestry); next.add(path);
    for (const field of doc.fields.filter(p => /^SUBDEVICE\d+$/i.test(p.keys[0]) && /\.dev$/i.test(p.value))) {
      const target = resolve(path, field.keys[0], field.value);
      const duplicateKey = doc.fields.filter(p => p.keys[0].toUpperCase() === field.keys[0].toUpperCase()).length > 1;
      const edgeId = `${field.keys[0].toUpperCase()}${duplicateKey ? `@line:${field.line}` : ''}`;
      const step = `sub:${Number(field.keys[0].match(/\d+$/)![0])}`;
      if (target) subtree.push(...await expandDev(target, `${id}/${edgeId}:${target}`, id, cbm, next, depth + 1,
        rootSourceId, assemblyPath ? `${assemblyPath}/${step}` : step));
    }
    return subtree;
  }
  interface PhysicalScope { records: SourceRecord[]; rootIds: Set<string> }
  async function visitCbm(path: string, id: string, parentId: string | null, viaField: string, ancestors: Set<string>, physicalScopes: PhysicalScope[], depth: number): Promise<void> {
    check(depth);
    if (ancestors.has(path)) { result.diagnostics.push({ kind: 'cycle', source: id }); return; }
    const doc = await document(path);
    const entityName = scalar(doc, 'ENTITYNAME')?.trim() || undefined;
    const node = { id, documentPath: path, parentId, viaField, ...(entityName ? { entityName } : {}) };
    result.cbmOccurrences.push(node);
    let scopes = physicalScopes;
    const omp = scalar(doc, 'OBJECTMODELPOINTER');
    if (omp) {
      const target = resolve(path, 'OBJECTMODELPOINTER', omp);
      if (target) {
        // A CBM ancestor is context only. Join actual descendants by DEV identity,
        // excluding the root itself, even if the same template is referenced twice.
        let candidates: SourceRecord[] = [];
        const nearest = physicalScopes[physicalScopes.length - 1];
        candidates = nearest?.records.filter(row => !nearest.rootIds.has(row.id) && row.source === target) ?? [];
        if (candidates.length) {
          result.aliases.push({ sourceId: id, status: candidates.length === 1 ? 'confirmed' : 'ambiguous', candidates: candidates.map(row => row.id) });
          if (candidates.length === 1) {
            const row = candidates[0];
            row.sources = [...row.sources, path]; row.properties = [...row.properties, ...await family(doc), ...objectFields(doc)];
            updateNames(row);
          }
          // Limit subsequent aliases to this real part subtree, not sibling instances.
          const ids = new Set(candidates.map(row => row.id));
          const subtree = nearest.records.filter(row => ids.has(row.id) || candidates.some(c => row.id.startsWith(`${c.id}/`)));
          scopes = [...physicalScopes, { records: subtree, rootIds: ids }];
        } else {
          const subtree = await expandDev(target, `dev:${id}:${target}`, '', node, new Set(), 0);
          scopes = [...physicalScopes, { records: subtree, rootIds: new Set(subtree.slice(0, 1).map(row => row.id)) }];
        }
      } else result.diagnostics.push({ kind: 'missing-object-model', source: id });
    }
    for (const field of doc.fields.filter(p => /^(?:IFCFILE|IFC\d+)$/i.test(p.keys[0]) && p.value)) resolve(path, field.keys[0], field.value);
    const next = new Set(ancestors); next.add(path);
    const edges = doc.fields.filter(p => /^(?:SUBSYSTEM\d*|SUBDEVICE\d+)$/i.test(p.keys[0]) && /\.cbm$/i.test(p.value));
    for (const field of edges) {
      const child = resolve(path, field.keys[0], field.value);
      const duplicateKey = edges.filter(p => p.keys[0].toUpperCase() === field.keys[0].toUpperCase()).length > 1;
      const edgeId = `${field.keys[0].toUpperCase()}${duplicateKey ? `@line:${field.line}` : ''}`;
      if (child) await visitCbm(child, `${id}/${edgeId}:${child}`, id, field.keys[0], next, scopes, depth + 1);
    }
  }
  const root = resolve('', 'project-entry', 'project.cbm');
  if (!root) throw new Error('Engineering source graph requires a unique project.cbm');
  await visitCbm(root, `cbm:${root}`, null, '', new Set(), [], 0);
  if (options.signal?.aborted) throw new DOMException('Source extraction cancelled', 'AbortError');
  result.documents.sort((a, b) => ordered(a.path, b.path));
  return result;
}
