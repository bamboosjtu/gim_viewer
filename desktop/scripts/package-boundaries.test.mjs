import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dependencyCycles, packageBoundaryError} from './package-boundaries.mjs';
test('package imports need declared dependencies and cannot bypass exports through source paths',()=>{
  const dependencies={'@gim/powerline-core':'file:../packages/powerline-core'};
  assert.equal(packageBoundaryError('@gim/powerline-core/kvParser.js',dependencies),null);
  for(const path of ['../../../packages/powerline-core/src/kvParser.js','@gim/measurement-core/source','@gim/powerline-core/src/kvParser.js','@gim/powerline-core/../private'])assert.ok(packageBoundaryError(path,dependencies),path);
});

test('finds transitive eager cycles but accepts dependencies shared by multiple consumers', () => {
  const graph = new Map([['entry', ['a', 'b']], ['a', ['b']], ['b', []]]);
  assert.deepEqual(dependencyCycles(graph), []);
  graph.get('b').push('a');
  assert.deepEqual(dependencyCycles(graph), [['a', 'b', 'a']]);
});
