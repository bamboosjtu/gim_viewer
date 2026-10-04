import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { collectDeviceGroups } from '../nodeInteractionService.js';

describe('device occurrence selection', () => {
  it('isolates two F4 placements of a shared DEV template', () => {
    const state = new AppState();
    for (const path of ['CBM/A.cbm', 'CBM/B.cbm']) {
      const group = new THREE.Group();
      group.userData.devPath = 'DEV/shared.dev';
      group.userData.rootOccurrence = path;
      group.userData.instanceKey = `dev:DEV/shared.dev#${path}`;
      state.loadedXmlModGroups.set(group.userData.instanceKey, group);
    }
    expect(collectDeviceGroups(state, 'shared.dev', { rootOccurrence: 'CBM/A.cbm' })).toHaveLength(1);
  });
});
