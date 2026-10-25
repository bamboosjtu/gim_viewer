import { afterEach, expect, it, vi } from 'vitest';
import { setupViewerShell } from '../shell/viewerShell.js';
import { showLoading } from '../../services/gimOpenCore.js';

vi.mock('@desktop/runtime.js', () => ({ isTauri: () => false }));
vi.mock('../../services/gimOpenCore.js', () => ({ showLoading: vi.fn(), hideLoading: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

function fixture() {
  document.body.innerHTML = '<button id="menu-previous-view"></button><span id="status-selection">设备 A</span><div id="loading" hidden></div>';
  let reject!: (error: Error) => void;
  const state = {
    currentProjectType: 'substation', selectionRequest: { id: 1 },
    captureProjectSession: () => ({ generation: 1 }), isCurrentSession: vi.fn(() => true),
    viewHistory: { back: vi.fn(() => new Promise<boolean>((_, fail) => { reject = fail; })) },
  };
  setupViewerShell(state as any);
  document.getElementById('menu-previous-view')!.click();
  return { state, fail: async () => { reject(new Error('camera unavailable')); await Promise.resolve(); } };
}

it('reports a failed back action without creating project loading feedback', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { fail } = fixture(); await fail();
  expect(document.getElementById('status-selection')!.textContent).toBe('暂时无法恢复上一视角，请重试。');
  expect(showLoading).not.toHaveBeenCalled();
  expect(document.getElementById('loading')!.hidden).toBe(true);
});

it.each(['project', 'selection'])('drops old failure feedback after a newer %s', async kind => {
  const { state, fail } = fixture();
  if (kind === 'project') state.isCurrentSession.mockReturnValue(false);
  else state.selectionRequest = { id: 2 };
  document.getElementById('status-selection')!.textContent = '设备 B';
  await fail();
  expect(document.getElementById('status-selection')!.textContent).toBe('设备 B');
  expect(showLoading).not.toHaveBeenCalled();
});
