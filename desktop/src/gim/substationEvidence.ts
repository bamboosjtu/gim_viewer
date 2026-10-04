import type { CbmNode, FileDevEntry, IfcEntry } from './types.js';
import { normalizeEntityName } from './entityName.js';
import { parseKeyValue } from './kvParser.js';
import { getFirstNonEmptyKv, isGimEmptyValue } from './gimValueSemantics.js';
import { resolveIfcModelId } from './modelIdentity.js';

export interface SubstationIfcEvidence {
  cbmPath: string;
  rawReference: string;
  modelId: string | null;
  guid?: string;
  evidence: 'direct-guid' | 'source-file' | 'unlinked';
  /** This raw projection resolves files; actual IFC-object confirmation belongs to Spatial Core. */
  confidence: 'declared-reference' | 'resolved-file' | 'unresolved';
}

/** File discovery and component association are independent source edges. */
export function buildSubstationIfcEvidence(root: CbmNode | null, entries: readonly IfcEntry[]): SubstationIfcEvidence[] {
  const links: SubstationIfcEvidence[] = [];
  const add = (node: CbmNode, reference: string, guid?: string): void => {
    const modelId = resolveIfcModelId(reference, entries);
    links.push({ cbmPath: node.path, rawReference: reference, modelId, guid,
      confidence: modelId ? (guid ? 'declared-reference' : 'resolved-file') : 'unresolved',
      evidence: modelId ? (guid ? 'direct-guid' : 'source-file') : 'unlinked' });
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

/** Canonical lookup identity only; raw paths remain on the source nodes. */
export function substationDevIdentity(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^dev\//i, '').toLowerCase();
}

export interface SubstationAliasIndex {
  partToRoot: Map<string, CbmNode>;
  childDevToParts: Map<string, CbmNode[]>;
  partToChildDev: Map<string, string>;
  /** Actual DEV assembly occurrences, carrying their local placement. */
  partToOccurrences: Map<string, CbmNode[]>;
}

/** Identity join scoped to the nearest owning device; never join array positions. */
export function buildSubstationAliasIndex(root: CbmNode | null): SubstationAliasIndex {
  const index: SubstationAliasIndex = {
    childDevToParts: new Map(), partToChildDev: new Map(), partToOccurrences: new Map(), partToRoot: new Map(),
  };
  const visit = (node: CbmNode): void => {
    const parts = node.children.filter((n) => normalizeEntityName(n.entityName) === 'PARTINDEX');
    const occurrences: CbmNode[] = [];
    const collect = (n: CbmNode): void => {
      if (normalizeEntityName(n.entityName) !== 'DEV_SUBDEVICE') return;
      occurrences.push(n);
      n.children.forEach(collect);
    };
    node.children.forEach(collect);
    for (const part of parts) {
      index.partToRoot.set(part.path, node);
      if (!part.devPath) continue;
      const identity = substationDevIdentity(part.devPath);
      const aliases = index.childDevToParts.get(identity) ?? [];
      aliases.push(part);
      index.childDevToParts.set(identity, aliases);
      index.partToChildDev.set(part.path, identity);
      index.partToOccurrences.set(part.path,
        occurrences.filter((n) => substationDevIdentity(n.devPath) === identity));
    }
    node.children.forEach(visit);
  };
  if (root) visit(root);
  return index;
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

export function deviceOccurrenceScope(root: CbmNode | null, node: CbmNode): DeviceOccurrenceScope {
  if (normalizeEntityName(node.entityName) === 'PARTINDEX') {
    const aliases = buildSubstationAliasIndex(root);
    return { rootOccurrence: aliases.partToRoot.get(node.path)?.path ?? node.path,
      assemblyPaths: (aliases.partToOccurrences.get(node.path) ?? []).map((n) => devAssemblyPath(n.path)) };
  }
  if (normalizeEntityName(node.entityName) === 'DEV_SUBDEVICE') {
    return { rootOccurrence: node.path.split('#dev:')[0], assemblyPaths: [devAssemblyPath(node.path)] };
  }
  return { rootOccurrence: node.path };
}

export interface GlSidecar {
  devIdentity: string;
  path: string;
  semanticPaths: string[];
  evidence: 'same-uuid-sidecar';
}

/** Optional connection/source evidence; never inserted into SOLIDMODEL edges. */
export function discoverSubstationGlSidecars(paths: Iterable<string>, root: CbmNode | null): GlSidecar[] {
  const entries = [...paths];
  const devs = new Set(entries.filter((p) => /\.dev$/i.test(p)).map(substationDevIdentity));
  const nodes = new Map<string, string[]>();
  const visit = (n: CbmNode): void => {
    if (n.devPath) {
      const identity = substationDevIdentity(n.devPath);
      const list = nodes.get(identity) ?? [];
      list.push(n.path); nodes.set(identity, list);
    }
    n.children.forEach(visit);
  };
  if (root) visit(root);
  return entries.filter((p) => /^mod\/[^/]+\.gl$/i.test(p.replace(/\\/g, '/')))
    .flatMap((path) => {
      const stem = path.replace(/\\/g, '/').split('/').pop()!.replace(/\.gl$/i, '');
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stem)) return [];
      const devIdentity = `${stem.toLowerCase()}.dev`;
      return devs.has(devIdentity)
        ? [{ devIdentity, path, semanticPaths: nodes.get(devIdentity) ?? [], evidence: 'same-uuid-sidecar' as const }]
        : [];
    });
}

export interface SubstationCapabilitySummary {
  ifc: { modelCount: number; componentGuidLinks: number; fileLevelRefs: number;
    linkMode: 'component-guid' | 'file-level' | 'hybrid' | 'none' };
  geometry: { dev: number; phm: number; mod: number; stl: number; gl: number;
    nestedDev: boolean; nestedPhm: boolean; glSidecars: number };
  familyRefs: { baseFamily: boolean; baseFamilyPointer: boolean; indexedBaseFamilies: boolean };
  logicalModel: 'present' | 'placeholder' | 'absent';
  partIndex: 'present' | 'absent';
  sourceRelation: 'file-dev-relation' | 'absent';
  unreadablePaths: string[];
}

/** Pure description of source features. No vendor inference or runtime routing. */
export async function inspectSubstationCapabilities(
  files: ReadonlyMap<string, File>, root: CbmNode | null, ifcEntries: readonly IfcEntry[],
): Promise<SubstationCapabilitySummary> {
  const result: SubstationCapabilitySummary = {
    ifc: { modelCount: ifcEntries.length, componentGuidLinks: 0, fileLevelRefs: 0, linkMode: 'none' },
    geometry: { dev: 0, phm: 0, mod: 0, stl: 0, gl: 0, nestedDev: false, nestedPhm: false, glSidecars: 0 },
    familyRefs: { baseFamily: false, baseFamilyPointer: false, indexedBaseFamilies: false },
    logicalModel: 'absent', partIndex: 'absent', sourceRelation: 'absent', unreadablePaths: [],
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
      if (entity === 'LOGICALMODEL' && result.logicalModel === 'absent') result.logicalModel = 'placeholder';
      if (ext === 'cbm') {
        if (getFirstNonEmptyKv(kv, ['IFCFILE']) && getFirstNonEmptyKv(kv, ['IFCGUID'])) result.ifc.componentGuidLinks++;
        result.ifc.fileLevelRefs += Object.entries(kv).filter(([k, v]) => /^IFC\d+$/i.test(k) && !isGimEmptyValue(v)).length;
      }
      for (const [key, value] of Object.entries(kv)) {
        if (isGimEmptyValue(value)) continue;
        if (/^BASEFAMILY$/i.test(key)) result.familyRefs.baseFamily = true;
        if (/^BASEFAMILYPOINTER$/i.test(key)) result.familyRefs.baseFamilyPointer = true;
        if (/^BASEFAMILY\d+$/i.test(key)) result.familyRefs.indexedBaseFamilies = true;
        if (ext === 'dev' && /^(SUBDEVICE|SOLIDMODEL)\d+$/i.test(key) && /\.dev$/i.test(value)) result.geometry.nestedDev = true;
        if (ext === 'phm' && /^SOLIDMODEL\d+$/i.test(key) && /\.phm$/i.test(value)) result.geometry.nestedPhm = true;
      }
    } catch { result.unreadablePaths.push(path); }
  }
  const { componentGuidLinks: component, fileLevelRefs: file } = result.ifc;
  result.ifc.linkMode = component ? (file ? 'hybrid' : 'component-guid') : file ? 'file-level' : 'none';
  result.geometry.glSidecars = discoverSubstationGlSidecars(files.keys(), root).length;
  return result;
}

/** Independent provenance projection. Basename fallback is allowed only when unambiguous. */
export function findSubstationSourceDocuments(node: CbmNode, root: CbmNode | null, entries: readonly FileDevEntry[]): string[] {
  const canonical = (path: string): string => path.trim().replace(/\\/g, '/').replace(/^cbm\//i, '').toLowerCase();
  const key = canonical(node.path);
  const basename = key.split('/').pop();
  let sameBasename = 0;
  const visit = (n: CbmNode): void => {
    if (canonical(n.path).split('/').pop() === basename) sameBasename++;
    n.children.forEach(visit);
  };
  if (root) visit(root);
  return [...new Set(entries.filter((entry) => entry.deviceCbms.some((ref) => {
    const target = canonical(ref);
    return target === key || (!target.includes('/') && target === basename && sameBasename === 1);
  })).map((entry) => entry.sourceDesignFile || entry.ifcName).filter(Boolean))];
}
