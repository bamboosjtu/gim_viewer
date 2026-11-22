import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../../../../app/state.js';
import { buildLineGimGraphFromTexts } from '../../../../gim/lineCbmParserCore.js';
import { createLineParserCache, parseLineAttributesFromCache } from '@gim/powerline-core/lineAttrParserCore.js';
import { buildLineGraphPayload } from '../../../../services/lineGraphPersistenceService.js';
import { buildLineGraphFromCache } from '../../../../services/lineGraphRestoreService.js';
import { buildLineAttributeIndex, restoreLineAttributesToState } from '../../../../services/lineAttrRestoreService.js';
import { extractLineMapData } from '../../../../gim/lineMapData.js';
import { buildLineNavigationIndex } from '../../presentation/lineNavigationProjection.js';
import { renderLineSourceRefs } from '../../../../services/lineInspectorProjection.js';
import { buildLineSemanticWarmFiles, commitLineParserResult } from '../lineSourceState.js';
import { parseLineInWorker } from '../lineParserWorkerClient.js';
import type { LineParserWorkerFile } from '../lineParserWorker.js';
import type { LineParserWorkerResult } from '../lineParserWorkerClient.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function newScope(id: number, sha: string) { const app = new AppState(); return app.sessionScope(app.activateProject(id, sha)); }

function textFile(path: string, text: string): LineParserWorkerFile {
  return { path, bytes: new TextEncoder().encode(text).buffer };
}

/** 小型但覆盖 F1→F4→塔、FAM、DEV、WIRE、CROSS 的线路样本。 */
function coldFiles(): LineParserWorkerFile[] {
  return [
    textFile('Cbm/project.cbm', 'SUBSYSTEM=F1.cbm\n'),
    textFile('CBM/F1.cbm', 'ENTITYNAME=F1System\nSECTIONS.NUM=1\nSECTION0=F2.cbm\n'),
    textFile('cbm/F2.cbm', 'ENTITYNAME=F2System\nSTRAINSECTIONS.NUM=1\nSTRAINSECTION0=F3.cbm\n'),
    textFile('CBM/F3.cbm', 'ENTITYNAME=F3System\nGROUPS.NUM=1\nGROUP0=F4.cbm\n'),
    textFile('Cbm/F4.cbm', 'ENTITYNAME=F4System\nTOWERS.NUM=1\nTOWER0=Tower01.cbm\n'),
    textFile('CBM/Tower01.cbm', 'ENTITYNAME=Tower_Device\nBASEFAMILY=Tower.fam\nOBJECTMODELPOINTER=Tower.dev\n'),
    textFile('FAM/Tower.fam', '塔型=TYPE=耐张塔\n呼高=HEIGHT=30\n转角=ANGLE=12.5\n'),
    textFile('DEV/Tower.dev', 'SYMBOLNAME=Tower\n'),
    textFile('CBM/Wire.cbm', 'ENTITYNAME=WIRE\n'),
    textFile('MOD/cross.mod', 'CODE=CROSS-1\n'),
    textFile('MOD/large.mod', ''),
    textFile('MOD/fittings.stl', ''),
    textFile('README.txt', 'ignored\n'),
  ];
}

function textMap(files: LineParserWorkerFile[]): Array<{ path: string; text: string }> {
  return files.map((file) => ({ path: file.path, text: new TextDecoder().decode(file.bytes) }));
}

function graphShape(graph: ReturnType<typeof buildLineGimGraphFromTexts>) {
  return {
    stats: graph.stats,
    filesByType: graph.filesByType,
    paths: Array.from(graph.nodesByPath.keys()).sort(),
    nodes: Array.from(graph.nodesByPath.values()).map((node) => ({
      path: node.path,
      name: node.name,
      entityName: node.entityName,
      classifyName: node.classifyName,
      rawProps: node.rawProps,
      children: node.children.map((child) => child.path),
      refs: node.refs,
    })).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function attributeShape(result: ReturnType<typeof parseLineAttributesFromCache>) {
  return {
    famPayloads: result.famPayloads,
    devPayloads: result.devPayloads,
    unmatchedRefs: result.unmatchedRefs,
  };
}

describe('Line Warm Fast Path v1', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('semantic warm Worker 与 cold Worker 的图、导航输入、塔位/导线/跨越物属性一致', async () => {
    // 强制走与生产环境相同的同步 fallback，比较的是两条输入准备路径，
    // 不把测试环境是否实现 Worker 当作业务结果的一部分。
    vi.stubGlobal('Worker', undefined);
    const cold = coldFiles();
    const coldResult = await parseLineInWorker(cold, newScope(11, 'cold-sha'));

    const packedItems = cold.map((file) => ({
      entry_path: file.path,
      packed: /\.(cbm|dev|fam|phm|mod)$/i.test(file.path) && file.path !== 'MOD/large.mod',
      size: file.bytes.byteLength,
      bytes: file.bytes.byteLength > 0 ? new Uint8Array(file.bytes) : null,
    }));
    const prepared = buildLineSemanticWarmFiles(11, packedItems, (projectId, path, size, semantic) =>
      Object.assign(new File([new Uint8Array(size)], path.split('/').pop() || path), {
        __projectId: projectId,
        __semantic: semantic,
      }) as unknown as File,
    );
    const warmResult = await parseLineInWorker(prepared.workerFiles, newScope(11, 'warm-sha'));

    expect(warmResult.timings.worker).toBe(false);
    expect(graphShape(warmResult.graph)).toEqual(graphShape(coldResult.graph));
    expect(attributeShape(warmResult.attributes)).toEqual(attributeShape(coldResult.attributes));

    // metadata-only MOD/STL 仍进入 filesByType/currentFiles，但不会把大几何
    // 字节复制到 Worker；这是 warm 与 cold 在用户可见文件统计上的一致性边界。
    expect(prepared.workerFiles.find((file) => file.path === 'MOD/large.mod')?.bytes.byteLength).toBe(0);
    expect(prepared.workerFiles.find((file) => file.path === 'MOD/fittings.stl')?.bytes.byteLength).toBe(0);
    expect(prepared.files.size).toBe(cold.length);
  });

  it('semantic warm 结果与原 SQLite graph/attribute restore 的业务形状一致', async () => {
    vi.stubGlobal('Worker', undefined);
    const cold = coldFiles();
    const textFiles = textMap(cold);
    const cache = createLineParserCache(textFiles);
    const graph = buildLineGimGraphFromTexts(textFiles, cache);
    const attributes = parseLineAttributesFromCache(graph, cache);
    const payload = buildLineGraphPayload(7, graph, 'fixture-sha');

    const state = new AppState();
    const restored = buildLineGraphFromCache({
      project_type: payload.project_type,
      nodes: payload.nodes,
      children: payload.children,
      refs: payload.refs,
      file_stats: payload.file_stats,
    });
    restoreLineAttributesToState({
      fam_properties: attributes.famPayloads,
      dev_properties: attributes.devPayloads,
    }, state);

    expect(graphShape(restored)).toMatchObject({
      stats: graph.stats,
      paths: Array.from(graph.nodesByPath.keys()).sort(),
    });
    // SQLite restore 的 filesByType 是 lazy 空数组，但统计计数仍应完整。
    expect(restored.stats.CBM).toBe(graph.stats.CBM);
    expect(restored.stats.MOD).toBe(graph.stats.MOD);
    expect(restored.stats.STL).toBe(graph.stats.STL);
    expect(state.properties.cachedLineFamProperties.size).toBeGreaterThan(0);
    expect(state.properties.cachedLineDevProperties.size).toBeGreaterThan(0);
    expect(Array.from(state.properties.cachedLineFamProperties.values()).flatMap((byProp) => Array.from(byProp.values()).flat()).length)
      .toBe(attributes.famPayloads.length);
    expect(Array.from(state.properties.cachedLineDevProperties.values()).flatMap((byProp) => Array.from(byProp.values()).flat()).length)
      .toBe(attributes.devPayloads.length);
  });

  it('preserves one boundary tower and both strain edges through SQLite graph restore', () => {
    const files = textMap([
      textFile('CBM/project.cbm', 'ENTITYNAME=F1System\nSECTIONS.NUM=1\nSECTION0=line.cbm'),
      textFile('CBM/line.cbm', 'ENTITYNAME=F2System\nSTRAINSECTIONS.NUM=2\nSTRAINSECTION0=s1.cbm\nSTRAINSECTION1=s2.cbm'),
      textFile('CBM/s1.cbm', 'ENTITYNAME=F3System\nGROUPS.NUM=2\nGROUP0=tower.cbm\nGROUP1=tower.cbm'),
      textFile('CBM/s2.cbm', 'ENTITYNAME=F3System\nGROUPS.NUM=1\nGROUP0=tower.cbm'),
      textFile('CBM/tower.cbm', 'ENTITYNAME=F4System\nGROUPTYPE=TOWER\nBLHA=30,110,0\nSUBDEVICE0=s1.cbm\nSUBDEVICES.NUM=1'),
    ]);
    const cold = buildLineGimGraphFromTexts(files);
    const state = new AppState();
    const payload = buildLineGraphPayload(7, cold, 'fixture');
    expect(payload.nodes.filter(node => node.path === 'CBM/tower.cbm')).toHaveLength(1);
    expect(payload.children.filter(edge => edge.child_path === 'CBM/tower.cbm').map(edge => edge.parent_path))
      .toEqual(['CBM/s1.cbm', 'CBM/s2.cbm']);
    expect(payload.children.some(edge => edge.parent_path === 'CBM/tower.cbm')).toBe(false);

    for (const graph of [cold, buildLineGraphFromCache(payload)]) {
      const tower = graph.nodesByPath.get('CBM/tower.cbm');
      expect(graph.nodesByPath.get('CBM/s1.cbm')?.children[0]).toBe(tower);
      expect(graph.nodesByPath.get('CBM/s2.cbm')?.children[0]).toBe(tower);
      const map = extractLineMapData(graph, buildLineAttributeIndex(state));
      expect(map.towers).toHaveLength(1);
      const navigation = buildLineNavigationIndex(graph, map);
      const strains = [...navigation.nodesByKey.values()].filter(node => node.kind === 'strain-section');
      expect(strains.map(strain => strain.children.map(child => child.tower?.cbmPath)))
        .toEqual([['CBM/tower.cbm'], ['CBM/tower.cbm']]);
    }
  });

  it('keeps exact wire endpoints and unresolved FAM references through desktop projections and restore', () => {
    const files = textMap([
      textFile('CBM/project.cbm', 'GROUPS.NUM=5\nGROUP0=A/tower.cbm\nGROUP1=B/tower.cbm\nGROUP2=C/tower.cbm\nGROUP3=wire.cbm\nGROUP4=ambiguous-wire.cbm'),
      textFile('A/tower.cbm', 'ENTITYNAME=F4System\nGROUPTYPE=TOWER\nBLHA=30,110,0\nSTRINGS.NUM=1\nSTRING0.STRING=hang.cbm\nBASEFAMILY=B/type.fam'),
      textFile('B/tower.cbm', 'ENTITYNAME=F4System\nGROUPTYPE=TOWER\nBLHA=32,112,0\nSTRINGS.NUM=1\nSTRING0.STRING=hang.cbm'),
      textFile('C/tower.cbm', 'ENTITYNAME=F4System\nGROUPTYPE=TOWER\nBLHA=31,111,0\nSTRINGS.NUM=1\nSTRING0.STRING=end.cbm\nBASEFAMILY=type.fam'),
      textFile('A/hang.cbm', 'ENTITYNAME=STRING'),
      textFile('B/hang.cbm', 'ENTITYNAME=STRING'),
      textFile('C/end.cbm', 'ENTITYNAME=STRING'),
      textFile('CBM/wire.cbm', 'ENTITYNAME=WIRE\nBACKSTRING=a\\HANG.cbm\nFRONTSTRING=C/end.cbm'),
      textFile('CBM/ambiguous-wire.cbm', 'ENTITYNAME=WIRE\nBACKSTRING=hang.cbm\nFRONTSTRING=C/end.cbm'),
      textFile('A/type.fam', 'TYPE=A-model'),
      textFile('B/type.fam', 'TYPE=B-model'),
    ]);
    const cache = createLineParserCache(files);
    const cold = buildLineGimGraphFromTexts(files, cache);
    const attrs = parseLineAttributesFromCache(cold, cache);
    expect(attrs.unmatchedRefs).toContain('FAM: type.fam');
    expect(attrs.famPayloads.map(row => row.source_path)).toEqual(['B/type.fam']);
    const state = new AppState();
    const warm = buildLineGraphFromCache(buildLineGraphPayload(7, cold, 'fixture'));
    restoreLineAttributesToState({ fam_properties: attrs.famPayloads, dev_properties: attrs.devPayloads }, state);
    const attrIndex = buildLineAttributeIndex(state);
    for (const graph of [cold, warm]) {
      const map = extractLineMapData(graph, attrIndex);
      expect(map.wires).toHaveLength(1);
      expect(map.wires[0]).toMatchObject({ startLat: 30, startLng: 110, endLat: 31, endLng: 111 });
      expect(map.unresolved.wires).toEqual(['CBM/ambiguous-wire.cbm']);
      expect(map.towers.find(tower => tower.cbmPath === 'A/tower.cbm')?.towerType).toBe('B-model');
      expect(map.towers.find(tower => tower.cbmPath === 'C/tower.cbm')?.towerType).toBeUndefined();
      expect(map.unresolved.famSources).toEqual(['type.fam']);
      expect(renderLineSourceRefs(graph.nodesByPath.get('C/tower.cbm')!)).toContain('未解析引用');
    }
  });

  it('A→B 工程切换后迟到的 semantic Worker/pack 结果不能提交或清空 B', async () => {
    vi.stubGlobal('Worker', undefined);
    const cold = coldFiles();
    const parsedA = await parseLineInWorker(cold, newScope(1, 'sha-a'));
    const parsedB = await parseLineInWorker(cold, newScope(2, 'sha-b'));
    const state = new AppState();
    const sessionA = state.activateProject(1, 'sha-a');
    // 让 A 任务在真实的 pack/Worker await 期间失效，再激活并提交 B。
    state.invalidatePendingLoads();
    state.resetGimState();
    const sessionB = state.activateProject(2, 'sha-b');
    expect(await commitLineParserResult(state, parsedB, new Map([['B', new File(['B'], 'B')]]), state.sessionScope(sessionB))).toBe(true);
    const graphB = state.currentGimGraph;
    const famB = new Map(state.properties.cachedLineFamProperties);

    expect(await commitLineParserResult(state, parsedA, new Map([['A', new File(['A'], 'A')]]), state.sessionScope(sessionA))).toBe(false);
    expect(state.currentGimGraph).toBe(graphB);
    expect(state.currentFiles?.has('B')).toBe(true);
    expect(state.currentFiles?.has('A')).toBe(false);
    expect(state.properties.cachedLineFamProperties).toEqual(famB);
  });

  it('A 的 full-read 已返回但 Worker 迟到时，B 提交后 A 成功结果不能覆盖 B', async () => {
    vi.stubGlobal('Worker', undefined);
    const fullReady = deferred<LineParserWorkerFile[]>();
    const workerReady = deferred<LineParserWorkerResult>();
    const workerStarted = deferred<void>();
    const state = new AppState();
    const sessionA = state.activateProject(1, 'sha-a');
    const sessionBFiles = new Map([['B', new File(['B'], 'B')]]);
    const parsedA = await parseLineInWorker(coldFiles(), state.sessionScope(sessionA));

    // 与生产 warm fast path 相同的顺序：full-read → 准备 Worker 输入 →
    // Worker → 统一 commit。每个 await 后都检查 ProjectLoadSession。
    const loadA = (async () => {
      await fullReady.promise;
      if (!state.isCurrentSession(sessionA)) return false;
      workerStarted.resolve();
      const result = await workerReady.promise;
      if (!state.isCurrentSession(sessionA)) return false;
      return commitLineParserResult(
        state,
        result,
        new Map([['A', new File(['A'], 'A')]]),
        state.sessionScope(sessionA),
      );
    })();

    fullReady.resolve([{ path: 'Cbm/project.cbm', bytes: new TextEncoder().encode('A=B').buffer }]);
    await workerStarted.promise;

    // A 已完成 full-read，正停在 Worker await；此时切换并提交 B。
    state.invalidatePendingLoads();
    state.resetGimState();
    const activeB = state.activateProject(2, 'sha-b');
    const parsedB = await parseLineInWorker(coldFiles(), state.sessionScope(activeB));
    expect(await commitLineParserResult(state, parsedB, sessionBFiles, state.sessionScope(activeB))).toBe(true);
    const graphB = state.currentGimGraph;

    workerReady.resolve(parsedA);
    expect(await loadA).toBe(false);
    expect(state.currentGimGraph).toBe(graphB);
    expect(state.currentFiles).toBeInstanceOf(Map);
    expect(state.currentFiles?.has('B')).toBe(true);
    expect(state.currentFiles?.has('A')).toBe(false);
  });

  it('A 的 full-read 已返回但 Worker 迟到失败时，异常也不能清空 B', async () => {
    vi.stubGlobal('Worker', undefined);
    const fullReady = deferred<void>();
    const workerReady = deferred<never>();
    const workerStarted = deferred<void>();
    const state = new AppState();
    const sessionA = state.activateProject(1, 'sha-a');

    const loadA = (async () => {
      await fullReady.promise;
      if (!state.isCurrentSession(sessionA)) return false;
      workerStarted.resolve();
      try {
        await workerReady.promise;
        return false;
      } catch (error) {
        // 生产流程的 catch 只在当前会话清理状态；过期任务直接丢弃。
        if (!state.isCurrentSession(sessionA)) return false;
        throw error;
      }
    })();

    fullReady.resolve();
    await workerStarted.promise;
    state.invalidatePendingLoads();
    state.resetGimState();
    const activeB = state.activateProject(2, 'sha-b');
    const parsedB = await parseLineInWorker(coldFiles(), state.sessionScope(activeB));
    expect(await commitLineParserResult(state, parsedB, new Map([['B', new File(['B'], 'B')]]), state.sessionScope(activeB))).toBe(true);
    const graphB = state.currentGimGraph;

    workerReady.reject(new Error('A semantic Worker failed late'));
    expect(await loadA).toBe(false);
    expect(state.currentGimGraph).toBe(graphB);
    expect(state.currentFiles?.has('B')).toBe(true);
  });
});
