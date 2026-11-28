import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Matrix4, Object3D, Vector3 } from 'three';
import type { AppState } from '../../../../app/state.js';
import type { SessionScope } from '../../../../shared/sessionScope.js';
import { ViewerNavigationCommands } from '../../../../shared/viewerNavigationCommands.js';
import { bindPatrol } from '../patrolBinding.js';

const f = vi.hoisted(() => ({
  viewer: vi.fn(),
  pick: vi.fn(),
  restore: vi.fn(),
  clear: vi.fn(),
  toggle: vi.fn(),
  inspect: vi.fn(),
  visible: vi.fn(),
  prepare: vi.fn(),
  relocate: vi.fn(),
  dispose: vi.fn(),
  resumeHistory: vi.fn(),
}));
vi.mock('../../../../services/presentation/viewerUIBinding.js', () => ({
  getViewerRuntimeWithUI: f.viewer,
}));
vi.mock('../../../../services/selection/selectionCommands.js', () => ({
  clearCurrentSelection: f.clear,
}));
vi.mock('../../../../viewer/selection.js', () => ({ pickVisibleRay: f.pick }));
vi.mock('../../../../viewer/cameraPoseHub.js', () => ({
  cameraPoseHub: () => ({
    subscribe: () => () => {},
    claim: vi.fn(),
    publish: vi.fn(),
    startAdmissionTrace: vi.fn(),
    stopAdmissionTrace: vi.fn(),
  }),
}));
vi.mock('../../../../viewer/patrol/patrolContextSnapshot.js', () => ({
  capturePatrolCamera: () => ({ enabled: true, buttons: {} }),
  freezeOrbit: vi.fn(),
  restoreOrbit: f.restore,
}));
const pose = () => ({ feet: new Vector3(1, 2, 3), sourceId: 'road', yaw: 0, pitch: 0 });
vi.mock('../../runtime/patrolNavigationRuntime.js', () => ({
  PatrolNavigationRuntime: class {
    metrics = { estimatedSectionOccurrences: 0 };
    hasDoors = true;
    toggleDoor = f.toggle;
    leave = vi.fn();
    dispose = vi.fn();
    canOperate = () => true;
    doorReach = () => 3.4;
    stationEntrance = async () => pose();
    prepareScene = f.prepare;
    step = pose;
  },
}));
vi.mock('../../../../viewer/patrol/firstPersonController.js', () => ({
  FirstPersonController: class {
    constructor(
      _ctx: unknown,
      _canvas: HTMLElement,
      private port: ViewerNavigationCommands,
    ) {}
    feet = pose().feet;
    position = pose;
    relocate = f.relocate;
    stop = vi.fn();
    dispose = f.dispose;
    takeCamera = vi.fn();
    walk = () => this.port.set('walking');
  },
}));

async function walking(gridVisible = true) {
  const controller = new AbortController(),
    navigation = new ViewerNavigationCommands();
  const matrix = new Matrix4(),
    controls = { enabled: true, mouseButtons: {} };
  const state = {
    navigation,
    projectCoordinateFrame: { matrix, confidence: 'fragments-base' },
    projectSourceToViewerMatrix: matrix,
    viewerCommands: { snapshot: { tool: 'select', distances: [] }, notify: vi.fn() },
    captureProjectSession: () => ({}),
    viewState: {
      viewHistory: { interruptRestore: vi.fn(), suspend: vi.fn(), resume: f.resumeHistory },
    },
    selection: { onlySelected: false },
    geometryLoadToken: 1,
  };
  let dispose = () => {};
  const scope = {
    isCurrent: () => !controller.signal.aborted,
    signal: controller.signal,
    session: { generation: 1 },
    own: (cb: () => void) => {
      dispose = cb;
    },
  };
  const referenceGrid = new Object3D();
  referenceGrid.visible = gridVisible;
  f.viewer.mockResolvedValue({
    ctx: {
      referenceGrid,
      world: {
        renderer: { three: { domElement: document.createElement('canvas') } },
        camera: { controls, projection: { set: vi.fn() } },
      },
    },
    patrol: {
      clip: vi.fn(),
      inspect: f.inspect,
      visibility: { getVisibility: () => ({}), setVisibility: f.visible },
    },
  });
  f.pick.mockResolvedValue({
    near: { distance: 1, runtime: { sourcePath: 'door.ifc' }, object: { expressId: 7 } },
  });
  const show = vi.fn();
  await bindPatrol(state as unknown as AppState, scope as unknown as SessionScope, show);
  await vi.waitFor(() => expect(navigation.mode, String(show.mock.calls)).toBe('ready'));
  navigation.execute!('start');
  await vi.waitFor(() => expect(navigation.mode).toBe('walking'));
  return {
    navigation,
    referenceGrid,
    state,
    show,
    cleanup: () => {
      controller.abort();
      dispose();
    },
  };
}
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  // jsdom 25 lacks the signal composition available in the fixed WebView2 runtime.
  vi.stubGlobal(
    'AbortSignal',
    class extends AbortSignal {
      static override any(signals: AbortSignal[]) {
        const result = new AbortController();
        for (const signal of signals) {
          if (signal.aborted) result.abort();
          else signal.addEventListener('abort', () => result.abort(), { once: true });
        }
        return result.signal;
      }
    },
  );
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('patrol command ownership', () => {
  it.each([true, false])(
    'hides the reference grid while walking and restores visibility %s on teardown',
    async (visible) => {
      const { navigation, referenceGrid, cleanup } = await walking(visible);
      expect(referenceGrid.visible).toBe(false);
      cleanup();
      expect(navigation.mode).toBe('orbit');
      expect(referenceGrid.visible).toBe(visible);
    },
  );
  it('freezes the person through the door pick and sweep, and rejects a late completion after cancel', async () => {
    const door = deferred();
    f.toggle.mockReturnValue(door.promise);
    const { navigation: port, cleanup } = await walking();
    try {
      port.execute!('door');
      expect(port.mode).toBe('operatingDoor');
      for (const action of ['resume', 'measure', 'return', 'inspect', 'door'] as const)
        port.execute!(action);
      expect(port.mode).toBe('operatingDoor');
      await vi.waitFor(() => expect(f.toggle).toHaveBeenCalledOnce());
      const signal = f.toggle.mock.calls[0][2] as AbortSignal;
      port.escape();
      await vi.waitFor(() => expect(port.mode).toBe('paused'));
      expect(signal.aborted).toBe(true);
      port.execute!('resume');
      door.resolve('旧门扇结果');
      await door.promise;
      expect(port.mode).toBe('walking');
      expect(port.message).not.toContain('旧门扇结果');
      expect(f.relocate).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
  it('rejects a late inspection completion after exiting', async () => {
    const result = deferred();
    f.inspect.mockReturnValue(result.promise);
    const { navigation: port, cleanup } = await walking();
    try {
      port.execute!('inspect');
      await vi.waitFor(() => expect(f.inspect).toHaveBeenCalledOnce());
      port.execute!('resume');
      port.execute!('measure');
      expect(port.mode).toBe('pickingDevice');
      port.execute!('exit');
      await vi.waitFor(() => expect(port.mode).toBe('orbit'));
      result.resolve('late');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(port.mode).toBe('orbit');
    } finally {
      cleanup();
    }
  });
  it('finishes exit in orbit and restores remaining tools when selection and visibility both fail', async () => {
    const { navigation: port, referenceGrid, state, show, cleanup } = await walking();
    try {
      port.execute!('inspect');
      await vi.waitFor(() => expect(port.mode).toBe('inspecting'));
      f.clear.mockRejectedValue(Error('selection failure'));
      const visibility = deferred();
      f.visible.mockImplementation(async () => {
        await visibility.promise;
        throw Error('visibility failure');
      });
      port.execute!('exit');
      await vi.waitFor(() => expect(f.visible).toHaveBeenCalledOnce());
      for (const action of ['resume', 'return', 'exit', 'prepare'] as const) port.execute!(action);
      expect(port.mode).toBe('exiting');
      visibility.resolve('');
      await vi.waitFor(() => expect(port.mode).toBe('orbit'));
      expect(f.dispose).toHaveBeenCalledOnce();
      expect(f.resumeHistory).toHaveBeenCalledOnce();
      expect(referenceGrid.visible).toBe(true);
      expect(state.viewerCommands.notify).toHaveBeenCalled();
      expect(show).toHaveBeenCalledWith(
        expect.stringMatching(/选择.*selection failure.*显隐.*visibility failure/),
      );
      port.execute!('resume');
      expect(port.mode).toBe('orbit');
      port.execute!('prepare');
      await vi.waitFor(() => expect(port.mode).toBe('ready'));
    } finally {
      cleanup();
    }
  });
});
