import type { CbmNode, FileDevEntry, IfcEntry } from './types.js';
import { normalizeEntityName } from '@gim/gim-primitives/entityName.js';
import { parseKeyValue } from '@gim/gim-primitives/kvParser.js';
import { getFirstNonEmptyKv, isGimEmptyValue } from './gimValueSemantics.js';
import { resolveIfcModelId } from './modelIdentity.js';

/** Shared per-tree evidence indexes, WeakMap-keyed by the tree root like the
 * shared entry resolver. Auxiliary inputs (IFC entries, file/DEV relations,
 * the files Map or the persisted entry-path list) are validated by reference:
 * a replaced reference rebuilds only the affected index, and repeated
 * per-node queries never re-walk or re-enumerate the whole archive. */
interface SubstationEvidenceRecord {
  aliases?: SubstationAliasIndex;
  basenameCounts?: Map<string, number>;
  ifcEvidence?: { entries: readonly IfcEntry[]; links: SubstationIfcEvidence[] };
  glSidecars?: { source: ReadonlyMap<string, unknown> | readonly string[]; found: GlSidecar[] };
  sourceDocuments?: { relations: readonly FileDevEntry[]; byPath: Map<string, string[]> };
}
const substationEvidenceRecords = new WeakMap<CbmNode, SubstationEvidenceRecord>();
const substationEvidenceRecord = (root: CbmNode): SubstationEvidenceRecord => {
  let record = substationEvidenceRecords.get(root);
  if (!record) substationEvidenceRecords.set(root, (record = {}));
  return record;
};

export interface SubstationIfcEvidence {
  cbmPath: string;
  rawReference: string;
  modelId: string | null;
  guid?: string;
  evidence: 'direct-guid' | 'source-file' | 'unlinked';
  /** This raw projection resolves files; actual IFC-object confirmation belongs to Spatial Core. */
  confidence: 'declared-reference' | 'resolved-file' | 'unresolved';
}

function collectSubstationIfcEvidence(
  root: CbmNode | null,
  entries: readonly IfcEntry[],
): SubstationIfcEvidence[] {
  const links: SubstationIfcEvidence[] = [];
  const add = (node: CbmNode, reference: string, guid?: string): void => {
    const modelId = resolveIfcModelId(reference, entries);
    links.push({
      cbmPath: node.path,
      rawReference: reference,
      modelId,
      guid,
      confidence: modelId ? (guid ? 'declared-reference' : 'resolved-file') : 'unresolved',
      evidence: modelId ? (guid ? 'direct-guid' : 'source-file') : 'unlinked',
    });
  };
  const visit = (node: CbmNode): void => {
    if (node.ifcFile) add(node, node.ifcFile, node.ifcGuid || undefined);
    for (const [key, value] of Object.entries(node.rawProperties ?? {})) {
      if (/^IFC\d+$/i.test(key) && !isGimEmptyValue(value)) add(node, value);
    }
    node.children.forEach(visit);
  };
  if (root) visit(root);
  return links;
}

/** File discovery and component association are independent source edges.
 * Cached per tree; a replaced IFC entry array rebuilds the links once. */
export function buildSubstationIfcEvidence(
  root: CbmNode | null,
  entries: readonly IfcEntry[],
): SubstationIfcEvidence[] {
  if (!root) return collectSubstationIfcEvidence(root, entries);
  const record = substationEvidenceRecord(root);
  if (record.ifcEvidence?.entries !== entries)
    record.ifcEvidence = { entries, links: collectSubstationIfcEvidence(root, entries) };
  return record.ifcEvidence.links;
}

/** Canonical lookup identity only; raw paths remain on the source nodes. */
export function substationDevIdentity(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^dev\//i, '')
    .toLowerCase();
}

export interface SubstationAliasIndex {
  /** Source hierarchy, independent of the physical placement owner. */
  partToSemanticParent: Map<string, CbmNode>;
  partToRoot: Map<string, CbmNode>;
  childDevToParts: Map<string, CbmNode[]>;
  partToChildDev: Map<string, string>;
  /** Actual DEV assembly occurrences, carrying their local placement. */
  partToOccurrences: Map<string, CbmNode[]>;
}

/** The same entries seed physical loading and own derived semantic aliases. */
export function isSubstationGeometryRoot(node: CbmNode): boolean {
  const entity = normalizeEntityName(node.entityName);
  return !!node.devPath && entity !== 'DEV_SUBDEVICE' && entity !== 'PARTINDEX';
}

/** Identity join within the real root's assembly graph and the semantic parent's candidates. */
function collectSubstationAliasIndex(root: CbmNode | null): SubstationAliasIndex {
  const index: SubstationAliasIndex = {
    childDevToParts: new Map(),
    partToChildDev: new Map(),
    partToOccurrences: new Map(),
    partToRoot: new Map(),
    partToSemanticParent: new Map(),
  };
  const collectOccurrences = (owner: CbmNode): CbmNode[] => {
    const occurrences: CbmNode[] = [];
    const collect = (n: CbmNode): void => {
      if (normalizeEntityName(n.entityName) !== 'DEV_SUBDEVICE') return;
      occurrences.push(n);
      n.children.forEach(collect);
    };
    owner.children.forEach(collect);
    return occurrences;
  };
  const visit = (
    node: CbmNode,
    parent?: CbmNode,
    owner?: CbmNode,
    occurrences: CbmNode[] = [],
    parentPart?: CbmNode,
  ): void => {
    const entity = normalizeEntityName(node.entityName);
    // Virtual DEV nodes are physical evidence, never another semantic loading root.
    if (entity === 'DEV_SUBDEVICE') return;
    if (isSubstationGeometryRoot(node)) {
      owner = node;
      occurrences = collectOccurrences(node);
      parentPart = undefined;
    }
    if (entity === 'PARTINDEX') {
      if (parent) index.partToSemanticParent.set(node.path, parent);
      if (owner) index.partToRoot.set(node.path, owner);
      const identity = substationDevIdentity(node.devPath ?? '');
      if (identity) {
        const aliases = index.childDevToParts.get(identity) ?? [];
        aliases.push(node);
        index.childDevToParts.set(identity, aliases);
        index.partToChildDev.set(node.path, identity);
      }
      const parents = parentPart ? (index.partToOccurrences.get(parentPart.path) ?? []) : undefined;
      index.partToOccurrences.set(
        node.path,
        occurrences.filter(
          (candidate) =>
            !!identity &&
            substationDevIdentity(candidate.devPath) === identity &&
            (!parents ||
              parents.some(
                (p) => candidate.path === p.path || candidate.path.startsWith(`${p.path}#dev:`),
              )),
        ),
      );
      parentPart = node;
    }
    node.children.forEach((child) => visit(child, node, owner, occurrences, parentPart));
  };
  if (root) visit(root);
  return index;
}

/** Cached per tree: per-node interaction and inspector lookups reuse the same index. */
export function buildSubstationAliasIndex(root: CbmNode | null): SubstationAliasIndex {
  if (!root) return collectSubstationAliasIndex(root);
  const record = substationEvidenceRecord(root);
  if (!record.aliases) record.aliases = collectSubstationAliasIndex(root);
  return record.aliases;
}

export interface DeviceOccurrenceScope {
  rootOccurrence: string;
  /** Undefined selects the whole root; [] is an unlinked part, never a global fallback. */
  assemblyPaths?: string[];
}

/** Paths follow actual DEV edges; PARTINDEX positions never participate. */
export function devAssemblyPath(virtualPath: string): string {
  return [...virtualPath.matchAll(/#dev:(\d+):/g)].map((m) => `sub:${m[1]}`).join('/');
}

export function deviceOccurrenceScope(
  root: CbmNode | null,
  node: CbmNode,
  aliasIndex?: ReturnType<typeof buildSubstationAliasIndex>,
): DeviceOccurrenceScope {
  if (normalizeEntityName(node.entityName) === 'PARTINDEX') {
    const aliases = aliasIndex ?? buildSubstationAliasIndex(root);
    return {
      rootOccurrence: aliases.partToRoot.get(node.path)?.path ?? node.path,
      assemblyPaths: (aliases.partToOccurrences.get(node.path) ?? []).map((n) =>
        devAssemblyPath(n.path),
      ),
    };
  }
  if (normalizeEntityName(node.entityName) === 'DEV_SUBDEVICE') {
    return {
      rootOccurrence: node.path.split('#dev:')[0],
      assemblyPaths: [devAssemblyPath(node.path)],
    };
  }
  return { rootOccurrence: node.path };
}

export interface GlSidecar {
  devIdentity: string;
  path: string;
  semanticPaths: string[];
  evidence: 'same-uuid-sidecar';
}

function collectSubstationGlSidecars(paths: Iterable<string>, root: CbmNode | null): GlSidecar[] {
  const entries = [...paths];
  const devs = new Set(entries.filter((p) => /\.dev$/i.test(p)).map(substationDevIdentity));
  const nodes = new Map<string, string[]>();
  const visit = (n: CbmNode): void => {
    if (n.devPath) {
      const identity = substationDevIdentity(n.devPath);
      const list = nodes.get(identity) ?? [];
      list.push(n.path);
      nodes.set(identity, list);
    }
    n.children.forEach(visit);
  };
  if (root) visit(root);
  return entries
    .filter((p) => /^mod\/[^/]+\.gl$/i.test(p.replace(/\\/g, '/')))
    .flatMap((path) => {
      const stem = path.replace(/\\/g, '/').split('/').pop()!.replace(/\.gl$/i, '');
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stem)) return [];
      const devIdentity = `${stem.toLowerCase()}.dev`;
      return devs.has(devIdentity)
        ? [
            {
              devIdentity,
              path,
              semanticPaths: nodes.get(devIdentity) ?? [],
              evidence: 'same-uuid-sidecar' as const,
            },
          ]
        : [];
    });
}

/** Optional connection/source evidence; never inserted into SOLIDMODEL edges.
 * A shared files Map or the persisted entry-path list keeps a stable reference
 * and is reused across per-node queries; one-shot iterators stay uncached. */
export function discoverSubstationGlSidecars(
  paths: Iterable<string> | ReadonlyMap<string, unknown>,
  root: CbmNode | null,
): GlSidecar[] {
  const source =
    paths instanceof Map
      ? (paths as ReadonlyMap<string, unknown>)
      : Array.isArray(paths)
        ? (paths as readonly string[])
        : undefined;
  if (!root || source === undefined)
    return collectSubstationGlSidecars(
      paths instanceof Map ? paths.keys() : (paths as Iterable<string>),
      root,
    );
  const record = substationEvidenceRecord(root);
  if (record.glSidecars?.source !== source)
    record.glSidecars = {
      source,
      found: collectSubstationGlSidecars(
        source instanceof Map
          ? (source as ReadonlyMap<string, unknown>).keys()
          : (source as readonly string[]),
        root,
      ),
    };
  return record.glSidecars.found;
}

export interface SubstationCapabilitySummary {
  ifc: {
    modelCount: number;
    componentGuidLinks: number;
    fileLevelRefs: number;
    linkMode: 'component-guid' | 'file-level' | 'hybrid' | 'none';
  };
  geometry: {
    dev: number;
    phm: number;
    mod: number;
    stl: number;
    gl: number;
    nestedDev: boolean;
    nestedPhm: boolean;
    glSidecars: number;
  };
  familyRefs: { baseFamily: boolean; baseFamilyPointer: boolean; indexedBaseFamilies: boolean };
  logicalModel: 'present' | 'placeholder' | 'absent';
  partIndex: 'present' | 'absent';
  sourceRelation: 'file-dev-relation' | 'absent';
  unreadablePaths: string[];
}

/** Pure description of source features. No vendor inference or runtime routing. */
export async function inspectSubstationCapabilities(
  files: ReadonlyMap<string, File>,
  root: CbmNode | null,
  ifcEntries: readonly IfcEntry[],
): Promise<SubstationCapabilitySummary> {
  const result: SubstationCapabilitySummary = {
    ifc: {
      modelCount: ifcEntries.length,
      componentGuidLinks: 0,
      fileLevelRefs: 0,
      linkMode: 'none',
    },
    geometry: {
      dev: 0,
      phm: 0,
      mod: 0,
      stl: 0,
      gl: 0,
      nestedDev: false,
      nestedPhm: false,
      glSidecars: 0,
    },
    familyRefs: { baseFamily: false, baseFamilyPointer: false, indexedBaseFamilies: false },
    logicalModel: 'absent',
    partIndex: 'absent',
    sourceRelation: 'absent',
    unreadablePaths: [],
  };
  for (const [path, file] of files) {
    const lower = path.replace(/\\/g, '/').toLowerCase();
    const ext = lower.split('.').pop()!;
    if (['dev', 'phm', 'mod', 'stl', 'gl'].includes(ext)) {
      result.geometry[ext as 'dev' | 'phm' | 'mod' | 'stl' | 'gl']++;
    }
    if (/\.(sch|std|sld)$/.test(lower)) result.logicalModel = 'present';
    if (lower === 'cbm/filedevrelation.cbm') result.sourceRelation = 'file-dev-relation';
    if (!/\.(cbm|dev|phm)$/.test(lower)) continue;
    try {
      const kv = parseKeyValue(await file.text());
      const entity = normalizeEntityName(getFirstNonEmptyKv(kv, ['ENTITYNAME']));
      if (entity === 'PARTINDEX') result.partIndex = 'present';
      if (entity === 'LOGICALMODEL' && result.logicalModel === 'absent')
        result.logicalModel = 'placeholder';
      if (ext === 'cbm') {
        if (getFirstNonEmptyKv(kv, ['IFCFILE']) && getFirstNonEmptyKv(kv, ['IFCGUID']))
          result.ifc.componentGuidLinks++;
        result.ifc.fileLevelRefs += Object.entries(kv).filter(
          ([k, v]) => /^IFC\d+$/i.test(k) && !isGimEmptyValue(v),
        ).length;
      }
      for (const [key, value] of Object.entries(kv)) {
        if (isGimEmptyValue(value)) continue;
        if (/^BASEFAMILY$/i.test(key)) result.familyRefs.baseFamily = true;
        if (/^BASEFAMILYPOINTER$/i.test(key)) result.familyRefs.baseFamilyPointer = true;
        if (/^BASEFAMILY\d+$/i.test(key)) result.familyRefs.indexedBaseFamilies = true;
        if (ext === 'dev' && /^(SUBDEVICE|SOLIDMODEL)\d+$/i.test(key) && /\.dev$/i.test(value))
          result.geometry.nestedDev = true;
        if (ext === 'phm' && /^SOLIDMODEL\d+$/i.test(key) && /\.phm$/i.test(value))
          result.geometry.nestedPhm = true;
      }
    } catch {
      result.unreadablePaths.push(path);
    }
  }
  const { componentGuidLinks: component, fileLevelRefs: file } = result.ifc;
  result.ifc.linkMode = component
    ? file
      ? 'hybrid'
      : 'component-guid'
    : file
      ? 'file-level'
      : 'none';
  result.geometry.glSidecars = discoverSubstationGlSidecars(files.keys(), root).length;
  return result;
}

/** Canonical lookup identity for source-document paths. */
const canonicalSourcePath = (path: string): string =>
  path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^cbm\//i, '')
    .toLowerCase();

/** Whole-tree basename census shared by every per-node document lookup. */
function collectSubstationBasenameCounts(root: CbmNode | null): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (n: CbmNode): void => {
    const basename = canonicalSourcePath(n.path).split('/').pop()!;
    counts.set(basename, (counts.get(basename) ?? 0) + 1);
    n.children.forEach(visit);
  };
  if (root) visit(root);
  return counts;
}

/** Independent provenance projection. Basename fallback is allowed only when unambiguous.
 * The tree census is cached per root; the relations filter is memoized per node
 * and rebuilt when the relations array reference changes. */
export function findSubstationSourceDocuments(
  node: CbmNode,
  root: CbmNode | null,
  entries: readonly FileDevEntry[],
): string[] {
  const key = canonicalSourcePath(node.path);
  const basename = key.split('/').pop()!;
  const record = root ? substationEvidenceRecord(root) : undefined;
  const counts = record
    ? (record.basenameCounts ??= collectSubstationBasenameCounts(root))
    : collectSubstationBasenameCounts(root);
  if (record && record.sourceDocuments?.relations !== entries)
    record.sourceDocuments = { relations: entries, byPath: new Map() };
  const memo = record?.sourceDocuments?.byPath.get(key);
  if (memo !== undefined) return memo;
  const sameBasename = counts.get(basename) ?? 0;
  const documents = [
    ...new Set(
      entries
        .filter((entry) =>
          entry.deviceCbms.some((ref) => {
            const target = canonicalSourcePath(ref);
            return (
              target === key || (!target.includes('/') && target === basename && sameBasename === 1)
            );
          }),
        )
        .map((entry) => entry.sourceDesignFile || entry.ifcName)
        .filter(Boolean),
    ),
  ];
  record?.sourceDocuments?.byPath.set(key, documents);
  return documents;
}
