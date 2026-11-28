import { expect, it, vi } from 'vitest';
import { mountPatrolOverlay } from '../patrolOverlay.js';
import { ViewerNavigationCommands } from '../../shared/viewerNavigationCommands.js';
it('consumes the whole Escape press even when cancelling immediately returns to orbit', () => {
  const commands = new ViewerNavigationCommands(),
    group = document.createElement('div'),
    view = document.createElement('div');
  const panel = mountPatrolOverlay(commands, group, view);
  expect(panel.enter.matches('.viewer-glyph[data-icon="patrol"]')).toBe(true);
  expect(panel.enter.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24');
  expect(panel.enter.querySelector('.viewer-command-caption')?.textContent).toBe('巡视');
  expect(panel.enter.getAttribute('aria-label')).toBe('进入巡视');
  let clears = 0,
    exits = 0;
  commands.execute = () => {
    exits++;
    commands.set('orbit');
  };
  const normal = (e: KeyboardEvent) => {
    if (!e.defaultPrevented) clears++;
  };
  document.addEventListener('keydown', normal);
  try {
    commands.set('ready');
    const esc = (repeat = false) =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, repeat }),
      );
    esc();
    esc(true);
    expect(exits).toBe(1);
    expect(clears).toBe(0);
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }));
    esc();
    expect(clears).toBe(1);
  } finally {
    panel.dispose();
    document.removeEventListener('keydown', normal);
  }
});

it('keeps the first-person HUD quiet, shows actual blockers, and restores the property drawer', () => {
  const main = document.createElement('div');
  main.id = 'main';
  main.innerHTML = '<div id="viewport"></div><aside id="props-drawer" class="collapsed"></aside>';
  const viewport = main.querySelector<HTMLElement>('#viewport')!;
  const drawer = main.querySelector('#props-drawer')!;
  const commands = new ViewerNavigationCommands();
  commands.execute = vi.fn();
  const overlay = mountPatrolOverlay(commands, document.createElement('div'), viewport);
  const walking = viewport.querySelector<HTMLElement>('.patrol-walking')!;
  const panel = viewport.querySelector<HTMLElement>('.patrol-panel')!;
  try {
    commands.set('ready', '已定位站区大门');
    expect(viewport.hasAttribute('data-patrol-active')).toBe(false);
    commands.dragLook = true;
    commands.set('walking', '开始巡视');
    expect(viewport.hasAttribute('data-patrol-active')).toBe(true);
    expect(walking.hidden).toBe(false);
    expect(walking.textContent).toContain('按住左键拖动');
    expect(panel.hidden).toBe(true);
    commands.set('walking', '无连续落脚面');
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector('[role=status]')?.textContent).toBe('无连续落脚面');
    walking.querySelector('button')?.click();
    expect(commands.execute).toHaveBeenCalledWith('pause');
    commands.set('inspecting');
    drawer.classList.remove('collapsed');
    expect(walking.hidden).toBe(true);
    commands.set('paused');
    expect(panel.querySelector('h2')?.textContent).toBe('巡视暂停');
    commands.set('orbit');
    expect(drawer.classList.contains('collapsed')).toBe(true);
    expect(viewport.hasAttribute('data-patrol-active')).toBe(false);
  } finally {
    overlay.dispose();
  }
});

it('shows live object completion and keeps preparation cancellable and nonmodal',()=>{
 const port=new ViewerNavigationCommands(),group=document.createElement('div'),view=document.createElement('div');port.execute=vi.fn();
 const overlay=mountPatrolOverlay(port,group,view);port.compiling=true;port.browseReady=true;port.preparationProgress={done:80,total:3434};port.set('preparing','processing');
 expect(view.dataset.patrolPreparing).toBe('');expect(view.querySelector('progress')!.value).toBe(80);expect(view.querySelector('progress')!.max).toBe(3434);
 expect(view.querySelector<HTMLElement>('.patrol-backdrop')!.hidden).toBe(true);
 view.querySelector<HTMLButtonElement>('[data-cancel]')!.click();expect(port.execute).toHaveBeenCalledWith('exit');overlay.dispose();
});
