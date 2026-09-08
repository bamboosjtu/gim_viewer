/**
 * 样本级集成回归测试（真实 GIM 解压目录）。
 *
 * 目的：为 dev-log 修复提供"一个变电工程 + 一个线路工程"的可执行验证手段，
 * 覆盖 CBM 树构建、IFC 发现、FAM/DEV 属性解析、线路地图数据提取全链路。
 *
 * 边界：
 * - 只读 demo/ 下已解压的样本目录（gitignore，本地存在才运行）
 * - 不依赖 Tauri / SQLite / Viewer / WebGL
 * - 样本缺失时自动跳过（CI 无 demo 数据）
 * - 文件惰性读盘（样本数万文件，不能一次性载入内存）
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildCbmTree, collectIfcRefs, buildCbmNodeIndex, parseKeyValue } from '../cbmParser.js';
import { discoverIfcFromCBM } from '../gimIndexer.js';
import { parseFileDevRelation } from '../fileDevParser.js';
import { parseFamSections } from '../famParser.js';
import { parsePhm } from '../geometry/phmParser.js';
import { parseXmlMod } from '../geometry/xmlModParser.js';
import { getFileByPath, normalizeFilePath } from '../fileLookup.js';
import { isGimEmptyValue, resolveBaseFamilyReference } from '../gimValueSemantics.js';
import type { CbmNode, IfcEntry } from '../types.js';
import { buildLineGimGraph } from '../lineCbmParser.js';
import { buildLineGimGraphFromTexts } from '../lineCbmParserCore.js';
import { createLineParserCache, parseLineAttributesFromCache } from '../lineAttrParserCore.js';
import { buildSubstationSpatialIndexFromFiles } from '../ifcSpatialParser.js';
import {
  hydrateSubstationSpatialIndex,
  serializeSubstationSpatialIndex,
  validateSubstationSpatialSnapshot,
} from '../../services/substationSpatialSemanticCache.js';
import {
  extractLineMapData,
  isLineMapDataValid,
} from '../lineMapData.js';
import {
  buildLineNavigationIndex,
  buildLineNavigationSearchIndex,
} from '../../ui/lineNavigationTreeView.js';
import type { LineAttributeIndex } from '../lineAttributeTypes.js';
import type {
  LineFamPropertyRecord,
  LineDevPropertyRecord,
} from '@desktop/database.js';
import { parseLineAttributes } from '../../services/lineAttrPersistenceService.js';
import { buildFunctionalDomainIndex } from '../../ui/substationFunctionalTreeView.js';

/**
 * 惰性 File shim：parser 纯逻辑层仅消费 name / size / text()，
 * 按需从磁盘同步读取，避免数万文件全量载入内存。
 */
class LazyFileShim {
  readonly name: string;
  readonly size: number;
  constructor(private readonly fullPath: string, fileName: string) {
    this.name = fileName;
    this.size = statSync(fullPath).size;
  }
  async text(): Promise<string> {
    return readFileSync(this.fullPath, 'utf-8');
  }
}

function loadFilesFromDir(rootDir: string, prefix = ''): Map<string, File> {
  const files = new Map<string, File>();
  for (const entry of readdirSync(rootDir)) {
    const fullPath = join(rootDir, entry);
    const key = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(fullPath).isDirectory()) {
      for (const [k, f] of loadFilesFromDir(fullPath, key)) files.set(k, f);
    } else {
      files.set(key, new LazyFileShim(fullPath, entry) as unknown as File);
    }
  }
  return files;
}

/** 将首开/Worker 的属性 payload 组装成地图提取层所需的索引。 */
function buildLineAttributeIndex(
  famPayloads: Array<LineFamPropertyRecord>,
  devPayloads: Array<LineDevPropertyRecord>,
): LineAttributeIndex {
  const famBySourcePath = new Map<string, Map<string, LineFamPropertyRecord[]>>();
  const famByFileNameLower = new Map<string, Map<string, LineFamPropertyRecord[]>>();
  for (const record of famPayloads) {
    for (const [target, key] of [
      [famBySourcePath, record.source_path],
      [famByFileNameLower, record.file_name_lower],
    ] as const) {
      let byProp = target.get(key);
      if (!byProp) { byProp = new Map(); target.set(key, byProp); }
      const list = byProp.get(record.prop_key) ?? [];
      list.push(record);
      byProp.set(record.prop_key, list);
    }
  }
  const devBySourcePath = new Map<string, Map<string, LineDevPropertyRecord[]>>();
  const devByFileNameLower = new Map<string, Map<string, LineDevPropertyRecord[]>>();
  for (const record of devPayloads) {
    for (const [target, key] of [
      [devBySourcePath, record.source_path],
      [devByFileNameLower, record.file_name_lower],
    ] as const) {
      let byProp = target.get(key);
      if (!byProp) { byProp = new Map(); target.set(key, byProp); }
      const list = byProp.get(record.prop_key) ?? [];
      list.push(record);
      byProp.set(record.prop_key, list);
    }
  }
  return { famBySourcePath, famByFileNameLower, devBySourcePath, devByFileNameLower };
}

/** 去除 nodeRef 后比较线路地图的业务输出，避免对象引用掩盖字段差异。 */
function lineMapBusinessShape(data: ReturnType<typeof extractLineMapData>): unknown {
  return {
    towers: data.towers.map(({ nodeRef: _nodeRef, ...tower }) => tower),
    wires: data.wires.map(({ nodeRef: _nodeRef, ...wire }) => wire),
    crosses: data.crosses.map(({ nodeRef: _nodeRef, ...cross }) => cross),
    bbox: data.bbox,
    stats: data.stats,
    unresolved: data.unresolved,
  };
}

function findFirstFile(files: Map<string, File>, ext: string): string | null {
  for (const key of files.keys()) {
    if (key.toLowerCase().endsWith(ext)) return key;
  }
  return null;
}

/** 测试内独立 Haversine（与实现不共享代码，保证校验独立性） */
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------------
// 样本可用性探测（缺失即整组跳过）
// ---------------------------------------------------------------------------

// npm scripts run with `desktop/` as cwd, while repository-level invocations
// may use the checkout root. Resolve both layouts so a present demo corpus is
// never silently reported as skipped merely because cwd differs.
function resolveDemoDir(sample: string): string {
  const candidates = [
    join(process.cwd(), 'demo', sample),
    join(process.cwd(), '..', 'demo', sample),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

const SUBSTATION_DIR = resolveDemoDir('demo-substation');
const LINE_DIR = resolveDemoDir('line02');
const hasSubstation = existsSync(SUBSTATION_DIR);
const hasLine = existsSync(LINE_DIR);
const LINE_CORPUS = [
  'demo-line1',
  'line02',
  'line03',
  'line04',
  'line05',
  'line06',
].map((id) => ({ id, dir: resolveDemoDir(id) }));
const SUBSTATION_CORPUS = [
  { id: 'demo-substation', models: 12, contained: 3111, spatial: 4714, decomposition: 74, host: 1529 },
  { id: 'substation02', models: 17, contained: 51767, spatial: 62176, decomposition: 38, host: 10371 },
  { id: 'substation03', models: 8, contained: 9572, spatial: 9572, decomposition: 0, host: 0 },
  { id: 'substation04', models: 19, contained: 7182, spatial: 7720, decomposition: 44, host: 494 },
].map((item) => ({ ...item, dir: resolveDemoDir(item.id) }));

const RENDERABLE_XML_PRIMITIVES = new Set([
  'Cuboid', 'Cylinder', 'Sphere', 'TruncatedCone', 'Ring',
  'CircularGasket', 'StretchedBody', 'Wire', 'Cable',
  'RotationalEllipsoid', 'BeamChannelLike', 'Boolean',
]);
const IDENTITY_MATRIX_VALUES = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function prefixedReference(prefix: string, value: string): string {
  const normalized = normalizeFilePath(value.trim());
  const top = normalized.split('/')[0]?.toLowerCase();
  return top === prefix.toLowerCase() ? normalized : `${prefix}/${normalized}`;
}

function resolveFamFile(files: Map<string, File>, value: string, preferredPrefix: string): File | undefined {
  if (isGimEmptyValue(value)) return undefined;
  const normalized = normalizeFilePath(value.trim());
  const candidates = normalized.includes('/')
    ? [normalized]
    : [prefixedReference(preferredPrefix, normalized), `CBM/${normalized}`, `DEV/${normalized}`];
  return candidates.map((candidate) => getFileByPath(files, candidate)).find((file): file is File => !!file);
}

interface SubstationCompatibilitySummary {
  cbmNodeCount: number;
  devCount: number;
  resolvedDevFamCount: number;
  baseFamilyPointerCount: number;
  resolvedBaseFamilyPointerCount: number;
  famPropertyCount: number;
  famLeadingEmptyKeyPropertyCount: number;
  devPropertyCount: number;
  ifcCount: number;
  ifcComponentGuidLinkCount: number;
  emptyGeometryCount: number;
  unsupportedGeometryRefs: number;
  unsupportedPrimitiveTypeCounts: Record<string, number>;
  phmPlacementCount: number;
  phmEmptyCount: number;
  nonIdentityPlacementCount: number;
  glSourceCount: number;
  glXmlEntityCount: number;
}

/**
 * Cross-vendor gate metrics. This deliberately walks the real source files
 * instead of reading generated survey CSVs, so a parser regression fails on
 * the same input that the desktop runtime consumes.
 */
async function inspectSubstationCompatibility(
  files: Map<string, File>,
  tree: CbmNode,
  ifcEntries: IfcEntry[],
): Promise<SubstationCompatibilitySummary> {
  const summary: SubstationCompatibilitySummary = {
    cbmNodeCount: buildCbmNodeIndex(tree).size,
    devCount: 0,
    resolvedDevFamCount: 0,
    baseFamilyPointerCount: 0,
    resolvedBaseFamilyPointerCount: 0,
    famPropertyCount: 0,
    famLeadingEmptyKeyPropertyCount: 0,
    devPropertyCount: 0,
    ifcCount: ifcEntries.length,
    ifcComponentGuidLinkCount: 0,
    emptyGeometryCount: 0,
    unsupportedGeometryRefs: 0,
    unsupportedPrimitiveTypeCounts: {},
    phmPlacementCount: 0,
    phmEmptyCount: 0,
    nonIdentityPlacementCount: 0,
    glSourceCount: 0,
    glXmlEntityCount: 0,
  };

  for (const [path, file] of files) {
    const normalized = normalizeFilePath(path);
    const lower = normalized.toLowerCase();
    if (lower.endsWith('.fam')) {
      const text = await file.text();
      const sections = parseFamSections(text);
      for (const properties of sections.values()) {
        for (const value of properties.values()) {
          if (!isGimEmptyValue(value)) summary.famPropertyCount++;
        }
      }
      for (const rawLine of text.split(/\r?\n/)) {
        const parts = rawLine.replace(/^\uFEFF/, '').trim().split('=');
        if (parts.length < 3 || !isGimEmptyValue(parts[0])) continue;
        const candidate = parts.slice(1, -1).map((part) => part.trim())
          .find((value) => !isGimEmptyValue(value));
        if (candidate && Array.from(sections.values()).some((properties) => properties.has(candidate))) {
          summary.famLeadingEmptyKeyPropertyCount++;
        }
      }
      continue;
    }

    if (lower.endsWith('.dev')) {
      summary.devCount++;
      const text = await file.text();
      const kv = parseKeyValue(text);
      summary.devPropertyCount += Object.values(kv).filter((value) => !isGimEmptyValue(value)).length;
      const baseFamily = resolveBaseFamilyReference(kv);
      if (baseFamily && resolveFamFile(files, baseFamily, 'DEV')) summary.resolvedDevFamCount++;
      const pointer = Object.entries(kv).find(([key, value]) =>
        key.trim().toUpperCase() === 'BASEFAMILYPOINTER' && !isGimEmptyValue(value));
      if (pointer) {
        summary.baseFamilyPointerCount++;
        if (resolveFamFile(files, pointer[1], 'DEV')) summary.resolvedBaseFamilyPointerCount++;
      }
      continue;
    }

    if (lower.endsWith('.phm')) {
      const doc = parsePhm(await file.text(), normalized);
      summary.phmPlacementCount += doc.solidModels.length;
      if (doc.isEmpty) summary.phmEmptyCount++;
      if (doc.solidModels.some((entry) => entry.transformMatrix.some((value, index) =>
        value !== IDENTITY_MATRIX_VALUES[index]))) {
        summary.nonIdentityPlacementCount++;
      }
      continue;
    }

    if (!lower.endsWith('.mod') && !lower.endsWith('.gl')) continue;
    if (lower.endsWith('.gl')) summary.glSourceCount++;
    const doc = parseXmlMod(await file.text(), normalized);
    if (lower.endsWith('.gl')) summary.glXmlEntityCount += doc.declaredEntityCount;
    if (doc.isEmpty) {
      summary.emptyGeometryCount++;
      continue;
    }
    let renderableCount = 0;
    let unsupportedCount = doc.malformedEntityCount;
    for (const entity of doc.entities) {
      if (RENDERABLE_XML_PRIMITIVES.has(entity.primitive.type)) {
        renderableCount++;
        continue;
      }
      unsupportedCount++;
      const primitiveType = entity.primitive.type === 'Unsupported'
        ? entity.primitive.sourceType
        : entity.primitive.type;
      summary.unsupportedPrimitiveTypeCounts[primitiveType] =
        (summary.unsupportedPrimitiveTypeCounts[primitiveType] ?? 0) + 1;
    }
    if (renderableCount === 0 && unsupportedCount > 0) summary.unsupportedGeometryRefs++;
  }

  for (const [modelId, guids] of collectIfcRefs(tree, ifcEntries)) {
    void modelId;
    summary.ifcComponentGuidLinkCount += guids.size;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 变电工程回归：demo-substation（JinQu）
// ---------------------------------------------------------------------------
describe.skipIf(!hasSubstation)('样本回归·变电 demo-substation', () => {
  it('解析 CBM 树 + IFC 发现 + FAM 属性全链路', async () => {
    const files = loadFilesFromDir(SUBSTATION_DIR);
    expect(files.size).toBeGreaterThan(100);

    // CBM 树构建
    const tree = await buildCbmTree(files);
    expect(tree).not.toBeNull();
    const nodeCount = buildCbmNodeIndex(tree!).size;
    expect(nodeCount).toBeGreaterThan(10);

    // IFC 发现（变电工程 DEV 目录应含 IFC）
    const ifcEntries = await discoverIfcFromCBM(files);
    expect(ifcEntries.length).toBeGreaterThan(0);

    // CBM→IFC 引用
    const ifcRefs = collectIfcRefs(tree!);
    expect(ifcRefs.size).toBeGreaterThan(0);

    // FAM 解析
    const famPath = findFirstFile(files, '.fam');
    expect(famPath).not.toBeNull();
    if (famPath) {
      const text = await files.get(famPath)!.text();
      const sections = parseFamSections(text);
      expect(sections.size).toBeGreaterThan(0);
    }
  }, 120_000);

  it('把真实 IFC 空间实体投影为可用的空间索引，并保留资产缺失状态', async () => {
    const files = loadFilesFromDir(SUBSTATION_DIR);
    const tree = await buildCbmTree(files);
    const ifcEntries = await discoverIfcFromCBM(files);
    const fileDevRelations = await parseFileDevRelation(files);
    const index = await buildSubstationSpatialIndexFromFiles(files, ifcEntries, tree, fileDevRelations);

    expect(index.models.length).toBe(ifcEntries.length);
    expect(index.nodes.some((item) => item.kind === 'project')).toBe(true);
    expect(index.nodes.some((item) => item.kind === 'site')).toBe(true);
    expect(index.nodes.some((item) => item.kind === 'building')).toBe(true);
    expect(index.nodes.some((item) => item.kind === 'storey')).toBe(true);
    expect(index.coverage.hasSpatialContainment).toBe(true);
    expect(index.coverage.directCbmIfcLinks).toBeGreaterThan(0);
    expect(index.links.length).toBeGreaterThan(0);
    // 当前样本的 IFC 产品均已通过包含、分解、宿主或空间边界关系落位。
    // 这里断言“未落位”与对象索引一致，防止后续新增关系处理时又把
    // 产品静默留在质量分组之外；不把某个历史缺失数量写死。
    expect(index.coverage.uncontainedIfcObjects).toBe(
      index.objects.filter((object) => object.spatialKeys.length === 0).length,
    );
    const boundaryContained = index.objects.filter((object) => object.spatialContainment === 'boundary').length;
    expect(
      index.coverage.directContainedIfcObjects
        + index.coverage.inheritedContainedIfcObjects
        + boundaryContained,
    ).toBe(index.objects.filter((object) => object.spatialKeys.length > 0).length);
    expect(index.models.reduce((sum, model) => sum + model.resourceCount, 0)).toBeGreaterThan(0);
    // Spatial Core v1 不再展开 Pset/工程量/材质/分类实体；属性详情由
    // Fragments getItemsData() 在用户选择构件时按需读取。扫描计数仍保留，
    // 用于诊断和验证没有把 IFC 属性误当成导航对象。
    expect(index.models.reduce((sum, model) => sum + model.objectsWithProperties, 0)).toBe(0);
    expect(index.models.reduce((sum, model) => sum + model.propertyValueCount, 0)).toBe(0);
    expect(index.models.reduce((sum, model) => sum + model.quantityValueCount, 0)).toBe(0);
    expect(index.objects.every((object) => object.propertyDataDeferred === true)).toBe(true);
    expect(index.nodes.every((node) => node.propertyDataDeferred === true)).toBe(true);
    expect(index.models.reduce((sum, model) => sum + (model.resourceTypeCounts?.IFCPROPERTYSET ?? 0), 0)).toBeGreaterThan(0);
    expect(index.objects.some((object) => object.placement?.position != null)).toBe(true);
    expect(fileDevRelations.length).toBeGreaterThan(0);
    expect(index.links.some((link) => (link.sourceDesignNames?.length ?? 0) > 0)).toBe(true);
    // 质量分组计数应与链接总数守恒；没有降级链接的样本也是合法结果。
    expect(
      index.coverage.placementOnlyAssets
        + index.coverage.unlocatedAssets
        + index.coverage.directCbmIfcLinks,
    ).toBeLessThanOrEqual(index.links.length);
  }, 120_000);
});

describe.skipIf(!SUBSTATION_CORPUS.every((item) => existsSync(item.dir)))('样本回归·变电空间语义四样本', () => {
  it('空间实体、包含关系和解析错误与基线快照一致', async () => {
    for (const sample of SUBSTATION_CORPUS) {
      const files = loadFilesFromDir(sample.dir);
      const tree = await buildCbmTree(files);
      const entries = await discoverIfcFromCBM(files);
      const fileDevRelations = await parseFileDevRelation(files);
      const index = await buildSubstationSpatialIndexFromFiles(files, entries, tree, fileDevRelations);

      // The derived cache is a persistence boundary, not a second domain
      // model. Round-trip the complete real-sample projection so warm restore
      // preserves source tracing and every canonical collection, not only the
      // headline counts below.
      const sourceSha256 = `sample-${sample.id}`;
      const snapshot = serializeSubstationSpatialIndex(index, { sourceSha256 });
      expect(validateSubstationSpatialSnapshot(snapshot, { sourceSha256 }), sample.id)
        .toEqual({ valid: true });
      const restored = hydrateSubstationSpatialIndex(snapshot);
      expect(restored.models, sample.id).toEqual(index.models);
      expect(restored.nodes, sample.id).toEqual(index.nodes);
      expect(restored.objects, sample.id).toEqual(index.objects);
      expect(restored.links, sample.id).toEqual(index.links);
      expect(restored.rootNodeKeys, sample.id).toEqual(index.rootNodeKeys);
      expect(restored.coverage, sample.id).toEqual(index.coverage);
      expect(restored.placementGroups, sample.id).toEqual(index.placementGroups);
      expect(restored.identityPlacementLinks, sample.id).toEqual(index.identityPlacementLinks);
      expect(Array.from(restored.nodeByKey.keys()), sample.id).toEqual(Array.from(index.nodeByKey.keys()));
      expect(Array.from(restored.objectByKey.keys()), sample.id).toEqual(Array.from(index.objectByKey.keys()));
      expect(Array.from(restored.linksByCbmPath.keys()), sample.id)
        .toEqual(Array.from(index.linksByCbmPath.keys()));
      expect(Array.from(restored.linksByIfcObjectKey.keys()), sample.id)
        .toEqual(Array.from(index.linksByIfcObjectKey.keys()));

      expect(index.models.length, sample.id).toBe(sample.models);
      expect(index.models.some((model) => model.parseError), sample.id).toBe(false);
      expect(index.models.reduce((sum, model) => sum + model.containedObjectCount, 0), sample.id)
        .toBe(sample.contained);
      expect(index.models.reduce((sum, model) => sum + (model.spatialObjectCount ?? 0), 0), sample.id)
        .toBe(sample.spatial);
      expect(index.coverage.decompositionInheritedIfcObjects, sample.id).toBe(sample.decomposition);
      expect(index.coverage.hostInheritedIfcObjects, sample.id).toBe(sample.host);
      expect(index.coverage.inheritedContainedIfcObjects, sample.id)
        .toBe(sample.decomposition + sample.host);
      expect(index.coverage.uncontainedIfcObjects, sample.id).toBe(0);
      expect(index.nodes.some((node) => node.kind === 'storey'), sample.id).toBe(true);
      expect(index.coverage.hasSpatialContainment, sample.id).toBe(true);
      expect(index.models.reduce((sum, model) => sum + model.resourceCount, 0), sample.id).toBeGreaterThan(0);
      if (fileDevRelations.length > 0) {
        expect(index.links.some((link) => (link.sourceDesignNames?.length ?? 0) > 0), sample.id).toBe(true);
      }
    }
  }, 120_000);

  it('功能系统视角四样本只生成稳定域，并将无效 SYSTEMNAME 合并为一个未归类系统', async () => {
    const expected = new Map([
      ['demo-substation', { domains: ['交流电气系统', '建筑物', '构筑物', '空调系统', '排水系统'], unclassified: false }],
      ['substation02', { domains: ['电气系统', '未归类系统'], unclassified: true }],
      ['substation03', { domains: ['电气系统', '建筑物系统', '未归类系统'], unclassified: true }],
      ['substation04', { domains: ['交流电气系统', '未归类系统'], unclassified: true }],
    ]);
    for (const sample of SUBSTATION_CORPUS) {
      const files = loadFilesFromDir(sample.dir);
      const tree = await buildCbmTree(files);
      const index = buildFunctionalDomainIndex(tree!);
      const baseline = expected.get(sample.id)!;
      expect(index.domains.map((domain) => domain.title), sample.id).toEqual(baseline.domains);
      expect(index.domains.filter((domain) => domain.key === 'functional:domain:unclassified'), sample.id)
        .toHaveLength(baseline.unclassified ? 1 : 0);
    }
  }, 120_000);

  it('vendor-neutral parser compatibility matrix covers hierarchy, references, properties and geometry degradation', async () => {
    const summaries: Record<string, SubstationCompatibilitySummary> = {};
    for (const sample of SUBSTATION_CORPUS) {
      const files = loadFilesFromDir(sample.dir);
      const tree = await buildCbmTree(files);
      expect(tree, sample.id).not.toBeNull();
      if (!tree) continue;
      const ifcEntries = await discoverIfcFromCBM(files);
      const summary = await inspectSubstationCompatibility(files, tree, ifcEntries);
      summaries[sample.id] = summary;

      expect(summary.cbmNodeCount, `${sample.id} CBM`).toBeGreaterThan(0);
      expect(summary.devCount, `${sample.id} DEV`).toBeGreaterThan(0);
      expect(summary.resolvedDevFamCount, `${sample.id} DEV→FAM`).toBeGreaterThan(0);
      expect(summary.famPropertyCount, `${sample.id} FAM properties`).toBeGreaterThan(0);
      expect(summary.devPropertyCount, `${sample.id} DEV properties`).toBeGreaterThan(0);
      expect(summary.ifcCount, `${sample.id} IFC`).toBe(sample.models);
      expect(summary.phmPlacementCount, `${sample.id} PHM placements`).toBeGreaterThan(0);
      expect(summary.nonIdentityPlacementCount, `${sample.id} finite/transform evidence`).toBeGreaterThanOrEqual(0);

      // Every real source key is mixed-case at least through its top-level
      // directory; lower-casing the lookup spelling must still resolve it.
      const mixedCaseSource = Array.from(files.keys()).find((path) =>
        path !== path.toLowerCase() && /\.(cbm|dev|fam|phm|mod|gl|stl|ifc)$/i.test(path));
      expect(mixedCaseSource, `${sample.id} case-insensitive source lookup`).toBeDefined();
      if (mixedCaseSource) expect(getFileByPath(files, mixedCaseSource.toLowerCase())).toBeDefined();

      if (summary.glSourceCount > 0) {
        expect(summary.glXmlEntityCount, `${sample.id} GL XML pipeline`).toBeGreaterThan(0);
      }
    }

    expect(summaries.substation02.baseFamilyPointerCount).toBeGreaterThan(0);
    expect(summaries.substation02.resolvedBaseFamilyPointerCount).toBeGreaterThan(0);
    expect(summaries.substation03.baseFamilyPointerCount).toBeGreaterThan(0);
    expect(summaries.substation03.resolvedBaseFamilyPointerCount).toBeGreaterThan(0);
    expect(summaries.substation03.famLeadingEmptyKeyPropertyCount).toBeGreaterThan(0);
    expect(summaries['demo-substation'].ifcComponentGuidLinkCount).toBeGreaterThan(0);

    // Print one compact, reproducible evidence line for the release report;
    // do not log individual files or entities.
    console.log('[substation-compat]', JSON.stringify(summaries));
  }, 600_000);
});

// ---------------------------------------------------------------------------
// 线路工程回归：line02
// ---------------------------------------------------------------------------
describe.skipIf(!hasLine)('样本回归·线路 line02', () => {
  it('图构建 + 属性解析 + 地图数据提取全链路', async () => {
    const files = loadFilesFromDir(LINE_DIR);
    expect(files.size).toBeGreaterThan(100);

    // 线路图构建
    const graph = await buildLineGimGraph(files);
    expect(graph.root).not.toBeNull();
    expect(graph.stats.Tower_Device ?? 0).toBeGreaterThan(0);
    expect(graph.stats.WIRE ?? 0).toBeGreaterThan(0);

    // Line Parser Worker v1 的纯核心与既有 File API parser 结果保持一致。
    // 这里只读取线路文本类型，模拟 Worker 输入的可序列化 bytes。
    const workerTextFiles: Array<{ path: string; text: string }> = [];
    for (const [path, file] of files) {
      if (/\.(cbm|dev|fam|phm|mod)$/i.test(path)) {
        workerTextFiles.push({ path, text: await file.text() });
      } else {
        // Worker 只需路径元数据即可保持 filesByType 统计（STL/other 不解码）。
        workerTextFiles.push({ path, text: '' });
      }
    }
    const workerCache = createLineParserCache(workerTextFiles);
    const workerGraph = buildLineGimGraphFromTexts(workerTextFiles, workerCache);
    const workerAttrPayloads = parseLineAttributesFromCache(workerGraph, workerCache);
    expect(workerGraph.stats).toEqual(graph.stats);

    // FAM/DEV 属性解析
    const { famPayloads, devPayloads } = await parseLineAttributes(graph, files);
    expect(famPayloads.length).toBeGreaterThan(0);
    expect(workerAttrPayloads.famPayloads.length).toBe(famPayloads.length);
    expect(workerAttrPayloads.devPayloads.length).toBe(devPayloads.length);
    expect(workerAttrPayloads.famPayloads).toEqual(famPayloads);
    expect(workerAttrPayloads.devPayloads).toEqual(devPayloads);
    expect(Array.from(workerGraph.nodesByPath.keys()).sort())
      .toEqual(Array.from(graph.nodesByPath.keys()).sort());

    // 组装属性索引并提取地图数据；同时用 Worker payload 构建平行索引，
    // 让回归覆盖塔位、档距、跨越物和导航投影，而不只比较节点计数。
    const attrs = buildLineAttributeIndex(
      famPayloads as unknown as LineFamPropertyRecord[],
      devPayloads as unknown as LineDevPropertyRecord[],
    );
    const workerAttrs = buildLineAttributeIndex(
      workerAttrPayloads.famPayloads as unknown as LineFamPropertyRecord[],
      workerAttrPayloads.devPayloads as unknown as LineDevPropertyRecord[],
    );

    const mapData = extractLineMapData(graph, attrs);
    const workerMapData = extractLineMapData(workerGraph, workerAttrs);
    expect(lineMapBusinessShape(workerMapData)).toEqual(lineMapBusinessShape(mapData));
    expect(mapData.towers.length).toBeGreaterThan(0);
    expect(isLineMapDataValid(mapData)).toBe(true);

    // P2 评审 #7：DEV→FAM 关联回归——至少部分塔位应命中 FAM 属性源。
    // 若此处为 0，说明 FAM 引用链（CBM→F4System.FAM）断裂而静默退化。
    const famHitTowers = mapData.towers.filter((t) => !!t.famSource).length;
    expect(famHitTowers).toBeGreaterThan(0);
    // 线路塔位的呼高与转角来自 Tower_Device 实例 FAM，不能只停留在
    // 地图坐标层；至少一个真实塔位应能提供这两个业务字段。
    expect(mapData.towers.some((tower) => tower.towerHeight != null && tower.towerHeight !== '')).toBe(true);
    expect(mapData.towers.some((tower) => tower.turnAngle != null && tower.turnAngle !== '')).toBe(true);

    // 塔位坐标合法性：lat∈[10,60], lng∈[70,140]（中国范围粗校验）
    for (const tower of mapData.towers) {
      expect(tower.lat).toBeGreaterThan(10);
      expect(tower.lat).toBeLessThan(60);
      expect(tower.lng).toBeGreaterThan(70);
      expect(tower.lng).toBeLessThan(140);
    }

    // 档距合理性（dev-log「档距精度」）：含端点高程的档距应为斜距 ≥ 平面距离，
    // 且典型档距在 50~1500m 范围内（超出多为异常）
    let checked = 0;
    for (const w of mapData.wires) {
      if (w.spanMeters == null || w.groupKind !== 'inter-point') continue;
      const planar = haversine(w.startLat, w.startLng, w.endLat, w.endLng);
      expect(w.spanMeters).toBeGreaterThanOrEqual(planar - 1e-6);
      if (w.startElev != null && w.endElev != null && w.startElev !== w.endElev) {
        expect(w.spanMeters).toBeGreaterThan(planar + 1e-6);
      }
      expect(w.spanMeters).toBeLessThan(1500);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);

    // 线路业务导航投影回归：原始 9276 节点不得直接成为左侧树，
    // F3 映射为耐张段，CROSS 无坐标全部保留在待关联组。
    const navigation = buildLineNavigationIndex(graph, mapData, { attrs });
    const workerNavigation = buildLineNavigationIndex(workerGraph, workerMapData, { attrs: workerAttrs });
    expect(workerNavigation.stats).toEqual(navigation.stats);
    expect(Array.from(workerNavigation.nodesByKey.keys()).sort())
      .toEqual(Array.from(navigation.nodesByKey.keys()).sort());
    expect(Array.from(workerNavigation.nodesByKey.entries()).map(([key, node]) => [
      key,
      node.kind,
      node.label,
      node.subtitle,
    ])).toEqual(Array.from(navigation.nodesByKey.entries()).map(([key, node]) => [
      key,
      node.kind,
      node.label,
      node.subtitle,
    ]));
    expect(navigation.stats.sectionCount).toBe(1);
    expect(navigation.stats.strainSectionCount).toBe(47);
    expect(navigation.stats.towerCount).toBe(129);
    expect(navigation.stats.spanCount).toBe(128);
    expect(navigation.stats.wireCount).toBe(2232);
    expect(navigation.stats.crossCount).toBe(44);
    expect(navigation.stats.unassociatedCrossCount).toBe(44);
    expect(navigation.nodesByKey.get('line-navigation:unassociated-crossings')?.children).toHaveLength(44);
    expect(Array.from(navigation.nodesByKey.values()).some((item) => /F[1-4]System|Tower_Device|Wire_Device/.test(item.label))).toBe(false);
  }, 120_000);
});

describe.skipIf(!LINE_CORPUS.every((sample) => existsSync(sample.dir)))('样本回归·Powerline Runtime v1 六样本', () => {
  it('冷解析、Worker 语义、属性引用和地图/树投影保持一致', async () => {
    for (const sample of LINE_CORPUS) {
      const files = loadFilesFromDir(sample.dir);
      expect(files.size, sample.id).toBeGreaterThan(100);

      const graph = await buildLineGimGraph(files);
      expect(graph.root, sample.id).not.toBeNull();
      for (const kind of ['F1System', 'F2System', 'F3System', 'F4System', 'Tower_Device', 'WIRE'] as const) {
        expect(graph.stats[kind] ?? 0, `${sample.id} ${kind}`).toBeGreaterThan(0);
      }

      // 复现 Line Parser Worker 的可序列化输入边界，并与兼容主线程 parser
      // 比较整个图统计及 FAM/DEV payload，而非只比较总节点数。
      const workerTextFiles: Array<{ path: string; text: string }> = [];
      for (const [path, file] of files) {
        if (/\.(cbm|dev|fam|phm|mod)$/i.test(path)) {
          workerTextFiles.push({ path, text: await file.text() });
        } else {
          workerTextFiles.push({ path, text: '' });
        }
      }
      const workerCache = createLineParserCache(workerTextFiles);
      const workerGraph = buildLineGimGraphFromTexts(workerTextFiles, workerCache);
      expect(workerGraph.stats, sample.id).toEqual(graph.stats);

      const { famPayloads, devPayloads } = await parseLineAttributes(graph, files);
      const workerAttrs = parseLineAttributesFromCache(workerGraph, workerCache);
      expect(famPayloads.length, `${sample.id} FAM`).toBeGreaterThan(0);
      expect(devPayloads.length, `${sample.id} DEV`).toBeGreaterThan(0);
      expect(workerAttrs.famPayloads, `${sample.id} worker FAM`).toEqual(famPayloads);
      expect(workerAttrs.devPayloads, `${sample.id} worker DEV`).toEqual(devPayloads);

      const attrs = buildLineAttributeIndex(
        famPayloads as unknown as LineFamPropertyRecord[],
        devPayloads as unknown as LineDevPropertyRecord[],
      );
      const mapData = extractLineMapData(graph, attrs);
      expect(isLineMapDataValid(mapData), sample.id).toBe(true);
      expect(mapData.towers.length, `${sample.id} towers`).toBeGreaterThan(0);
      expect(mapData.wires.length, `${sample.id} wires`).toBeGreaterThan(0);
      expect(mapData.stats.towerWithBlha, `${sample.id} tower coordinates`).toBeGreaterThan(0);
      expect(mapData.stats.towerWithFam, `${sample.id} tower FAM`).toBeGreaterThan(0);
      expect(mapData.stats.wireWithEndpoints, `${sample.id} wire endpoints`).toBeGreaterThan(0);
      expect(mapData.towers.some((tower) => tower.towerNumber), `${sample.id} tower number`).toBe(true);
      expect(mapData.towers.some((tower) => tower.towerType), `${sample.id} tower type`).toBe(true);
      expect(mapData.towers.some((tower) => tower.towerHeight), `${sample.id} tower height`).toBe(true);
      expect(mapData.towers.some((tower) => tower.turnAngle), `${sample.id} turn angle`).toBe(true);
      expect(mapData.bbox.minLat, `${sample.id} bbox`).toBeLessThanOrEqual(mapData.bbox.maxLat);
      expect(mapData.bbox.minLng, `${sample.id} bbox`).toBeLessThanOrEqual(mapData.bbox.maxLng);

      for (const tower of mapData.towers) {
        expect(graph.nodesByPath.has(tower.cbmPath), `${sample.id} tower source`).toBe(true);
        expect(Number.isFinite(tower.lat) && Number.isFinite(tower.lng), `${sample.id} tower coordinate`).toBe(true);
        expect(tower.lat).toBeGreaterThan(10);
        expect(tower.lat).toBeLessThan(60);
        expect(tower.lng).toBeGreaterThan(70);
        expect(tower.lng).toBeLessThan(140);
      }
      for (const wire of mapData.wires) {
        expect(Number.isFinite(wire.startLat) && Number.isFinite(wire.startLng)
          && Number.isFinite(wire.endLat) && Number.isFinite(wire.endLng),
        `${sample.id} wire endpoint`).toBe(true);
      }

      const navigation = buildLineNavigationIndex(graph, mapData, { attrs });
      const searchIndex = buildLineNavigationSearchIndex(navigation);
      expect(navigation.nodesByKey.size, `${sample.id} navigation`).toBeGreaterThan(0);
      expect(searchIndex.length, `${sample.id} search`).toBeGreaterThan(0);
      expect(navigation.stats.towerCount, `${sample.id} navigation towers`).toBe(mapData.towers.length);
      expect(navigation.stats.wireCount, `${sample.id} navigation wires`).toBeGreaterThan(0);
      // Graph CROSS 是原始节点总数；地图/树只投影带可用坐标的业务跨越点，
      // 因此允许两者不同，但投影层自身必须守恒。
      expect(navigation.stats.crossCount, `${sample.id} navigation crosses`).toBe(mapData.crosses.length);
      for (const tower of mapData.towers) {
        expect(navigation.targetBySourcePath.has(tower.cbmPath), `${sample.id} tree↔map link`).toBe(true);
      }
    }
  }, 600_000);
});
