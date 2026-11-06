/**
 * Fragments 缓存灰度开关与版本键单测（acc-plan P0-3）。
 */

import { expect, it } from 'vitest';
import {
  runtimeBasemapMode, setRuntimeBasemapMode, resetRuntimeBasemapMode,
} from '../features.js';

it('persists the user-selected basemap across line project reopen', () => {
  localStorage.removeItem('gim-line-basemap-mode');
  resetRuntimeBasemapMode();
  expect(runtimeBasemapMode).toBe('osm-online');
  setRuntimeBasemapMode('tianditu-vector');
  expect(runtimeBasemapMode).toBe('tianditu-vector');
  resetRuntimeBasemapMode();
  expect(runtimeBasemapMode).toBe('tianditu-vector');
  localStorage.removeItem('gim-line-basemap-mode');
  resetRuntimeBasemapMode();
  expect(runtimeBasemapMode).toBe('osm-online');
});
