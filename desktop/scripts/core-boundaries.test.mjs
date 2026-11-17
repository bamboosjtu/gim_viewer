import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coreBoundaryErrors} from './core-boundaries.mjs';

test('projections and fusion reject reclassification through imports, exports and dynamic imports',()=>{
  for(const source of ["import {classify} from '../../engineering/classify.js'", "export * from '../../engineering/semantic.js'", "const module=import('./sourceEvidence.js')"])
    assert.equal(coreBoundaryErrors(source,'gim/engineering/projection.ts').length,1);
  assert.equal(coreBoundaryErrors("import('./normalize.js')",'engineering/representations.ts').length,1);
});
test('geometry keeps neutral type contracts but cannot consume semantic runtime values',()=>{
  const path='gim/engineering/geometry.ts';
  assert.equal(coreBoundaryErrors("import type {Address} from '../../engineering/representations.js'",path).length,0);
  assert.equal(coreBoundaryErrors("export * from '../../engineering/fusion.js'",path).length,1);
  assert.equal(coreBoundaryErrors("import('./physicalOccurrences.js')",path).length,0);
});
