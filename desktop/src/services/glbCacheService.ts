/**
 * 方案 C v2：DEV 粒度 → glTF 离线预序列化缓存服务。
 *
 * serializeDevToGlb 由渐进式几何管线（progressiveGeometryService）在首次打开时
 * 逐 DEV 调用：序列化 → 落盘 → 逐 CBM 实例渲染一体化。
 * 二次打开时可直接用 GLTFLoader 加载 .glb，跳过全部 XML 解析。
 *
 * 关键设计（当前 DEV 粒度缓存契约见 docs/architecture/dev-geometry.md）：
 * - 按 DEV 文件粒度缓存（非按 MOD 文件粒度）
 *   理由：DEV 粒度大幅减少加载次数（5982 → 数百）
 * - 超大型 DEV 可按装配子树并行编译，但合并后仍是一个 DEV 模板；拆分部分
 *   没有独立缓存身份
 * - 序列化时烘焙 DEV 内部所有 transform（DEV × PHM × SUBDEVICE × Entity + mm→m）
 * - CBM 累积矩阵运行时应用（同一 DEV 可被多 CBM 引用）
 * - 数学等价性：两次 applyPlacementTransformToSceneUnits（各 ×0.001）
 *   等价于一次完整应用（CBM × DEV × PHM，×0.001）
 *
 * 缓存路径：app_data_dir/glbcache/{project_id}/{devPath}.glb
 * 版本化：通过 GEOMETRY_CACHE_VERSION 失效
 *
 * 关联文档：docs/architecture/dev-geometry.md、docs/software-spec.md
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { discoverGeometriesFromDevPath, type DiscoveredGeometries, type DiscoveredModGeometry, type DiscoveredStlGeometry } from './modGeometryDiscovery.js';
import { getFileEntryResolver } from '../gim/entryResolver.js';
import { DEBUG_GIM_CACHE } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { getFileByPath } from '../gim/fileLookup.js';
import { invalidGeometryExtent, GEOMETRY_MAX_EXTENT_M } from '../viewer/geometryBounds.js';
import {
  disposeXmlModGroup,
  XML_MOD_GEOMETRY_DIAGNOSTICS_KEY,
  type XmlModGeometryDiagnostics,
} from '../viewer/xmlModLoader.js';
import type { GeometryDiagnosticReason } from '../gim/geometry/geometryDiagnostics.js';

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** One compiled DEV result is never larger than this. Split parts are bounded
 * by the same ceiling before the merged template is accepted. */
export const DEV_GLB_MAX_BYTES = 128 * 1024 * 1024;
/** Assembly-subtree split gate. Normal DEV templates stay one compile task. */
export const DEV_SPLIT_MIN_EDGES = 12;
export const DEV_SPLIT_MIN_BYTES = 6 * 1024 * 1024;
export const DEV_SPLIT_MAX_PARTS = 4;

export type DevGlbSerializationStatus = 'complete' | 'partial' | 'empty' | 'unsupported';

export interface DevGlbSerializationDiagnostics {
  status: DevGlbSerializationStatus;
  discoveredModCount: number;
  discoveredStlCount: number;
  renderableModCount: number;
  renderableStlCount: number;
  emptySourceCount: number;
  unsupportedSourceCount: number;
  partialSourceCount: number;
  unsupportedPrimitiveTypeCounts: Record<string, number>;
  reason?: GeometryDiagnosticReason;
  failedVisibleRootCount?: number;
  failedVisibleRoots?: { modPath: string; rootId: number; dependencies: { id: number; reason: string }[] }[];
  simplifiedBooleans?: number;
  representationPolicy?: 'outline' | 'detailed';
  approximatedBooleans?: Record<'Union' | 'Difference' | 'Intersection', number>;
  omittedSmallParts?: number;
  omittedMaxExtentMm?: number;
}

export interface DevGlbSerializationResult {
  /** Computed by the owning Worker before transferring the result. */
  sha256?: string;
  status: DevGlbSerializationStatus;
  bytes: Uint8Array | null;
  diagnostics: DevGlbSerializationDiagnostics;
  /** A real omitted outline candidate. Split parts report it but never add
   * their own silhouette; the DEV owner decides once after all parts finish. */
  smallFallback?: { referencePath: string; extent: number };
  /** Present only when the compiler asks the pool to split a very large DEV.
   * Split parts are merged back into one template before caching. */
  plan?: DevGeometryCompilePlan;
}

/** A balanced group of real assembly-subtree leaves. `referencePaths` identify
 * the discovered MOD/STL occurrences without inventing a second template
 * identity. */
export interface DevGeometryPart {
  key: string;
  referencePaths: string[];
  modCount: number;
  stlCount: number;
  estimatedBytes: number;
  /** Repeated occurrences count even when they reuse one source file. */
  estimatedInstanceWork: number;
  /** Exact discovered edges for this part. A part can compile without walking
   * the whole DEV/PHM graph again; identity stays the source DEV template. */
  mods: DiscoveredModGeometry[];
  stls: DiscoveredStlGeometry[];
}

export interface DevGeometryCompilePlan {
  canonicalDevPath: string;
  parts: DevGeometryPart[];
  modCount: number;
  stlCount: number;
  estimatedBytes: number;
  estimatedInstanceWork: number;
}

export interface DevCompilationAnalysis {
  canonicalDevPath: string;
  discovered: DiscoveredGeometries;
  plan: DevGeometryCompilePlan | null;
}

type GeometryEdge = DiscoveredModGeometry | DiscoveredStlGeometry;
const edgeReference = (edge: GeometryEdge): string => edge.referencePath || edge.instanceKey;
const edgeFile = (edge: GeometryEdge): string => 'modPath' in edge ? edge.modPath : edge.stlPath;

/** Unique referenced file bytes estimate parsing cost. Repeated instances of
 * one MOD count once here and separately in estimateInstanceWork(). */
function estimateEdgeBytes(edges: readonly GeometryEdge[], files: Map<string, File>): number {
  const paths = new Set<string>();
  let total = 0;
  for (const edge of edges) {
    const path = edgeFile(edge);
    if (paths.has(path)) continue;
    paths.add(path);
    total += Math.max(0, getFileByPath(files, path)?.size ?? 0);
  }
  return total;
}
function estimateInstanceWork(edges: readonly GeometryEdge[], files: Map<string, File>): number {
  return edges.reduce((total, edge) => total + Math.max(16 * 1024,
    Math.min(2 * 1024 * 1024, getFileByPath(files, edgeFile(edge))?.size ?? 0)), 0);
}
const partWork = (part: DevGeometryPart) => part.estimatedBytes + part.estimatedInstanceWork;

function partFromEdges(key: string, edges: readonly GeometryEdge[], files: Map<string, File>): DevGeometryPart {
  return {
    key,
    referencePaths: [...new Set(edges.map(edgeReference))].sort(),
    modCount: edges.filter(edge => 'modPath' in edge).length,
    stlCount: edges.filter(edge => 'stlPath' in edge).length,
    estimatedBytes: estimateEdgeBytes(edges, files),
    estimatedInstanceWork: estimateInstanceWork(edges, files),
    mods: edges.filter((edge): edge is DiscoveredModGeometry => 'modPath' in edge),
    stls: edges.filter((edge): edge is DiscoveredStlGeometry => 'stlPath' in edge),
  };
}

/** Keep real assembly subtrees intact while bounding the number of parts. */
function balanceParts(parts: DevGeometryPart[], maxParts: number): DevGeometryPart[] {
  if (parts.length <= maxParts) return parts;
  if(parts.length>64){
    // The source may expose thousands of direct children. The adjacent-pair
    // search below is quadratic; coalesce source-order runs in one pass first.
    const target=parts.reduce((sum,part)=>sum+partWork(part),0)/maxParts;
    const runs:DevGeometryPart[][]=[];let run:DevGeometryPart[]=[],work=0;
    for(const part of parts){
      run.push(part);work+=partWork(part);
      if(work>=target&&runs.length<maxParts-1){runs.push(run);run=[];work=0;}
    }
    if(run.length)runs.push(run);
    return runs.map(rows=>rows.reduce((left,right)=>({
      key:`${left.key}+${right.key}`,referencePaths:[...left.referencePaths,...right.referencePaths].sort(),
      modCount:left.modCount+right.modCount,stlCount:left.stlCount+right.stlCount,
      estimatedBytes:left.estimatedBytes+right.estimatedBytes,
      estimatedInstanceWork:left.estimatedInstanceWork+right.estimatedInstanceWork,
      mods:[...left.mods,...right.mods],stls:[...left.stls,...right.stls],
    })));
  }
  const list = parts.slice();
  while (list.length > maxParts) {
    let best = -1, bestCost = Infinity;
    for (let i = 0; i < list.length - 1; i++) {
      const cost = partWork(list[i]) + partWork(list[i + 1]);
      if (cost < bestCost) { bestCost = cost; best = i; }
    }
    const [left, right] = [list[best], list[best + 1]];
    list.splice(best, 2, {
      key: `${left.key}+${right.key}`,
      referencePaths: [...new Set([...left.referencePaths, ...right.referencePaths])].sort(),
      modCount: left.modCount + right.modCount,
      stlCount: left.stlCount + right.stlCount,
      estimatedBytes: left.estimatedBytes + right.estimatedBytes,
      estimatedInstanceWork: left.estimatedInstanceWork + right.estimatedInstanceWork,
      mods: [...left.mods, ...right.mods],
      stls: [...left.stls, ...right.stls],
    });
  }
  return list;
}

/**
 * Decide whether a DEV is large enough to compile by assembly subtree.
 * Grouping starts at the real `solid:` / `sub:` edge, then descends into PHM
 * segments. A single dense PHM has no intermediate subtree node, so its
 * leaves are chunked in source order as the documented MOD-task fallback.
 */
export function buildDevCompilePlan(
  discovered: DiscoveredGeometries,
  files: Map<string, File>,
  maxParts = DEV_SPLIT_MAX_PARTS,
  canonicalDevPath = '',
): DevGeometryCompilePlan | null {
  const edges: GeometryEdge[] = [...discovered.mods, ...discovered.stls];
  if (edges.length < DEV_SPLIT_MIN_EDGES) return null;
  const estimatedBytes = estimateEdgeBytes(edges, files);
  const estimatedInstanceWork = estimateInstanceWork(edges, files);
  // Split only when parsing or repeated occurrence/export work can amortize
  // the per-part GLB export and final merge cost.
  if (estimatedBytes < DEV_SPLIT_MIN_BYTES && estimatedInstanceWork < DEV_SPLIT_MIN_BYTES) return null;
  const cap = Math.max(2, Math.min(DEV_SPLIT_MAX_PARTS, Math.floor(maxParts)));
  const segments = (edge: GeometryEdge): string[] => edgeReference(edge).split('/').filter(Boolean);

  const first = new Map<string, GeometryEdge[]>();
  for (const edge of edges) {
    const key = segments(edge)[0] ?? edgeReference(edge);
    const rows = first.get(key) ?? []; rows.push(edge); first.set(key, rows);
  }
  let parts = balanceParts([...first].sort(([a],[b])=>a.localeCompare(b))
    .map(([key,rows])=>partFromEdges(key,rows,files)),cap);
  // Repeatedly split the heaviest *actual* subtree. At capacity merge the two
  // lightest neighboring parts first, then spend the freed slot on that subtree.
  for(let attempts=0;attempts<cap*4;attempts++){
    const total=parts.reduce((sum,part)=>sum+partWork(part),0);
    const largest=[...parts].sort((a,b)=>partWork(b)-partWork(a))[0];
    if(!largest||largest.referencePaths.length<2||parts.length>1&&partWork(largest)<=total/cap*1.5)break;
    const refs=new Map<string,GeometryEdge[]>();
    for(const edge of [...largest.mods,...largest.stls]){
      const key=edgeReference(edge),rows=refs.get(key)??[];rows.push(edge);refs.set(key,rows);
    }
    if(refs.size<2)break; // one indivisible source occurrence
    const depth=largest.key.split('/').filter(Boolean).length;
    const branches=new Map<string,GeometryEdge[]>();
    for(const [,rows] of refs){const key=segments(rows[0])[depth]??'';const branch=branches.get(key)??[];branch.push(...rows);branches.set(key,branch);}
    let children:DevGeometryPart[];
    if(branches.size>=2 && branches.size<=cap && !branches.has('')) children=[...branches].sort(([a],[b])=>a.localeCompare(b))
      .map(([key,rows])=>partFromEdges(`${largest.key}/${key}`,rows,files));
    else {
      // No deeper assembly node: balance atomic MOD/STL occurrence references.
      const atomic=[...refs].sort(([a],[b])=>a.localeCompare(b));
      const target=partWork(largest)/2;let sum=0,splitAt=0;
      for(let i=0;i<atomic.length-1;i++){sum+=partWork(partFromEdges(atomic[i][0],atomic[i][1],files));splitAt=i+1;if(sum>=target)break;}
      const left=atomic.slice(0,splitAt).flatMap(([,rows])=>rows),right=atomic.slice(splitAt).flatMap(([,rows])=>rows);
      children=[partFromEdges(`${largest.key}/mod-task:0`,left,files),partFromEdges(`${largest.key}/mod-task:1`,right,files)];
    }
    if(children.length<2)break;
    const next=parts.filter(part=>part!==largest).concat(children);
    parts=balanceParts(next,cap);
  }
  parts=parts.filter(part=>part.referencePaths.length>0);
  if (parts.length < 2) return null;
  return {
    canonicalDevPath,
    parts,
    modCount: discovered.mods.length,
    stlCount: discovered.stls.length,
    estimatedBytes,
    estimatedInstanceWork,
  };
}

/** Canonicalize and discover once. The caller can then either split the work or
 * serialize the already-discovered edges without traversing DEV/PHM twice. */
export async function analyzeDevCompilation(
  devPath: string,
  files: Map<string, File>,
  options: { discovery?: import('./modGeometryDiscovery.js').GeometryDiscoveryOptions } = {},
): Promise<DevCompilationAnalysis> {
  const normalizedDevPath = devPath.replace(/\\/g, '/');
  const canonicalDevPath = getFileEntryResolver(files)(normalizedDevPath) ?? normalizedDevPath;
  if (!getFileByPath(files, canonicalDevPath)) {
    throw new Error(`DEV 文件不存在，无法生成 GLB: ${canonicalDevPath}`);
  }
  const discovered = await discoverGeometriesFromDevPath(
    canonicalDevPath, files, IDENTITY_MATRIX.slice(), new Set<string>(), 0, { instances: 0 },
    { ...options.discovery, strictDependencies: true },
  );
  return { canonicalDevPath, discovered, plan: buildDevCompilePlan(discovered, files, DEV_SPLIT_MAX_PARTS, canonicalDevPath) };
}

export { InvalidDevGeometryError } from '../gim/geometry/sourceGeometryError.js';
import { InvalidDevGeometryError } from '../gim/geometry/sourceGeometryError.js';

/** 单例 GLTFLoader（内部无状态，可安全复用） */
let _gltfLoader: GLTFLoader | null = null;
function getGltfLoader(): GLTFLoader {
  if (!_gltfLoader) _gltfLoader = new GLTFLoader();
  return _gltfLoader;
}

/**
 * 把单个 DEV 文件引用的所有 MOD + STL 序列化为一个 GLB 二进制。
 *
 * 流程：
 * 1. discoverGeometriesFromDevPath（parentTransform=IDENTITY）获取 DEV 内部几何
 *    - 返回的 placementTransformMatrix = DEV × PHM（不含 CBM）
 * 2. 对每个 MOD/STL 加载 Group，applyPlacementTransformToSceneUnits 烘焙到顶点
 * 3. 所有 Group 合并到 devGroup
 * 4. GLTFExporter 序列化 devGroup → GLB bytes
 *
 * placement 烘焙策略：
 * - 烘焙到 .glb：Entity.TransformMatrix + mm→m + DEV × PHM × SUBDEVICE
 * - 不烘焙：CBM 累积矩阵（运行时由加载方应用）
 *
 * @param devPath DEV 文件路径（如 "DEV/abc.dev"）
 * @param files GIM 解压后的文件集合
 * @returns GLB 二进制 bytes；无几何引用返回 null；缺失/序列化失败抛错
 */
export async function serializeDevToGlbDetailed(
  devPath: string,
  files: Map<string, File>,
  options: {
    parseXml?: typeof import('../gim/geometry/xmlModParser.js').parseXmlMod;
    discovery?: import('./modGeometryDiscovery.js').GeometryDiscoveryOptions;
    lod?: import('../viewer/xmlModGeometry.js').DeviceLod;
    timings?: Record<string, number>;
    onStage?:import('../measurement/core.js').StageObserver;
    /** Pre-discovered edges from analyzeDevCompilation. */
    canonicalDevPath?: string;
    discovered?: DiscoveredGeometries;
    /** Compile one assembly-subtree part; exact occurrence reference paths. */
    partition?: { referencePaths: readonly string[]; allowSmallFallback?: boolean };
  } = {},
): Promise<DevGlbSerializationResult> {
  // A missing DEV is a cache failure, not a deterministic empty result. The
  // discovery helper intentionally treats missing references as empty for the
  // interactive XML fallback, but the geometry manifest must not record that
  // failure as `empty`.
  const normalizedDevPath = devPath.replace(/\\/g, '/');
  const canonicalDevPath = options.canonicalDevPath
    ?? getFileEntryResolver(files)(normalizedDevPath) ?? normalizedDevPath;
  if (!getFileByPath(files, canonicalDevPath)) {
    throw new Error(`DEV 文件不存在，无法生成 GLB: ${canonicalDevPath}`);
  }

  // 1. 发现 DEV 内部所有 MOD/STL 几何（parentTransform = IDENTITY，不含 CBM）
  const analyzed = options.discovered ?? await discoverGeometriesFromDevPath(
    canonicalDevPath,
    files,
    IDENTITY_MATRIX.slice(),
    new Set<string>(),
    0,
    { instances: 0 },
    { ...options.discovery, strictDependencies: true },
  );
  // A split part filters real discovered occurrences. The DEV/PHM traversal is
  // shared, so a part cannot invent references or lose sibling identity.
  const allowed = options.partition ? new Set(options.partition.referencePaths) : null;
  const discovered: DiscoveredGeometries = allowed ? {
    mods: analyzed.mods.filter(edge => allowed.has(edgeReference(edge))),
    stls: analyzed.stls.filter(edge => allowed.has(edgeReference(edge))),
    ...(analyzed.reason ? { reason: analyzed.reason } : {}),
  } : analyzed;

  const diagnostics: DevGlbSerializationDiagnostics = {
    status: 'empty',
    discoveredModCount: discovered.mods.length,
    discoveredStlCount: discovered.stls.length,
    renderableModCount: 0,
    renderableStlCount: 0,    emptySourceCount: 0,
    unsupportedSourceCount: 0,
    partialSourceCount: 0,
    unsupportedPrimitiveTypeCounts: {},
  };

  if (discovered.mods.length === 0 && discovered.stls.length === 0) {
    diagnostics.reason = discovered.reason ?? 'dev-no-solidmodel';
    return { status: 'empty', bytes: null, diagnostics };
  }
  let sawEmptyDeviceXml = false;

  // 2. 加载所有 MOD + STL，烘焙 placement 到顶点，合并到 devGroup
  const { loadXmlModFromFiles, applyPlacementTransformToSceneUnits } =
    await import('../viewer/xmlModLoader.js');
  const { parseStlBinary } = await import('../viewer/stlLoader.js');
  const { applyPhmColorOverride } = await import('../viewer/xmlModGeometry.js');

  const devGroup = new THREE.Group();
  devGroup.name = `glb-dev:${canonicalDevPath}`;
  devGroup.userData.devPath = canonicalDevPath;

  let modLoaded = 0;
  let stlLoaded = 0;
  const hasRenderableGeometry = (group: THREE.Group): boolean => {
    let found = false;
    group.traverse((object) => {
      if (found) return;
      const mesh = object as THREE.Mesh;
      const position = mesh.geometry?.getAttribute?.('position');
      if (mesh.isMesh && position && position.count > 0) found = true;
    });
    return found;
  };
  const readXmlDiagnostics = (group: THREE.Group): XmlModGeometryDiagnostics | undefined => {
    const value = group.userData[XML_MOD_GEOMETRY_DIAGNOSTICS_KEY];
    if (!value || typeof value !== 'object') return undefined;
    return value as XmlModGeometryDiagnostics;
  };
  const addUnsupportedCounts = (counts: Record<string, number>): void => {
    for (const [type, count] of Object.entries(counts)) {
      diagnostics.unsupportedPrimitiveTypeCounts[type] =
        (diagnostics.unsupportedPrimitiveTypeCounts[type] ?? 0) + count;
    }
  };
  const disposeStlGroup = (group: THREE.Group): void => {
    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : mesh.material ? [mesh.material] : [];
      for (const material of materials) material?.dispose?.();
    });
  };
  const disposeSourceGroup = (group: THREE.Group): void => {
    // XML MOD/GL groups use the process-wide primitive/material caches. Only
    // their merged geometry and instance-owned materials may be released.
    if (readXmlDiagnostics(group)) disposeXmlModGroup(group);
    else disposeStlGroup(group);
  };

  let smallFallback: { geo: typeof discovered.mods[number]; extent: number } | undefined;
  // 加载 MOD
  for (const geo of discovered.mods) {
    try {
      const group = await loadXmlModFromFiles(
        geo.modPath,
        files,
        geo.phmColor,
        geo.phmColorMaxA,
        { strict: true, parseXml: options.parseXml, lod: options.lod, timings: options.timings, onStage:options.onStage,
          outline: { placementMatrix: geo.placementTransformMatrix, deferSmallPartFallback: true } },
      );
      if (!group) continue;
      const xmlDiagnostics = readXmlDiagnostics(group);
      if (xmlDiagnostics) {
        if (xmlDiagnostics.status === 'empty' && !xmlDiagnostics.omittedSmallParts) sawEmptyDeviceXml = true;
        addUnsupportedCounts(xmlDiagnostics.unsupportedPrimitiveTypeCounts);
        diagnostics.failedVisibleRootCount = (diagnostics.failedVisibleRootCount ?? 0) + (xmlDiagnostics.failedVisibleRoots?.length ?? 0);
        diagnostics.failedVisibleRoots ??= [];
        for (const failure of xmlDiagnostics.failedVisibleRoots ?? []) if (diagnostics.failedVisibleRoots.length < 64)
          diagnostics.failedVisibleRoots.push({ modPath: geo.modPath, ...failure });
        diagnostics.representationPolicy = xmlDiagnostics.representationPolicy;
        diagnostics.approximatedBooleans ??= { Union: 0, Difference: 0, Intersection: 0 };
        for (const op of ['Union', 'Difference', 'Intersection'] as const)
          diagnostics.approximatedBooleans[op] += xmlDiagnostics.approximatedBooleans?.[op] ?? 0;
        diagnostics.omittedSmallParts = (diagnostics.omittedSmallParts ?? 0) + (xmlDiagnostics.omittedSmallParts ?? 0);
        const extent = xmlDiagnostics.omittedMaxExtentMm ?? 0;
        if (xmlDiagnostics.omittedSmallParts && (!smallFallback || extent > smallFallback.extent
          || extent === smallFallback.extent && edgeReference(geo) < edgeReference(smallFallback.geo))) smallFallback = { geo, extent };
        diagnostics.omittedMaxExtentMm = Math.max(diagnostics.omittedMaxExtentMm ?? 0, extent);
        diagnostics.simplifiedBooleans = (diagnostics.simplifiedBooleans ?? 0) + (xmlDiagnostics.simplifiedBooleans ?? 0);
      }
      // EMPTY_DEVICE_XML and MODs whose parsed entities have no supported
      // renderable primitive are deterministic empty geometry. Do not add an
      // empty Group to the exported scene: an otherwise-empty DEV must become
      // the explicit `empty` manifest state, while mixed DEV content keeps its
      // real meshes only.
      if (!hasRenderableGeometry(group)) {
        if (!xmlDiagnostics || xmlDiagnostics.status === 'empty' && !xmlDiagnostics.omittedSmallParts) diagnostics.emptySourceCount++;
        if (xmlDiagnostics && xmlDiagnostics.status !== 'empty') diagnostics.unsupportedSourceCount++;
        disposeSourceGroup(group);
        continue;
      }
      // 烘焙 DEV × PHM placement 到顶点（含 mm→m）
      applyPlacementTransformToSceneUnits(group, geo.placementTransformMatrix);
      group.userData.devPath = geo.devPath;
      group.userData.assemblyPath = geo.assemblyPath;
      group.userData.referencePath = geo.referencePath;
      devGroup.add(group);
      modLoaded++;
      diagnostics.renderableModCount++;
      if (xmlDiagnostics?.status === 'partial') diagnostics.partialSourceCount++;
    } catch (err) {
      const strictError = new Error(`DEV ${canonicalDevPath} 内 MOD 加载失败: ${geo.modPath}`);
      (strictError as Error & { cause?: unknown }).cause = err;
      throw strictError;
    }
  }

  // 加载 STL
  for (const geo of discovered.stls) {
    try {
      const file = getFileByPath(files, geo.stlPath);
      if (!file) throw new Error(`STL 文件不存在: ${geo.stlPath}`);
      const buffer = await file.arrayBuffer();
      const group = parseStlBinary(buffer, geo.stlPath);
      if (!group) throw new Error(`STL 解析失败: ${geo.stlPath}`);
      if (!hasRenderableGeometry(group)) {
        diagnostics.emptySourceCount++;
        disposeSourceGroup(group);
        continue;
      }
      applyPhmColorOverride(group, geo.phmColor, geo.phmColorMaxA);
      // 烘焙 DEV × PHM placement 到顶点（含 mm→m）
      applyPlacementTransformToSceneUnits(group, geo.placementTransformMatrix);
      group.userData.devPath = geo.devPath;
      group.userData.assemblyPath = geo.assemblyPath;
      group.userData.referencePath = geo.referencePath;
      devGroup.add(group);
      stlLoaded++;
      diagnostics.renderableStlCount++;
    } catch (err) {
      const strictError = new Error(`DEV ${canonicalDevPath} 内 STL 加载失败: ${geo.stlPath}`);
      (strictError as Error & { cause?: unknown }).cause = err;
      throw strictError;
    }
  }

  // All-small geometry is not a source-empty DEV. Retry only the largest
  // omitted source, keeping one real silhouette instead of hiding the device.
  if (devGroup.children.length === 0 && smallFallback && (!options.partition || options.partition.allowSmallFallback)) {
    const geo = smallFallback.geo;
    const group = await loadXmlModFromFiles(geo.modPath, files, geo.phmColor, geo.phmColorMaxA,
      { strict: true, parseXml: options.parseXml, lod: options.lod,
        outline: { placementMatrix: geo.placementTransformMatrix } });
    if (group && hasRenderableGeometry(group)) {
      applyPlacementTransformToSceneUnits(group, geo.placementTransformMatrix);
      group.userData.devPath = geo.devPath; group.userData.assemblyPath = geo.assemblyPath; group.userData.referencePath = geo.referencePath;
      devGroup.add(group); modLoaded++; diagnostics.renderableModCount++;
      if (readXmlDiagnostics(group)?.status === 'partial') diagnostics.partialSourceCount++;
    } else if (group) disposeSourceGroup(group);
  }
  if (devGroup.children.length === 0) {
    // All referenced files were present and parsed, but none contained a
    // renderable primitive (for example EMPTY_DEVICE_XML or an intentionally
    // empty placeholder MOD).  This is a deterministic empty DEV, not a
    // dependency/parse failure; persist it as the manifest `empty` tombstone.
    diagnostics.status = diagnostics.unsupportedSourceCount > 0 ? 'unsupported' : 'empty';
    diagnostics.reason = diagnostics.unsupportedSourceCount > 0
      ? 'parser-unsupported'
      : sawEmptyDeviceXml ? 'empty-device-xml' : (discovered.reason ?? 'assembly-node-without-own-geometry');
    return { status: diagnostics.status, bytes: null, diagnostics,
      ...(smallFallback ? {smallFallback:{referencePath:edgeReference(smallFallback.geo),extent:smallFallback.extent}} : {}) };
  }

  diagnostics.status = diagnostics.unsupportedSourceCount > 0
    || diagnostics.partialSourceCount > 0
    || diagnostics.emptySourceCount > 0
    ? 'partial'
    : 'complete';

  debugLog(DEBUG_GIM_CACHE, `[glbCache] DEV ${canonicalDevPath}: ${modLoaded} MOD + ${stlLoaded} STL 合并完成`);

  // Finite source coordinates can still be corrupt. Reject before exporting
  // and publishing a normal GLB, using the existing scene extent budget.
  // Do not clamp source values or remove entities and label the DEV complete.
  const invalidExtent = invalidGeometryExtent(devGroup);
  if (invalidExtent) {
    for (const child of [...devGroup.children]) {
      devGroup.remove(child);
      disposeSourceGroup(child as THREE.Group);
    }
    // Verify source placements independently of primitive mesh construction.
    // An arbitrary renderer/serializer failure is never a source tombstone.
    const { parseXmlMod } = await import('../gim/geometry/xmlModParser.js');
    const origins = new THREE.Box3();
    const sources: string[] = [];
    for (const edge of discovered.mods) {
      const file=getFileByPath(files,edge.modPath);
      if (!file) throw new Error(`Source evidence missing: ${edge.modPath}`);
      const doc=(options.parseXml ?? parseXmlMod)(await file.text(),edge.modPath);
      for (const entity of doc.entities) {
        if (!entity.visible) continue;
        const point=new THREE.Vector3().applyMatrix4(new THREE.Matrix4().fromArray(entity.transformMatrix))
          .applyMatrix4(new THREE.Matrix4().fromArray(edge.placementTransformMatrix)).multiplyScalar(0.001);
        origins.expandByPoint(point);
        if (sources.length<8 && point.length()>GEOMETRY_MAX_EXTENT_M) sources.push(`${edge.modPath} Entity ${entity.id}: ${entity.transformMatrix.join(',')}`);
      }
    }
    const span=origins.getSize(new THREE.Vector3());
    const sourceEvidence=Number.isFinite(span.length()) && Math.max(span.x,span.y,span.z)>GEOMETRY_MAX_EXTENT_M
      ? `source-origin-span-v1: ${span.toArray().join(',')}; ${sources.join('; ')}` : undefined;
    throw new InvalidDevGeometryError(canonicalDevPath, `${invalidExtent}; sources: ${[...discovered.mods.map(r=>r.modPath),...discovered.stls.map(r=>r.stlPath)].join(", ")}`, sourceEvidence);
  }

  // 3. 序列化 devGroup → GLB
  const exportStarted = performance.now();
  try {
    const bytes = await exportGroupToGlb(devGroup, canonicalDevPath);
    if (options.timings) options.timings.exportWallMs = (options.timings.exportWallMs ?? 0) + performance.now() - exportStarted;
    return { status: diagnostics.status, bytes, diagnostics };
  } finally {
    for (const child of [...devGroup.children]) {
      devGroup.remove(child);
      disposeSourceGroup(child as THREE.Group);
    }
  }
}

function exportGroupToGlb(group: THREE.Group, devPath: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      group,
      (gltf) => {
        if (gltf instanceof ArrayBuffer) resolve(new Uint8Array(gltf));
        else reject(new Error(`GLTFExporter 输出类型无效: ${devPath}`));
      },
      (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        reject(new Error(`DEV 序列化失败: ${devPath}: ${detail}`));
      },
      { binary: true },
    );
  });
}

/** Sum the diagnostics of assembly-subtree parts without pretending each part
 * was a complete DEV. */
export function aggregateDevGlbDiagnostics(results: readonly DevGlbSerializationResult[]): DevGlbSerializationDiagnostics {
  const aggregate: DevGlbSerializationDiagnostics = {
    status: 'empty',
    discoveredModCount: 0,
    discoveredStlCount: 0,
    renderableModCount: 0,
    renderableStlCount: 0,
    emptySourceCount: 0,
    unsupportedSourceCount: 0,
    partialSourceCount: 0,
    unsupportedPrimitiveTypeCounts: {},
    failedVisibleRootCount: 0,
    failedVisibleRoots: [],
    approximatedBooleans: { Union: 0, Difference: 0, Intersection: 0 },
    omittedSmallParts: 0,
    omittedMaxExtentMm: 0,
    simplifiedBooleans: 0,
  };
  const hasBytes = results.some(result => !!result.bytes?.byteLength);
  for (const result of results) {
    const d = result.diagnostics;
    aggregate.discoveredModCount += d.discoveredModCount;
    aggregate.discoveredStlCount += d.discoveredStlCount;
    aggregate.renderableModCount += d.renderableModCount;
    aggregate.renderableStlCount += d.renderableStlCount;
    aggregate.emptySourceCount += d.emptySourceCount;
    aggregate.unsupportedSourceCount += d.unsupportedSourceCount;
    aggregate.partialSourceCount += d.partialSourceCount;
    aggregate.omittedSmallParts = (aggregate.omittedSmallParts ?? 0) + (d.omittedSmallParts ?? 0);
    aggregate.omittedMaxExtentMm = Math.max(aggregate.omittedMaxExtentMm ?? 0, d.omittedMaxExtentMm ?? 0);
    aggregate.simplifiedBooleans = (aggregate.simplifiedBooleans ?? 0) + (d.simplifiedBooleans ?? 0);
    aggregate.failedVisibleRootCount = (aggregate.failedVisibleRootCount ?? 0) + (d.failedVisibleRootCount ?? 0);
    if (!aggregate.representationPolicy || d.representationPolicy === 'detailed') aggregate.representationPolicy = d.representationPolicy;
    for (const [type, count] of Object.entries(d.unsupportedPrimitiveTypeCounts)) {
      aggregate.unsupportedPrimitiveTypeCounts[type] = (aggregate.unsupportedPrimitiveTypeCounts[type] ?? 0) + count;
    }
    for (const op of ['Union', 'Difference', 'Intersection'] as const) {
      aggregate.approximatedBooleans![op] += d.approximatedBooleans?.[op] ?? 0;
    }
    for (const failure of d.failedVisibleRoots ?? []) {
      if ((aggregate.failedVisibleRoots?.length ?? 0) < 64) aggregate.failedVisibleRoots!.push(failure);
    }
    if (!aggregate.reason && d.reason) aggregate.reason = d.reason;
  }
  if (!aggregate.failedVisibleRoots?.length) delete aggregate.failedVisibleRoots;
  if (!aggregate.failedVisibleRootCount) delete aggregate.failedVisibleRootCount;
  if (!aggregate.approximatedBooleans || !Object.values(aggregate.approximatedBooleans).some(Boolean)) delete aggregate.approximatedBooleans;
  if (!aggregate.omittedSmallParts) delete aggregate.omittedSmallParts;
  if (!aggregate.omittedMaxExtentMm) delete aggregate.omittedMaxExtentMm;
  if (!aggregate.simplifiedBooleans) delete aggregate.simplifiedBooleans;
  aggregate.status = hasBytes
    ? results.some(result => result.status !== 'complete') ? 'partial' : 'complete'
    : results.some(result => result.status === 'unsupported') ? 'unsupported' : 'empty';
  return aggregate;
}

function disposeLoadedScene(scene: THREE.Object3D): void {
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) material?.dispose?.();
  });
}

/**
 * Merge independently compiled assembly-subtree GLBs into one DEV template.
 * Each part already has its DEV × PHM placement baked, so adding the parsed
 * scenes under one root preserves the exact world geometry. The result keeps
 * the single-template cache contract; parts never become second identities.
 */
export async function mergeDevGlbParts(devPath: string, parts: readonly Uint8Array[]): Promise<Uint8Array> {
  if (!parts.length) throw new Error(`DEV GLB split has no parts: ${devPath}`);
  const merged = new THREE.Group();
  merged.name = `glb-dev:${devPath}`;
  const scenes: THREE.Object3D[] = [];
  try {
    for (const bytes of parts) {
      const asset = await parseDevGlbAsset(devPath, bytes);
      if (!asset) throw new Error(`DEV GLB part parse failed: ${devPath}`);
      scenes.push(asset.scene); merged.add(asset.scene);
    }
    const invalidExtent = invalidGeometryExtent(merged);
    if (invalidExtent) throw new Error(`DEV merged geometry rejected: ${devPath}: ${invalidExtent}`);
    return await exportGroupToGlb(merged, devPath);
  } finally {
    for (const scene of scenes) { merged.remove(scene); disposeLoadedScene(scene); }
  }
}

/** Compatibility wrapper retained for the existing progressive/runtime APIs. */
export async function serializeDevToGlb(
  devPath: string,
  files: Map<string, File>,
): Promise<Uint8Array | null> {
  const result = await serializeDevToGlbDetailed(devPath, files);
  return result.bytes;
}

// ===== GLB 加载（方案 C v2：DEV 粒度缓存命中路径） =====

/**
 * 从 GLB 二进制加载 DEV Group。
 *
 * 加载后的 Group 包含 DEV 内部所有 MOD + STL（placement 已烘焙）。
 * 调用方需额外应用 CBM 累积矩阵（applyPlacementTransformToSceneUnits）。
 *
 * @param devPath DEV 文件路径（用于日志）
 * @param glbBytes GLB 二进制字节
 * @returns THREE.Group；加载失败返回 null
 */
export function loadDevGlb(
  devPath: string,
  glbBytes: Uint8Array,
): Promise<THREE.Group | null> {
  return parseDevGlbAsset(devPath, glbBytes).then((asset) => asset?.scene ?? null);
}

/**
 * Parse a DEV GLB and retain the small amount of GLTF metadata needed by the
 * session-local template validator.  `loadDevGlb` remains the compatibility
 * helper for legacy callers and returns only the scene.
 */
export function parseDevGlbAsset(
  devPath: string,
  glbBytes: Uint8Array,
): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] } | null> {
  const loader = getGltfLoader();
  // GLTFLoader reads the binary input without transferring or modifying it.
  const ab = glbBytes.buffer instanceof ArrayBuffer && glbBytes.byteOffset === 0 && glbBytes.byteLength === glbBytes.buffer.byteLength
    ? glbBytes.buffer : glbBytes.slice().buffer as ArrayBuffer;

  return new Promise((resolve) => {
    loader.parse(
      ab,
      '',
      (gltf) => {
        const group = gltf.scene as THREE.Group;
        group.name = `glb-dev:${devPath}`;
        group.userData.devPath = devPath;
        resolve({ scene: group, animations: gltf.animations ?? [] });
      },
      (error) => {
        console.error(`[glbCache] DEV GLB 加载失败: ${devPath}`, error);
        resolve(null);
      },
    );
  });
}
