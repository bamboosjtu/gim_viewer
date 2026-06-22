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

import { buildCbmTree, collectIfcRefs, buildCbmNodeIndex } from '../cbmParser.js';
import { discoverIfcFromCBM } from '../gimIndexer.js';
import { parseFileDevRelation } from '../fileDevParser.js';
import { parseFamSections } from '../famParser.js';
import { buildLineGimGraph } from '../lineCbmParser.js';
import { buildSubstationSpatialIndexFromFiles } from '../ifcSpatialParser.js';
import {
  extractLineMapData,
  isLineMapDataValid,
} from '../lineMapData.js';
import { buildLineNavigationIndex } from '../../ui/lineNavigationTreeView.js';
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
const SUBSTATION_CORPUS = [
  { id: 'demo-substation', models: 12, contained: 3111, spatial: 4714, decomposition: 74, host: 1529 },
  { id: 'substation02', models: 17, contained: 51767, spatial: 62176, decomposition: 38, host: 10371 },
  { id: 'substation03', models: 8, contained: 9572, spatial: 9572, decomposition: 0, host: 0 },
  { id: 'substation04', models: 19, contained: 7182, spatial: 7720, decomposition: 44, host: 494 },
].map((item) => ({ ...item, dir: resolveDemoDir(item.id) }));

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
    expect(index.models.reduce((sum, model) => sum + model.objectsWithProperties, 0)).toBeGreaterThan(0);
    expect(index.models.reduce((sum, model) => sum + model.propertyValueCount, 0)).toBeGreaterThan(0);
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

    // FAM/DEV 属性解析
    const { famPayloads, devPayloads } = await parseLineAttributes(graph, files);
    expect(famPayloads.length).toBeGreaterThan(0);

    // 组装属性索引并提取地图数据
    const famBySourcePath = new Map<string, Map<string, LineFamPropertyRecord[]>>();
    for (const rec of famPayloads as unknown as LineFamPropertyRecord[]) {
      let byProp = famBySourcePath.get(rec.source_path);
      if (!byProp) { byProp = new Map(); famBySourcePath.set(rec.source_path, byProp); }
      const list = byProp.get(rec.prop_key) ?? [];
      list.push(rec);
      byProp.set(rec.prop_key, list);
    }
    const devBySourcePath = new Map<string, Map<string, LineDevPropertyRecord[]>>();
    for (const rec of devPayloads as unknown as LineDevPropertyRecord[]) {
      let byProp = devBySourcePath.get(rec.source_path);
      if (!byProp) { byProp = new Map(); devBySourcePath.set(rec.source_path, byProp); }
      const list = byProp.get(rec.prop_key) ?? [];
      list.push(rec);
      byProp.set(rec.prop_key, list);
    }
    // 按文件名小写补建索引（extractLineMapData 有 source_path 与 file_name_lower 双查找通道）
    const famByFn = new Map<string, Map<string, LineFamPropertyRecord[]>>();
    for (const rec of famPayloads as unknown as LineFamPropertyRecord[]) {
      let byProp = famByFn.get(rec.file_name_lower);
      if (!byProp) { byProp = new Map(); famByFn.set(rec.file_name_lower, byProp); }
      const list = byProp.get(rec.prop_key) ?? [];
      list.push(rec);
      byProp.set(rec.prop_key, list);
    }
    const devByFn = new Map<string, Map<string, LineDevPropertyRecord[]>>();
    for (const rec of devPayloads as unknown as LineDevPropertyRecord[]) {
      let byProp = devByFn.get(rec.file_name_lower);
      if (!byProp) { byProp = new Map(); devByFn.set(rec.file_name_lower, byProp); }
      const list = byProp.get(rec.prop_key) ?? [];
      list.push(rec);
      byProp.set(rec.prop_key, list);
    }

    const attrs: LineAttributeIndex = {
      famBySourcePath,
      famByFileNameLower: famByFn,
      devBySourcePath,
      devByFileNameLower: devByFn,
    };

    const mapData = extractLineMapData(graph, attrs);
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
