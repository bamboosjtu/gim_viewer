import { expect, it } from 'vitest';
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
