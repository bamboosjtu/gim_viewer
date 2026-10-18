import { describe, it, expect, vi } from 'vitest';
import {
  publishSubstationCore,
  publishSubstationRest,
  type CoreDependencies,
  type RestDependencies,
} from '../substationIndexPublication.js';
import { buildCbmTree } from '../../gim/cbmParser.js';
import { buildGimIndexPayload, buildGeometryRefsPayload } from '../gimIndexPersistenceService.js';
import { sqliteRoundTrip } from './sqliteHarness.js';
import type { GimIndexPayload, GeometryRefsPayload } from '@desktop/database.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function fixture() {
  const files = new Map(Object.entries({
    'CBM/project.cbm': 'ENTITYNAME=PROJECT\nSYSTEMNAME=fixture\nSUBSYSTEMS.NUM=1\nSUBSYSTEM0=root.cbm',
    'CBM/root.cbm': 'ENTITYNAME=F4System\nOBJECTMODELPOINTER=root.dev\nBASEFAMILY=props.fam',
    'CBM/props.fam': '[设计参数]\nkey=value\nkey=value\nkey=other',
    'DEV/root.dev': 'BASEFAMILYPOINTER=empty.fam\nSOLIDMODELS.NUM=1\nSOLIDMODEL0=root.phm',
    'DEV/empty.fam': '',
    'PHM/root.phm': 'SOLIDMODELS.NUM=0',
    'CBM/model.ifc': 'not-read-by-publication',
  }).map(([path, text]) => [path, new File([text], path)]));
  const tree = await buildCbmTree(files);
  return {
    projectId: 1,
    sourceSha256: 'fixture-sha',
    files,
    cachePaths: new Map([...files.keys()].map((p) => [p, `cache/${p}`])),
    tree,
    ifcs: [{ path: 'CBM/model.ifc', name: 'model', modelId: 'model' }],
    relations: [],
  };
}

function coreDeps() {
  return {
    isCurrent: () => true,
    saveIndex: vi.fn(async (_payload: GimIndexPayload) => {}),
    saveRefs: vi.fn(async (_payload: GeometryRefsPayload) => {}),
    validate: vi.fn(async () => ({ substation_semantic_cache_valid: true })),
    onPhase: vi.fn((_phase: string, _counts?: Record<string, number>) => {}),
  } as unknown as CoreDependencies & {
    saveIndex: ReturnType<typeof vi.fn>;
    saveRefs: ReturnType<typeof vi.fn>;
    validate: ReturnType<typeof vi.fn>;
    onPhase: ReturnType<typeof vi.fn>;
  };
}

function restDeps() {
  return {
    isCurrent: () => true,
    saveRest: vi.fn(async (_payload: unknown) => {}),
    onPhase: vi.fn((_phase: string, _counts?: Record<string, number>) => {}),
  } as unknown as RestDependencies & {
    saveRest: ReturnType<typeof vi.fn>;
    onPhase: ReturnType<typeof vi.fn>;
  };
}

describe('two-phase semantic publication', () => {
  it('core publishes entries/tree/IFC/relations without reading source bytes', async () => {
    const input = await fixture();
    const deps = coreDeps();
    const saved: GimIndexPayload[] = [];
    deps.saveIndex = vi.fn(async (payload: GimIndexPayload) => { saved.push(payload); });
    const ifc = input.files.get('CBM/model.ifc')!;
    const read = vi.spyOn(ifc, 'text');
    const bytes = vi.spyOn(ifc, 'arrayBuffer');

    expect(await publishSubstationCore(input, deps)).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(bytes).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(saved[0].entries).toHaveLength(input.files.size);
    expect(saved[0].cbm_nodes.length).toBeGreaterThan(0);
    expect(saved[0].fam_properties).toHaveLength(0);
    expect(saved[0].dev_properties).toHaveLength(0);
    expect(saved[0].capability_summary_json).toBeNull();
    expect(deps.saveRefs).toHaveBeenCalledOnce();
    const refs = deps.saveRefs.mock.calls[0][0] as GeometryRefsPayload;
    expect(refs.dev_solid_models).toHaveLength(0);
    expect(refs.phm_solid_models).toHaveLength(0);
    expect(deps.validate).toHaveBeenCalledOnce();
    expect(deps.onPhase.mock.calls.map((c) => c[0]))
      .toEqual(['saveIndexStart', 'saveIndexReady', 'coreValid']);
  });

  it('core requires completed semantic source writes', async () => {
    const input = await fixture();
    const deps = coreDeps();
    input.cachePaths.delete('DEV/empty.fam');
    await expect(publishSubstationCore(input, deps)).rejects.toThrow('源文件尚未完成缓存');
    expect(deps.saveIndex).not.toHaveBeenCalled();
    expect(deps.saveRefs).not.toHaveBeenCalled();
  });

  it('core cancellation after index save leaves the version uncommitted', async () => {
    const input = await fixture();
    const deps = coreDeps();
    let active = true;
    deps.isCurrent = () => active;
    deps.saveIndex = vi.fn(async () => { active = false; });
    expect(await publishSubstationCore(input, deps)).toBe(false);
    expect(deps.saveRefs).not.toHaveBeenCalled();
    expect(deps.validate).not.toHaveBeenCalled();
  });

  it('core never reports ready when post-publication validation fails', async () => {
    const input = await fixture();
    const deps = coreDeps();
    deps.validate.mockResolvedValue({ substation_semantic_cache_valid: false });
    await expect(publishSubstationCore(input, deps)).rejects.toThrow('有效性校验失败');
    expect(deps.onPhase.mock.calls.some((c) => c[0] === 'coreValid')).toBe(false);
  });

  it('rest publishes FAM/DEV properties, geometry refs and capability summary', async () => {
    const input = await fixture();
    const deps = restDeps();
    expect(await publishSubstationRest(input, deps)).toBe(true);
    const payload = deps.saveRest.mock.calls[0][0] as {
      fam_properties: unknown[]; dev_properties: unknown[];
      refs: GeometryRefsPayload; capability_summary_json: string | null;
    };
    expect(payload.fam_properties).toHaveLength(3);
    expect(payload.dev_properties.length).toBeGreaterThan(0);
    // 第二阶段只补属性；几何引用留待暖几何回退解析，避免重复读取 DEV/PHM。
    expect(payload.refs.dev_solid_models).toHaveLength(0);
    expect(payload.capability_summary_json).toBeNull();
    expect(deps.onPhase.mock.calls.map((c) => c[0]))
      .toEqual(['sourceTextStart', 'sourceTextReady', 'saveRestStart', 'saveRestReady']);
  });

  it('rest aborts before saving when the session changes during text reads', async () => {
    const input = await fixture();
    const deps = restDeps();
    const read = deferred<string>();
    let active = true;
    deps.isCurrent = () => active;
    vi.spyOn(input.files.get('CBM/props.fam')!, 'text').mockReturnValue(read.promise);
    const work = publishSubstationRest(input, deps);
    active = false;
    read.resolve('key=value');
    expect(await work).toBe(false);
    expect(deps.saveRest).not.toHaveBeenCalled();
  });

  it('full payload still round-trips through real SQLite', async () => {
    const input = await fixture();
    const index = await buildGimIndexPayload(
      input.projectId, input.files, input.ifcs, input.tree, input.relations,
      input.cachePaths, input.sourceSha256,
    );
    const refs = await buildGeometryRefsPayload(input.projectId, input.files, input.sourceSha256);
    const [result] = sqliteRoundTrip([{ index, refs }]);
    expect(result.index.fam_properties).toHaveLength(3);
    expect(result.index.dev_properties.length).toBeGreaterThan(0);
  });
});
