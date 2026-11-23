import { beforeEach, expect, it, vi } from 'vitest';
import { AppState } from '../../state.js';
import { openIfcWithDialog } from '../openIfc.js';
import { bindProjectOpenPresentation } from '../../../services/presentation/projectOpenPresentationPort.js';

const deps = vi.hoisted(() => ({ viewer: vi.fn(), ensureEngine: vi.fn(), load: vi.fn() }));
vi.mock('@desktop/runtime.js', () => ({ isTauri: () => false }));
vi.mock('../../../services/presentation/viewerUIBinding.js', () => ({ getViewerRuntimeWithUI: deps.viewer }));
vi.mock('../../../viewer/ifcLoader.js', () => ({ ensureEngineReady: deps.ensureEngine, loadStandaloneIfc: deps.load }));
vi.mock('../../../viewer/camera.js', () => ({ fitCameraToScene: vi.fn() }));
vi.mock('../../../services/project/gimOpenCore.js', async (original) => ({
  ...await original<typeof import('../../../services/project/gimOpenCore.js')>(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));

const chooseIfc = vi.fn(), setBusy = vi.fn(), resetInput = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  bindProjectOpenPresentation({ chooseIfc, setBusy, resetInput, chooseGim: async () => null });
});

it('rejects an IFC choice that arrives for a replaced project', async () => {
  const state = new AppState();
  state.activateProject(1, 'old');
  let choose!: (files: File[]) => void;
  chooseIfc.mockReturnValue(new Promise<File[]>((resolve) => { choose = resolve; }));
  const opening = openIfcWithDialog(state, vi.fn());
  state.activateProject(2, 'new');
  choose([new File(['ifc'], 'old.ifc')]);
  await opening;
  expect(deps.viewer).not.toHaveBeenCalled();
  expect(setBusy).not.toHaveBeenCalled();
});

it('releases the IFC controls on project switch and rejects the late Viewer result', async () => {
  const state = new AppState();
  state.activateProject(1, 'old');
  chooseIfc.mockResolvedValue([new File(['ifc'], 'old.ifc')]);
  let resolveViewer!: (runtime: unknown) => void;
  deps.viewer.mockReturnValue(new Promise((resolve) => { resolveViewer = resolve; }));
  const opening = openIfcWithDialog(state, vi.fn());
  await expect.poll(() => deps.viewer.mock.calls.length).toBe(1);
  state.activateProject(2, 'new');
  expect(setBusy.mock.calls).toEqual([['ifc', true], ['ifc', false]]);
  expect(resetInput).toHaveBeenCalledOnce();
  expect(resetInput).toHaveBeenCalledWith('ifc');
  resolveViewer({ ctx: {}, modelCallbacks: {} });
  await opening;
  expect(deps.ensureEngine).not.toHaveBeenCalled();
  expect(deps.load).not.toHaveBeenCalled();
  expect(setBusy).toHaveBeenCalledTimes(2);
});
