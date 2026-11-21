import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coreBoundaryErrors} from './core-boundaries.mjs';

test('projections and fusion reject reclassification through imports, exports and dynamic imports',()=>{
  for(const source of ["import {classify} from '../semantic/classify.js'", "export * from '../semantic/semantic.js'", "const module=import('../adapters/recognizeSource.js')"])
    assert.equal(coreBoundaryErrors(source,'projection/projection.ts').length,1);
  assert.equal(coreBoundaryErrors("import('../semantic/normalize.js')",'engineering/representations.ts').length,1);
});
test('geometry keeps neutral type contracts but cannot consume semantic runtime values',()=>{
  const path='geometry/geometry.ts';
  assert.equal(coreBoundaryErrors("import type {Address} from '../engineering/representations.js'",path).length,0);
  assert.equal(coreBoundaryErrors("export * from '../engineering/fusion.js'",path).length,1);
  assert.equal(coreBoundaryErrors("import('./physicalOccurrences.js')",path).length,0);
});
test('standalone addresses reject semantic and host dependencies',()=>{
  for(const target of ['../semantic/types.js','../app/state.js','three'])
    assert.equal(coreBoundaryErrors(`import('${target}')`,'geometry/representationAddresses.ts').length,1);
});
test('public SDK exports cannot bypass capability or UI/Viewer boundaries',()=>{
  for(const source of ["import('@gim/gim-sdk/semantic')","export * from '@gim/gim-sdk/semantic'"])
    assert.ok(coreBoundaryErrors(source,'geometry/geometry.ts').length);
  assert.ok(coreBoundaryErrors("import('@gim/gim-sdk/source-adapter')",'projection/projection.ts').length);
  assert.ok(coreBoundaryErrors("export * from '@gim/gim-sdk/source'",'semantic/semantic.ts').length);
  for(const path of ['ui/inspector.ts','viewer/highlight.ts']){
    assert.ok(coreBoundaryErrors("import('@gim/gim-sdk/source')",path).length);
    assert.equal(coreBoundaryErrors("import type {SourceRecord} from '@gim/gim-sdk/source'",path).length,0);
  }
  assert.equal(coreBoundaryErrors("import {type SourceRecord} from '@gim/gim-sdk/source'",'ui/inspector.ts').length,0);
});
test('projection selectors do not grant access to extraction through the same module',()=>{
  assert.ok(coreBoundaryErrors("import {extractEngineeringSourceGraph} from '../source/sourceGraph.js'",'projection/navigation.ts').length);
  assert.equal(coreBoundaryErrors("import {engineeringSourceRecords} from '../shared/sourceRecordSelectors.js'",'projection/navigation.ts').length,0);
});

test('source and geometry helper modules reject semantic runtime imports',()=>{
  assert.ok(coreBoundaryErrors("import '../semantic/classify.js'",'source/sourceGraph.ts').length);
  assert.ok(coreBoundaryErrors("import '@gim/gim-sdk/semantic'",'geometry/affineMatrix.ts').length);
});

test('domain projection facades forward only their own declared symbols',()=>{
  const path='engineering/composition.ts';
  assert.deepEqual(coreBoundaryErrors("export {projectEngineeringComposition} from '@gim/gim-sdk/projection'",path),[]);
  for(const clause of ['export *','export {projectEngineeringNavigation}','import {projectEngineeringComposition}'])
    assert.ok(coreBoundaryErrors(clause+" from '@gim/gim-sdk/projection'",path).length);
});
