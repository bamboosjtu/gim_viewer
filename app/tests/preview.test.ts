import { it, expect } from 'vitest';
import { buildTowerPreview } from '@gim/powerline-core';

it('connects a trailing R block to unique point IDs across Body sections, including the tower head', () => {
  const preview = buildTowerPreview('\uFEFFHNum,2\nH,42000,Body1,Leg1\nBody1\nP,1,-11140,0,51000\nP,2,9140,0,58800\nBody2\nP,3,0,0,0\nP,4,3000,0,32000\nR,1,2,L63x5,Q355\nR,3,4,L110x8,Q355', 'Mod/tower.mod');
  expect(preview.segments).toEqual([[-11140,51000,9140,58800],[0,0,3000,32000]]);
  expect(preview.bounds).toEqual([-11140,0,9140,58800]);
  expect(preview.pointCount).toBe(4);
  expect(preview.rodCount).toBe(2);
});

it('keeps reused point IDs Body-local and does not borrow missing endpoints from another Body', () => {
  const preview = buildTowerPreview('HNum,2\nBody1\nP,1,-10,0,10\nP,2,10,0,20\nP,3,30,0,30\nR,1,2,L63x5,Q355\nBody2\nP,1,-100,0,100\nP,2,100,0,200\nR,1,2,L63x5,Q355\nR,2,3,L63x5,Q355', 'Mod/reused.mod');
  expect(preview.segments).toEqual([[-10,10,10,20],[-100,100,100,200]]);
  expect(preview.rodCount).toBe(3);
});
