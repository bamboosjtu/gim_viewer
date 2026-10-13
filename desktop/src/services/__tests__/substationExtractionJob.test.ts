import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../../app/state.js';
import { startSubstationExtractionJob, cancelSubstationExtraction, isSubstationSourceMaterializing } from '../substationExtractionJob.js';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), decode: vi.fn(), mark: vi.fn() }));
vi.mock('@desktop/database.js', () => ({ batchReadCachedFiles: async (_id: number, paths: string[]) => new Map(paths.map(p => [p, new TextEncoder().encode('exact')])) }));
vi.mock('@desktop/invokeTimed.js', () => ({ invokeTimed: mocks.invoke }));
vi.mock('@desktop/substationParseCopy.js', () => ({ decodeSubstationParseCopy: mocks.decode, readSubstationParseCopy: vi.fn() }));
vi.mock('../../utils/perfTimings.js', () => ({ perfCurrentSession: () => ({}), perfMark: mocks.mark, perfBegin: () => () => {} }));
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const entries: [string, number][] = [['CBM/project.cbm', 3], ['DEV/a.fam', 0], ['CBM/a.ifc', 4]];
const initial = { jobId: 'job-1', projectId: 1, sourceSha256: 'sha', entries, status: 'running', semanticCopy: null };
const ready = { ...initial, status: 'semanticReady', semanticCopy: { size: 1, sha256: 'copy' }, semanticReadyAtMs: 10 };
const complete = { ...ready, status: 'complete', cacheRoot: 'C:/final/1', materializationCompleteAtMs: 30, trace: [], profile: {} };
function setup() {
  const state = new AppState(), session = state.activateProject(1, 'sha');
  const first = deferred<any>(), next = deferred<any>(); let polls = 0;
  mocks.decode.mockResolvedValue(new Map([['CBM/project.cbm', new TextEncoder().encode('A=1')], ['DEV/a.fam', new Uint8Array()]]));
  mocks.invoke.mockImplementation((name: string, args: any) => {
    if (name === 'start_substation_extraction') return Promise.resolve(initial);
    if (name === 'substation_extraction_status') return args.details ? Promise.resolve(complete) : (++polls === 1 ? first.promise : next.promise);
    if (name === 'read_substation_extraction_source') return Promise.resolve(new Uint8Array([1]).buffer);
    return Promise.resolve();
  });
  return { state, session, first, next };
}
describe('production early extraction orchestration', () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.invoke.mockReset(); mocks.decode.mockReset(); mocks.mark.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });
  it('early exact semantic inputs are readable before source publication; final paths await completion', async () => {
    const f = setup(), opening = startSubstationExtractionJob(f.state, f.session, 'C:/a.gim', 1);
    await vi.advanceTimersByTimeAsync(0); f.first.resolve(ready);
    const source = await opening;
    expect(await source.files.get('CBM/project.cbm')!.text()).toBe('A=1');
    expect(await source.files.get('DEV/a.fam')!.text()).toBe('');
    expect(source.cachePaths!.size).toBe(0);
    expect(isSubstationSourceMaterializing(f.state)).toBe(true);
    f.next.resolve(complete); await vi.advanceTimersByTimeAsync(200); await source.sourceMaterialization;
    expect(source.cachePaths!.size).toBe(3);
    expect(isSubstationSourceMaterializing(f.state)).toBe(false);
    cancelSubstationExtraction(f.state);
  });
  it('optional copy failure waits for full materialization and keeps the existing batch fallback', async () => {
    const f = setup(), opening = startSubstationExtractionJob(f.state, f.session, 'C:/a.gim', 1);
    await vi.advanceTimersByTimeAsync(0);
    f.first.resolve({ ...complete, semanticCopy: null });
    const source = await opening;
    expect(source.earlySemantic).toBe(false);
    expect(source.cacheProjectId).toBe(1);
    expect(source.cachePaths!.size).toBe(3);
    expect(mocks.decode).not.toHaveBeenCalled();
    cancelSubstationExtraction(f.state);
  });

  it('later geometry extraction failure cannot publish an early semantic receipt', async () => {
    const f = setup(), opening = startSubstationExtractionJob(f.state, f.session, 'C:/a.gim', 1);
    await vi.advanceTimersByTimeAsync(0); f.first.resolve(ready); const source = await opening;
    const failure = expect(source.sourceMaterialization).rejects.toThrow('CRC failure');
    f.next.resolve({ ...ready, status: 'failed', error: 'CRC failure' }); await vi.advanceTimersByTimeAsync(200); await failure;
    expect(source.cachePaths!.size).toBe(0);
    expect(mocks.mark.mock.calls.some(([name]) => name === 'sourceMaterializationComplete')).toBe(false);
    cancelSubstationExtraction(f.state);
  });
  it('project close/switch revokes late source completion and releases job ownership', async () => {
    const f = setup(), opening = startSubstationExtractionJob(f.state, f.session, 'C:/a.gim', 1);
    await vi.advanceTimersByTimeAsync(0); f.first.resolve(ready); const source = await opening;
    const failure = expect(source.sourceMaterialization).rejects.toThrow('cancelled');
    f.state.activateProject(2, 'sha-B'); cancelSubstationExtraction(f.state);
    f.next.resolve(complete); await vi.advanceTimersByTimeAsync(200); await failure;
    expect(source.cachePaths!.size).toBe(0);
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_substation_extraction', { jobId: 'job-1' });
    expect(mocks.mark.mock.calls.some(([name]) => name === 'sourceMaterializationComplete')).toBe(false);
  });
  it('close while native start is pending cancels the returned job before parsing', async () => {
    const f = setup(), started = deferred<any>(); mocks.invoke.mockImplementation((name: string) => name === 'start_substation_extraction' ? started.promise : Promise.resolve());
    const opening = startSubstationExtractionJob(f.state, f.session, 'C:/a.gim', 1);
    const failure = expect(opening).rejects.toThrow('cancelled');
    f.state.activateProject(2, 'sha-B'); started.resolve(initial); await failure;
    expect(mocks.decode).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_substation_extraction', { jobId: 'job-1' });
  });
});
