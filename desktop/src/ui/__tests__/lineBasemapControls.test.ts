import { expect, it } from 'vitest';
import { renderBasemapControls } from '../lineBasemapControls.js';
import type { LineMapData } from '../../gim/lineMapData.js';

it('binds basemap buttons to the current map instance and replaces stale controls', () => {
  const host = document.createElement('div'), panel = document.createElement('div');
  host.append(panel); document.body.append(host);
  const data = {} as LineMapData, selected: string[] = [];
  try {
    renderBasemapControls(panel, data, 'empty', (mode, container, value) => {
      expect(container).toBe(host); expect(value).toBe(data); selected.push(mode);
    });
    expect(panel.querySelectorAll('.basemap-switcher-section')).toHaveLength(1);
    (panel.querySelector('button') as HTMLButtonElement).click();
    expect(selected).toEqual(['osm-online']);
    renderBasemapControls(panel, data, 'osm-online', () => { throw Error('active mode should not switch'); });
    expect(panel.querySelectorAll('.basemap-switcher-section')).toHaveLength(1);
    (panel.querySelector('button') as HTMLButtonElement).click();
  } finally { host.remove(); }
});
