// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { buildPowerlineProject } from '@gim/powerline-core';
import { AppState } from '../../app/state.js';
import { buildLineGimGraphFromTexts } from '../../gim/lineCbmParserCore.js';
import { StaleSessionError } from '../../shared/sessionScope.js';
import { loadLineModSourcesForNode } from '../lineModRuntimeService.js';
import { node } from './lineNavigationFixture.js';

const native = vi.hoisted(() => ({
  readExtractionManifest: vi.fn(),
  readCachedEntry: vi.fn(),
}));
vi.mock("../../infrastructure/native/gimExtract.js", () => ({ readExtractionManifest: native.readExtractionManifest }));
vi.mock('../../infrastructure/native/projectFiles.js', () => ({ readCachedEntry: native.readCachedEntry }));

beforeEach(() => { vi.resetAllMocks(); });

const mod = (code: string) => `CODE=${code}\nPOINTNUM=1\nLINENUM=0\nPOINT0=1,30,110,1,P`;
const references = (devPath: string) => node({ refs: { ...node().refs, devFiles: [devPath] } });
const filesFrom = (texts: Map<string, string>) =>
  new Map([...texts].map(([path, text]) => [path, new File([text], path)]));

it.each(['cold', 'warm'] as const)('resolves nested paths and reuses in-flight reads on %s open', async mode => {
  const texts = new Map([
    ['CBM/project.cbm', 'OBJECTMODELPOINTER=A/root.dev'],
    ['A/root.dev', 'SUBDEVICES.NUM=1\nSUBDEVICE0=child.dev'],
    ['A/child.dev', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=part.phm\nSUBDEVICES.NUM=1\nSUBDEVICE0=root.dev'],
    ['A/part.phm', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=next.phm'],
    ['A/next.phm', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=BoDy.mod'],
    ['A/body.mod', mod('right')],
    ['Phm/part.phm', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=body.mod'],
    ['Mod/body.mod', mod('wrong')],
  ]);
  const root = buildLineGimGraphFromTexts([...texts].map(([path, text]) => ({ path, text }))).root!;
  const files = filesFrom(texts);
  const reads = [...files].map(([path, file]) => [path, vi.spyOn(file, 'arrayBuffer')] as const);
  const enumeratePaths = vi.spyOn(files, 'keys');
  const state = new AppState();
  state.activateProject(7, 'source');
  state.currentFiles = mode === 'cold' ? files : null;
  native.readExtractionManifest.mockResolvedValue({
    source_sha256: 'source',
    entries: [...texts.keys()].map(path => ({ path })),
  });
  native.readCachedEntry.mockImplementation(async (_id: number, path: string) => {
    const text = texts.get(path);
    if (text === undefined) throw Error('unexpected source');
    return new TextEncoder().encode(text);
  });
  const [first, second] = await Promise.all([
    loadLineModSourcesForNode(state, root),
    loadLineModSourcesForNode(state, root),
  ]);
  expect(first).toEqual(second);
  expect(first).toMatchObject([{ path: 'A/body.mod', source: { records: { code: 'right' } } }]);
  const expected = ['A/root.dev', 'A/child.dev', 'A/part.phm', 'A/next.phm', 'A/body.mod'];
  if (mode === 'cold') {
    expect(native.readExtractionManifest).not.toHaveBeenCalled();
    expect(reads.flatMap(([path, read]) => read.mock.calls.map(() => path))).toEqual(expected);
    expect(enumeratePaths).toHaveBeenCalledOnce();
  } else {
    expect(native.readExtractionManifest).toHaveBeenCalledOnce();
    expect(native.readExtractionManifest).toHaveBeenCalledWith(7, expect.any(Function));
    expect(native.readCachedEntry.mock.calls).toEqual(expected.map(path => [7, path, expect.any(Function)]));
  }
});

it('leaves a nested basename unresolved when multiple candidates exist', async () => {
  const state = new AppState();
  state.currentFiles = filesFrom(new Map([
    ['A/root.dev', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=part.phm'],
    ['B/part.phm', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=body.mod'],
    ['Phm/part.phm', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=body.mod'],
    ['Mod/body.mod', mod('wrong')],
  ]));
  const read = vi.spyOn(state.currentFiles.get('Phm/part.phm')!, 'arrayBuffer');
  await expect(loadLineModSourcesForNode(state, references('A/root.dev'))).resolves.toEqual([]);
  expect(read).not.toHaveBeenCalled();
});

it.each([
  ['a\\body.mod', 'A/body.mod'],
  ['../A/body.mod', 'A/body.mod'],
  ['local/body.mod', 'B/local/body.mod'],
])('resolves %s to the same source in the desktop inspector and the mobile project', async (reference, expectedPath) => {
  const texts = new Map([
    ['CBM/project.cbm', 'GROUPS.NUM=1\nGROUP0=cross.cbm'],
    ['CBM/cross.cbm', 'ENTITYNAME=CROSS\nOBJECTMODELPOINTER=B/root.dev'],
    ['B/root.dev', `SOLIDMODELS.NUM=1\nSOLIDMODEL0=${reference}`],
    ['A/body.mod', mod('archive-root')],
    ['B/A/body.mod', mod('shadow')],
    ['B/local/body.mod', mod('owner-relative')],
  ]);
  const input = [...texts].map(([path, text]) => ({ path, text }));
  const graph = buildLineGimGraphFromTexts(input);
  const mobile = buildPowerlineProject(input, { id: 'test', name: 'test', sha256: 'test', size: 1 });
  const state = new AppState();
  state.currentFiles = filesFrom(texts);
  const desktop = await loadLineModSourcesForNode(state, graph.root!);
  expect(desktop.map(entry => entry.path)).toEqual([expectedPath]);
  expect(mobile.objects.find(object => object.kind === 'cross')?.sourceRefs.filter(path => path.endsWith('.mod')))
    .toEqual([expectedPath]);
});

it.each([false, true])('rejects a delayed A traversal and caches only the current result (A already reopened=%s)', async reopened => {
  const filesA = filesFrom(new Map([
    ['Dev/root.dev', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=part.phm'],
    ['Phm/part.phm', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=a.mod'],
    ['Mod/a.mod', mod('right')],
  ]));
  const filesB = filesFrom(new Map([
    ['Phm/part.phm', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=b.mod'],
    ['Mod/b.mod', mod('other')],
  ]));
  const root = filesA.get('Dev/root.dev')!;
  const payload = await root.arrayBuffer();
  let finish!: (bytes: ArrayBuffer) => void;
  const stalled = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  vi.spyOn(root, 'arrayBuffer').mockImplementationOnce(() => { begin(); return stalled; });
  const foreignRead = vi.spyOn(filesB.get('Phm/part.phm')!, 'arrayBuffer');
  const state = new AppState();
  state.activateProject(1, 'A');
  state.currentFiles = filesA;
  const source = references('Dev/root.dev');
  const stale = expect(loadLineModSourcesForNode(state, source)).rejects.toBeInstanceOf(StaleSessionError);
  await started;
  state.activateProject(2, 'B');
  state.currentFiles = filesB;
  const reopen = () => {
    state.activateProject(1, 'A');
    state.currentFiles = filesA;
  };
  if (reopened) reopen();
  finish(payload);
  await stale;
  if (!reopened) reopen();
  expect(foreignRead).not.toHaveBeenCalled();
  await expect(loadLineModSourcesForNode(state, source)).resolves.toMatchObject([
    { path: 'Mod/a.mod', source: { records: { code: 'right' } } },
  ]);
});

it.each(['cold', 'warm'] as const)('retries temporary DEV and PHM read failures on %s open', async mode => {
  const texts = new Map([
    ['A/retry.dev', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=dev-body.mod'],
    ['A/retry.phm', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=phm-body.mod'],
    ['A/dev-body.mod', mod('dev')],
    ['A/phm-body.mod', mod('phm')],
    ['A/independent.mod', mod('independent')],
  ]);
  const files = filesFrom(texts);
  const readDev = vi.spyOn(files.get('A/retry.dev')!, 'arrayBuffer');
  const readPhm = vi.spyOn(files.get('A/retry.phm')!, 'arrayBuffer');
  const readIndependent = vi.spyOn(files.get('A/independent.mod')!, 'arrayBuffer');
  const devError = new Error('temporary DEV read failure');
  const phmError = new Error('temporary PHM read failure');
  const failures = new Map([['A/retry.dev', devError], ['A/retry.phm', phmError]]);
  if (mode === 'cold') {
    readDev.mockRejectedValueOnce(devError);
    readPhm.mockRejectedValueOnce(phmError);
  }
  native.readExtractionManifest.mockResolvedValue({
    source_sha256: 'source',
    entries: [...texts.keys()].map(path => ({ path })),
  });
  native.readCachedEntry.mockImplementation(async (_id: number, path: string) => {
    const error = failures.get(path);
    if (error) {
      failures.delete(path);
      throw error;
    }
    return new TextEncoder().encode(texts.get(path));
  });
  const state = new AppState();
  state.activateProject(7, 'source');
  state.currentFiles = mode === 'cold' ? files : null;
  const root = node({ refs: {
    ...node().refs,
    devFiles: ['A/retry.dev'],
    phmFiles: ['A/retry.phm'],
    modFiles: ['A/independent.mod'],
  } });

  const [first, concurrent] = await Promise.all([
    loadLineModSourcesForNode(state, root),
    loadLineModSourcesForNode(state, root),
  ]);
  expect(first).toEqual(concurrent);
  expect(first).toMatchObject([
    { path: 'A/retry.dev', source: null, dependencyKind: 'dev', error: expect.stringContaining(devError.message) },
    { path: 'A/retry.phm', source: null, dependencyKind: 'phm', error: expect.stringContaining(phmError.message) },
    { path: 'A/independent.mod', source: { records: { code: 'independent' } } },
  ]);
  const recovered = await loadLineModSourcesForNode(state, root);
  expect(recovered).toMatchObject([
    { path: 'A/independent.mod', source: { records: { code: 'independent' } } },
    { path: 'A/dev-body.mod', source: { records: { code: 'dev' } } },
    { path: 'A/phm-body.mod', source: { records: { code: 'phm' } } },
  ]);
  await expect(loadLineModSourcesForNode(state, root)).resolves.toEqual(recovered);
  if (mode === 'cold') {
    expect(readDev).toHaveBeenCalledTimes(2);
    expect(readPhm).toHaveBeenCalledTimes(2);
    expect(readIndependent).toHaveBeenCalledOnce();
  } else {
    expect(native.readExtractionManifest).toHaveBeenCalledOnce();
    expect(native.readCachedEntry.mock.calls.map(([, path]) => path)).toEqual([
      'A/retry.dev', 'A/retry.phm', 'A/independent.mod', 'A/retry.dev', 'A/retry.phm', 'A/dev-body.mod', 'A/phm-body.mod',
    ]);
  }
});

it('retries a temporary MOD read failure without repeating a successful traversal', async () => {
  const state = new AppState();
  const files = filesFrom(new Map([
    ['A/root.dev', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=body.mod'],
    ['A/body.mod', mod('recovered')],
  ]));
  state.currentFiles = files;
  const devRead = vi.spyOn(files.get('A/root.dev')!, 'arrayBuffer');
  const modRead = vi.spyOn(files.get('A/body.mod')!, 'arrayBuffer')
    .mockRejectedValueOnce(new Error('temporary MOD read failure'));
  const root = references('A/root.dev');

  await expect(loadLineModSourcesForNode(state, root)).resolves.toMatchObject([
    { path: 'A/body.mod', source: null, error: expect.stringContaining('temporary MOD read failure') },
  ]);
  await expect(loadLineModSourcesForNode(state, root)).resolves.toMatchObject([
    { path: 'A/body.mod', source: { records: { code: 'recovered' } } },
  ]);
  expect(devRead).toHaveBeenCalledOnce();
  expect(modRead).toHaveBeenCalledTimes(2);
});

it.each(['DEV', 'PHM'] as const)('ends an over-budget %s traversal without reading excess sources', async kind => {
  const ext = kind.toLowerCase();
  const countKey = kind === 'DEV' ? 'SUBDEVICES.NUM' : 'SOLIDMODELS.NUM';
  const slot = kind === 'DEV' ? 'SUBDEVICE' : 'SOLIDMODEL';
  const count = 20_000;
  const names = Array.from({ length: count }, (_, index) => `child${index}.${ext}`);
  const rootPath = `A/root.${ext}`;
  const makeRoot = (refs: string[]) => new File([
    [`${countKey}=${refs.length}`, ...refs.map((path, index) => `${slot}${index}=${path}`)].join('\n'),
  ], rootPath);
  const child = new File([], `child.${ext}`);
  const childRead = vi.spyOn(child, 'arrayBuffer');
  const state = new AppState();
  state.currentFiles = new Map([
    [rootPath, makeRoot(names)],
    ...names.map((path): [string, File] => [`A/${path}`, child]),
  ]);
  const root = node({ refs: {
    ...node().refs,
    devFiles: kind === 'DEV' ? [rootPath] : [],
    phmFiles: kind === 'PHM' ? [rootPath] : [],
  } });
  await expect(loadLineModSourcesForNode(state, root)).rejects.toThrow(`${kind} 来源超过遍历上限 20000`);
  expect(childRead).not.toHaveBeenCalled();

  // A repeat does not consume a second slot. Including the root, this reaches the limit exactly.
  state.currentFiles.set(rootPath, makeRoot([...names.slice(1), names[1]]));
  await expect(loadLineModSourcesForNode(state, root)).resolves.toEqual([]);
  expect(childRead).toHaveBeenCalledTimes(count - 1);
});
