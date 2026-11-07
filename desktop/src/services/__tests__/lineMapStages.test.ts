// @vitest-environment node
import { expect, it } from 'vitest';
import { lineMapStageBatchSize, runLineMapStageSlice } from '../lineMapStages.js';

it('bounds each stage by items and elapsed time while advancing past completed items', () => {
  expect(['towers','wires','crosses','labels'].map(stage => lineMapStageBatchSize(stage as 'towers'|'wires'|'crosses'|'labels'))).toEqual([256,64,128,256]);
  const visited: number[] = []; let tick = 0;
  const next = runLineMapStageSlice(3,100,64,index => visited.push(index),() => tick++ === 0 ? 0 : 10);
  expect(next).toBe(11);
  expect(visited).toEqual([3,4,5,6,7,8,9,10]);
  expect(runLineMapStageSlice(11,12,64,index => visited.push(index),() => 0)).toBe(12);
  expect(visited[visited.length-1]).toBe(11);
});
