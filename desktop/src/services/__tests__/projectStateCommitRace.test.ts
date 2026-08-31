import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../../app/state.js';
import type { CbmNode, FileDevEntry, IfcEntry } from '../../gim/types.js';
import type { StdSldParseResult } from '../stdSldService.js';
import { onGimExtracted } from '../openGimService.js';

const mocks = vi.hoisted(() => ({
  discoverIfcFromCBM: vi.fn(),
  scanIfcFiles: vi.fn(),
  buildIfcGuidIndex: vi.fn(() => new Map()),
  buildCbmTree: vi.fn(),
  buildCbmNodeIndex: vi.fn(() => new Map()),
  buildSubstationSpatialIndexFromFiles: vi.fn(),
  parseFileDevRelation: vi.fn(),
  buildAndRenderCbmTree: vi.fn(),
  renderFileDevPanel: vi.fn(),
  parseStdSldOnGimExtracted: vi.fn(),
  commitStdSldResult: vi.fn((state: AppState, result: StdSldParseResult | null) => {
    state.currentStdDoc = result?.stdDoc ?? null;
    state.currentSldDoc = result?.sldDoc ?? null;
    state.currentStdSldIndex = result?.index ?? null;
  }),
  renderSldView: vi.fn(),
  setSldGridIdClickHandler: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
  pushBusy: vi.fn(),
  popBusy: vi.fn(),
  setProjectIdentity: vi.fn(),
  refreshNavigatorTitle: vi.fn(),
}));

vi.mock('../../gim/gimIndexer.js', () => ({
  discoverIfcFromCBM: mocks.discoverIfcFromCBM,
  scanIfcFiles: mocks.scanIfcFiles,
  buildIfcGuidIndex: mocks.buildIfcGuidIndex,
}));
vi.mock('../../gim/cbmParser.js', () => ({
  buildCbmTree: mocks.buildCbmTree,
  buildCbmNodeIndex: mocks.buildCbmNodeIndex,
}));
vi.mock('../../gim/ifcSpatialParser.js', () => ({
  buildSubstationSpatialIndexFromFiles: mocks.buildSubstationSpatialIndexFromFiles,
  SubstationSpatialIndexBuilder: class {},
}));
vi.mock('../../gim/fileDevParser.js', () => ({ parseFileDevRelation: mocks.parseFileDevRelation }));
vi.mock('../../ui/cbmTreeView.js', () => ({ buildAndRenderCbmTree: mocks.buildAndRenderCbmTree }));
vi.mock('../../ui/fileDevView.js', () => ({ renderFileDevPanel: mocks.renderFileDevPanel }));
vi.mock('../stdSldService.js', () => ({
  parseStdSldOnGimExtracted: mocks.parseStdSldOnGimExtracted,
  commitStdSldResult: mocks.commitStdSldResult,
}));
vi.mock('../../ui/sldView.js', () => ({
  renderSldView: mocks.renderSldView,
  setSldGridIdClickHandler: mocks.setSldGridIdClickHandler,
}));
vi.mock('../../ui/shell/statusBar.js', () => ({
  pushBusy: mocks.pushBusy,
  popBusy: mocks.popBusy,
}));
vi.mock('../../ui/shell/projectBar.js', () => ({
  setProjectIdentity: mocks.setProjectIdentity,
  refreshNavigatorTitle: mocks.refreshNavigatorTitle,
}));
vi.mock('@desktop/runtime.js', () => ({ isTauri: () => false }));

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

function makeTree(label: string): CbmNode {
  return {
    path: `CBM/${label}.cbm`,
    name: label,
    entityName: 'F1System',
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
  };
}

function makeRelation(label: string): FileDevEntry[] {
  return [{
    ifcName: `${label}-source`,
    ifcFile: `${label}.ifc`,
    modelId: `model-${label}`,
    deviceCount: 1,
    deviceCbms: [`CBM/${label}.cbm`],
  }];
}

function makeSpatial(label: string): any {
  return {
    models: [{ modelId: `model-${label}`, containedObjectCount: 1, resourceCount: 1 }],
    nodes: [],
    objects: [],
    links: [],
    coverage: { uncontainedIfcObjects: 0 },
  };
}

function makeStdSldResult(label: string): StdSldParseResult {
  return {
    schEntries: [],
    stdDoc: { sourcePath: `${label}.std` } as any,
    sldDoc: { sourcePath: `${label}.sld` } as any,
    index: { source: label } as any,
  };
}

function makeDiskBackedFile(label: string, read: () => Promise<string>): File {
  return {
    name: `${label}.cbm`,
    size: 1,
    text: read,
  } as unknown as File;
}

function labelOf(files: Map<string, File>): string {
  return files.get('CBM/marker.cbm')?.name.startsWith('A') ? 'A' : 'B';
}

/**
 * 回归：所有“解析完成后提交 AppState”的边界都必须在同一会话内。
 * A 使用人为延迟的 DiskBackedFile.text()，切换到 B 并完成 B 后才让 A 返回；
 * A 的结果和异常均不能覆盖或清空 B 的 CBM/关系/空间/STD/SLD 状态。
 */
describe('openGimService AppState commit race', () => {
  it.each(['cbm', 'relation', 'spatial', 'std'])('%s 结果迟到时只保留工程 B', async (delayStage) => {
    vi.clearAllMocks();
    const gate = deferred<string>();
    const entered = deferred<void>();
    let pauseA = false;

    const readFileText = async (files: Map<string, File>, stage: string): Promise<string> => {
      const label = labelOf(files);
      if (label === 'A' && stage === delayStage) {
        pauseA = true;
        entered.resolve();
      }
      // 通过实际的 File.text() 入口读取；A 文件在指定阶段模拟 DiskBackedFile
      // 的慢速磁盘/IPC 返回，B 始终立即返回。
      return files.get('CBM/marker.cbm')!.text();
    };

    mocks.discoverIfcFromCBM.mockImplementation(async (files: Map<string, File>) => {
      const label = await readFileText(files, 'discover');
      return [{ name: `${label}.ifc`, path: `IFC/${label}.ifc`, modelId: `model-${label}` } satisfies IfcEntry];
    });
    mocks.buildCbmTree.mockImplementation(async (files: Map<string, File>) => {
      const label = await readFileText(files, 'cbm');
      return makeTree(label);
    });
    mocks.parseFileDevRelation.mockImplementation(async (files: Map<string, File>) => {
      const label = await readFileText(files, 'relation');
      return makeRelation(label);
    });
    mocks.buildSubstationSpatialIndexFromFiles.mockImplementation(async (files: Map<string, File>) => {
      const label = await readFileText(files, 'spatial');
      return makeSpatial(label);
    });
    mocks.parseStdSldOnGimExtracted.mockImplementation(async (state: AppState, files: Map<string, File>) => {
      const label = await readFileText(files, 'std');
      // 与真实服务一样，解析器只返回局部结果，不触碰 state。
      void state;
      return makeStdSldResult(label);
    });

    const state = new AppState();
    const sessionA = state.activateProject(1, 'sha-a');
    const filesA = new Map<string, File>([['CBM/marker.cbm', makeDiskBackedFile('A', async () => pauseA ? gate.promise : 'A')]]);
    const filesB = new Map<string, File>([['CBM/marker.cbm', makeDiskBackedFile('B', async () => 'B')]]);
    const noMessage = vi.fn();

    const loadingA = onGimExtracted(state, filesA, noMessage, 'A', '变电工程', sessionA);
    await entered.promise;

    // 清理流程的真实顺序：失效 → reset → 激活 B。
    state.invalidatePendingLoads();
    state.resetGimState();
    const sessionB = state.activateProject(2, 'sha-b');
    await onGimExtracted(state, filesB, noMessage, 'B', '变电工程', sessionB);

    expect(state.currentCbmTree?.name).toBe('B');
    expect(state.fileDevRelations[0]?.ifcName).toBe('B-source');
    expect(state.substationSpatialIndex?.models[0]?.modelId).toBe('model-B');
    expect((state.currentStdDoc as any)?.sourcePath).toBe('B.std');
    expect((state.currentSldDoc as any)?.sourcePath).toBe('B.sld');
    expect((state.currentStdSldIndex as any)?.source).toBe('B');

    gate.resolve('A');
    await loadingA;

    // A 的迟到结果不能覆盖 B；所有五个状态都仍指向 B。
    expect(state.currentCbmTree?.name).toBe('B');
    expect(state.fileDevRelations[0]?.ifcName).toBe('B-source');
    expect(state.substationSpatialIndex?.models[0]?.modelId).toBe('model-B');
    expect((state.currentStdDoc as any)?.sourcePath).toBe('B.std');
    expect((state.currentSldDoc as any)?.sourcePath).toBe('B.sld');
    expect((state.currentStdSldIndex as any)?.source).toBe('B');
  });

  it.each(['relation', 'spatial'])('%s 解析异常迟到时不能清空工程 B', async (errorStage) => {
    vi.clearAllMocks();
    const gate = deferred<string>();
    const entered = deferred<void>();
    let pauseA = false;
    const read = async (files: Map<string, File>, stage: string): Promise<string> => {
      const label = labelOf(files);
      if (label === 'A' && stage === errorStage) {
        pauseA = true;
        entered.resolve();
      }
      return files.get('CBM/marker.cbm')!.text();
    };

    mocks.discoverIfcFromCBM.mockImplementation(async (files: Map<string, File>) => [{
      name: `${labelOf(files)}.ifc`, path: `IFC/${labelOf(files)}.ifc`, modelId: `model-${labelOf(files)}`,
    }]);
    mocks.buildCbmTree.mockImplementation(async (files: Map<string, File>) => makeTree(labelOf(files)));
    mocks.parseFileDevRelation.mockImplementation(async (files: Map<string, File>) => {
      const label = await read(files, 'relation');
      return makeRelation(label);
    });
    mocks.buildSubstationSpatialIndexFromFiles.mockImplementation(async (files: Map<string, File>) => {
      const label = await read(files, 'spatial');
      return makeSpatial(label);
    });
    mocks.parseStdSldOnGimExtracted.mockResolvedValue(makeStdSldResult('B'));

    const state = new AppState();
    const sessionA = state.activateProject(1, 'sha-a');
    const filesA = new Map<string, File>([['CBM/marker.cbm', makeDiskBackedFile('A', async () => pauseA ? gate.promise : 'A')]]);
    const filesB = new Map<string, File>([['CBM/marker.cbm', makeDiskBackedFile('B', async () => 'B')]]);
    const loadingA = onGimExtracted(state, filesA, vi.fn(), 'A', '变电工程', sessionA);
    await entered.promise;

    state.invalidatePendingLoads();
    state.resetGimState();
    const sessionB = state.activateProject(2, 'sha-b');
    await onGimExtracted(state, filesB, vi.fn(), 'B', '变电工程', sessionB);

    gate.reject(new Error(`A ${errorStage} failed`));
    await loadingA;

    expect(state.currentCbmTree?.name).toBe('B');
    expect(state.fileDevRelations[0]?.ifcName).toBe('B-source');
    expect(state.substationSpatialIndex?.models[0]?.modelId).toBe('model-B');
  });
});
