import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dependencyCycles, packageBoundaryError} from './package-boundaries.mjs';
test('package imports need declared dependencies and cannot bypass exports through source paths',()=>{
  const dependencies={
    '@gim/gim-primitives':'file:../packages/gim-primitives',
    '@gim/contracts-native':'file:../packages/contracts-native',
  };
  assert.equal(packageBoundaryError('@gim/gim-primitives/kvParser.js',dependencies),null);
  assert.equal(packageBoundaryError('@gim/contracts-native',dependencies),null);
  for(const path of ['../../../packages/gim-primitives/src/kvParser.js','@gim/powerline-core','@gim/measurement-core/source','@gim/gim-primitives/src/kvParser.js','@gim/contracts-native/../private'])assert.ok(packageBoundaryError(path,dependencies),path);
});

test('finds transitive eager cycles but accepts dependencies shared by multiple consumers', () => {
  const graph = new Map([['entry', ['a', 'b']], ['a', ['b']], ['b', []]]);
  assert.deepEqual(dependencyCycles(graph), []);
  graph.get('b').push('a');
  assert.deepEqual(dependencyCycles(graph), [['a', 'b', 'a']]);
});
