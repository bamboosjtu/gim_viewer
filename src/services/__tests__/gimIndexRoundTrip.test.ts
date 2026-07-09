import { describe, it, expect } from 'vitest';
import { buildGimIndexPayload } from '../gimIndexPersistenceService.js';
import { restoreGimIndexToState } from '../gimIndexRestoreService.js';
import { AppState } from '../../app/state.js';
import type {
  GimIndexPayload,
  GimIndexResult,
  GimEntryRecord,
  CbmNodeRecord,
  IfcModelRecord,
  FileDevEntryRecord,
  FamPropertyRecord,
  DevPropertyRecord,
} from '../../desktop/database.js';
import type { CbmNode, FileDevEntry, IfcEntry } from '../../gim/types.js';

// ===== 工具：构造最小化 CbmNode =====

function makeNode(opts: Partial<CbmNode> & Pick<CbmNode, 'path' | 'name'>): CbmNode {
  return {
    entityName: '',
    children: [],
    famPath: '',
    devPath: '',
    ifcFile: '',
    ifcGuid: '',
    classifyName: '',
    transformMatrix: '',
    systemNames: [],
    devSymbolName: '',
    devType: '',
    devExpanded: false,
    ...opts,
  };
}

function makeFile(content: string, name: string): File {
  return new File([content], name, { type: 'text/plain' });
}

// ===== 模拟 DB 往返：payload → record =====
//
// 真实流程：buildGimIndexPayload → saveGimIndex(invoke) → SQLite → getGimIndex(invoke) → GimIndexResult
// DB 层为每行附加 id / project_id / created_at_ms 元数据。测试中以固定值填充这些字段，
// 仅验证 payload 业务字段经过往返后被 restoreGimIndexToState 正确还原到 AppState。

function payloadToResult(payload: GimIndexPayload, projectId: number): GimIndexResult {
  const now = Date.now();
  let autoId = 1;
  const nextId = () => autoId++;

  const entries: GimEntryRecord[] = payload.entries.map((e) => ({
    id: nextId(),
    project_id: projectId,
    entry_path: e.entry_path,
    file_name: e.file_name,
    entry_type: e.entry_type,
    file_size: e.file_size,
    local_cache_path: e.local_cache_path ?? null,
    created_at_ms: now,
  }));

  const cbm_nodes: CbmNodeRecord[] = payload.cbm_nodes.map((n) => ({
    id: nextId(),
    project_id: projectId,
    node_key: n.node_key,
    parent_key: n.parent_key,
    path: n.path,
    name: n.name,
    entity_name: n.entity_name,
    classify_name: n.classify_name,
    fam_path: n.fam_path,
    dev_path: n.dev_path,
    ifc_file: n.ifc_file,
    ifc_guid: n.ifc_guid,
    transform_matrix: n.transform_matrix,
    sort_order: n.sort_order,
    created_at_ms: now,
  }));

  const ifc_models: IfcModelRecord[] = payload.ifc_models.map((m) => ({
    id: nextId(),
    project_id: projectId,
    model_id: m.model_id,
    name: m.name,
    entry_path: m.entry_path,
    created_at_ms: now,
  }));

  const file_dev_entries: FileDevEntryRecord[] = payload.file_dev_entries.map((f) => ({
    id: nextId(),
    project_id: projectId,
    model_id: f.model_id,
    ifc_name: f.ifc_name,
    ifc_file: f.ifc_file,
    device_count: f.device_count,
    device_cbm: f.device_cbm,
    sort_order: f.sort_order,
    created_at_ms: now,
  }));

  const fam_properties: FamPropertyRecord[] = payload.fam_properties.map((p) => ({
    id: nextId(),
    project_id: projectId,
    source_path: p.source_path,
    section_name: p.section_name,
    prop_key: p.prop_key,
    prop_value: p.prop_value,
    sort_order: p.sort_order,
    created_at_ms: now,
  }));

  const dev_properties: DevPropertyRecord[] = payload.dev_properties.map((p) => ({
    id: nextId(),
    project_id: projectId,
    dev_path: p.dev_path,
    prop_key: p.prop_key,
    prop_value: p.prop_value,
    created_at_ms: now,
  }));

  return { entries, cbm_nodes, ifc_models, file_dev_entries, fam_properties, dev_properties };
}

// ===== 测试用例 =====

describe('GIM 索引缓存往返：buildGimIndexPayload → restoreGimIndexToState', () => {
  const PROJECT_ID = 42;

  it('CBM 树结构、IFC 索引、FileDev 关系、FAM/DEV 属性完整往返', async () => {
    // --- 构造最小化 GIM 解压后文件集合 ---
    const files = new Map<string, File>([
      // CBM 层级
      ['CBM/project.cbm', makeFile(
        `ENTITYNAME=F1System
SUBSYSTEM=area.cbm`, 'project.cbm')],
      ['CBM/area.cbm', makeFile(
        `ENTITYNAME=F4System
OBJECTMODELPOINTER=device.dev
IFC.NUM=1
IFC0=device.ifc`, 'area.cbm')],
      // DEV 文件（含 BASEFAMILY 指向 FAM）
      ['DEV/device.dev', makeFile(
        `SYMBOLNAME=断路器
TYPE=OTHERS
BASEFAMILY=fam001.fam
SOLIDMODELS.NUM=0`, 'device.dev')],
      // FAM 文件（含分节属性）
      ['DEV/fam001.fam', makeFile(
        `[设计参数]
RATED_VOLTAGE=110kV
RATED_CURRENT=2000A
[制造信息]
MANUFACTURER=某厂`, 'fam001.fam')],
      // IFC 文件（占位，仅用于 entry 清单）
      ['DEV/device.ifc', makeFile('ISO-10303-21 placeholder', 'device.ifc')],
    ]);

    // --- 构造 CBM 树（模拟 buildCbmTree 的输出） ---
    const cbmTree: CbmNode = makeNode({
      path: 'CBM/project.cbm',
      name: '测试工程',
      entityName: 'F1System',
      children: [
        makeNode({
          path: 'CBM/area.cbm',
          name: '区域A',
          entityName: 'F4System',
          devPath: 'device.dev',
          ifcFile: 'device.ifc',
          ifcGuid: 'guid-001',
          famPath: 'fam001.fam',
          transformMatrix: '1,0,0,0,0,1,0,0,0,0,1,0,100,200,300,1',
        }),
      ],
    });

    // --- 构造 IFC 条目 + FileDev 关系 ---
    const ifcEntries: IfcEntry[] = [
      { name: 'device.ifc', path: 'DEV/device.ifc', modelId: 'device' },
    ];
    const fileDevRelations: FileDevEntry[] = [
      {
        ifcName: 'device.ifc',
        ifcFile: 'device.ifc',
        modelId: 'device',
        deviceCount: 1,
        deviceCbms: ['CBM/area.cbm'],
      },
    ];

    // --- 执行 payload 构建 → 模拟 DB 往返 → 恢复到 AppState ---
    const payload = await buildGimIndexPayload(
      PROJECT_ID,
      files,
      ifcEntries,
      cbmTree,
      fileDevRelations,
    );
    const result = payloadToResult(payload, PROJECT_ID);

    const state = new AppState();
    restoreGimIndexToState(state, result);

    // --- 验证 1: currentFiles = null（缓存命中语义） ---
    expect(state.currentFiles).toBeNull();

    // --- 验证 2: IFC 条目还原 ---
    expect(state.currentIfcEntries).toHaveLength(1);
    expect(state.currentIfcEntries[0]).toEqual({
      name: 'device.ifc',
      path: 'DEV/device.ifc',
      modelId: 'device',
    });

    // --- 验证 3: CBM 树结构还原 ---
    expect(state.currentCbmTree).not.toBeNull();
    expect(state.currentCbmTree!.path).toBe('CBM/project.cbm');
    expect(state.currentCbmTree!.name).toBe('测试工程');
    expect(state.currentCbmTree!.children).toHaveLength(1);
    const child = state.currentCbmTree!.children[0];
    expect(child.path).toBe('CBM/area.cbm');
    expect(child.name).toBe('区域A');
    expect(child.devPath).toBe('device.dev');
    expect(child.ifcFile).toBe('device.ifc');
    expect(child.ifcGuid).toBe('guid-001');
    expect(child.famPath).toBe('fam001.fam');
    expect(child.transformMatrix).toBe('1,0,0,0,0,1,0,0,0,0,1,0,100,200,300,1');

    // --- 验证 4: ifcGuidIndex 还原 ---
    expect(state.ifcGuidIndex.size).toBe(1);
    expect(state.ifcGuidIndex.has('device.ifc:guid-001')).toBe(true);

    // --- 验证 5: cbmNodeIndex 还原 ---
    expect(state.cbmNodeIndex.size).toBeGreaterThan(0);
    expect(state.cbmNodeIndex.has('area.cbm')).toBe(true);

    // --- 验证 6: fileDevRelations 还原 ---
    expect(state.fileDevRelations).toHaveLength(1);
    expect(state.fileDevRelations[0].modelId).toBe('device');
    expect(state.fileDevRelations[0].deviceCbms).toEqual(['CBM/area.cbm']);

    // --- 验证 7: deviceToIfcFile 反向索引 ---
    expect(state.deviceToIfcFile.get('CBM/area.cbm')).toBe('device');

    // --- 验证 8: cachedFamProperties 还原（分节） ---
    const famProps = state.cachedFamProperties.get('DEV/fam001.fam');
    expect(famProps).toBeDefined();
    const designSec = famProps!.get('设计参数');
    expect(designSec).toBeDefined();
    expect(designSec!.get('RATED_VOLTAGE')).toBe('110kV');
    expect(designSec!.get('RATED_CURRENT')).toBe('2000A');
    const mfgSec = famProps!.get('制造信息');
    expect(mfgSec!.get('MANUFACTURER')).toBe('某厂');

    // --- 验证 9: cachedDevProperties 还原 ---
    const devProps = state.cachedDevProperties.get('DEV/device.dev');
    expect(devProps).toBeDefined();
    expect(devProps!.SYMBOLNAME).toBe('断路器');
    expect(devProps!.TYPE).toBe('OTHERS');
    expect(devProps!.BASEFAMILY).toBe('fam001.fam');
  });

  it('空 CBM 树 + 空文件集合的边界场景', async () => {
    const files = new Map<string, File>();
    const payload = await buildGimIndexPayload(PROJECT_ID, files, [], null, []);
    const result = payloadToResult(payload, PROJECT_ID);

    const state = new AppState();
    restoreGimIndexToState(state, result);

    expect(state.currentFiles).toBeNull();
    expect(state.currentIfcEntries).toEqual([]);
    expect(state.currentCbmTree).toBeNull();
    expect(state.ifcGuidIndex.size).toBe(0);
    expect(state.cbmNodeIndex.size).toBe(0);
    expect(state.fileDevRelations).toEqual([]);
    expect(state.cachedFamProperties.size).toBe(0);
    expect(state.cachedDevProperties.size).toBe(0);
  });

  it('同级 children 按 sort_order 排序后还原', async () => {
    // 故意以逆序构造 children，验证 restore 后按 sort_order 重建顺序
    const cbmTree: CbmNode = makeNode({
      path: 'CBM/project.cbm',
      name: 'root',
      entityName: 'F1System',
      children: [
        makeNode({ path: 'CBM/c3.cbm', name: '第三' }),
        makeNode({ path: 'CBM/c1.cbm', name: '第一' }),
        makeNode({ path: 'CBM/c2.cbm', name: '第二' }),
      ],
    });

    const files = new Map<string, File>([
      ['CBM/project.cbm', makeFile('ENTITYNAME=F1System', 'project.cbm')],
    ]);

    const payload = await buildGimIndexPayload(PROJECT_ID, files, [], cbmTree, []);
    const result = payloadToResult(payload, PROJECT_ID);
    const state = new AppState();
    restoreGimIndexToState(state, result);

    const children = state.currentCbmTree!.children;
    expect(children.map((c) => c.name)).toEqual(['第三', '第一', '第二']);
    // flattenCbmTree 使用 children 数组下标作为 sort_order，restore 时按 sort_order 排序
    // 因此顺序与原始 children 数组顺序一致
  });

  it('local_cache_path 正确还原到 cachedIfcPaths', async () => {
    const files = new Map<string, File>([
      ['DEV/a.ifc', makeFile('ISO', 'a.ifc')],
      ['DEV/b.ifc', makeFile('ISO', 'b.ifc')],
    ]);
    const localCachePathMap = new Map<string, string>([
      ['DEV/a.ifc', '/cache/DEV/a.ifc'],
      // b.ifc 无缓存
    ]);
    const ifcEntries: IfcEntry[] = [
      { name: 'a.ifc', path: 'DEV/a.ifc', modelId: 'a' },
      { name: 'b.ifc', path: 'DEV/b.ifc', modelId: 'b' },
    ];

    const payload = await buildGimIndexPayload(
      PROJECT_ID,
      files,
      ifcEntries,
      null,
      [],
      localCachePathMap,
    );
    const result = payloadToResult(payload, PROJECT_ID);
    const state = new AppState();
    restoreGimIndexToState(state, result);

    expect(state.cachedIfcPaths.size).toBe(1);
    expect(state.cachedIfcPaths.get('DEV/a.ifc')).toBe('/cache/DEV/a.ifc');
    expect(state.cachedIfcPaths.has('DEV/b.ifc')).toBe(false);
  });
});
