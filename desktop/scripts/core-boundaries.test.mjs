import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coreBoundaryErrors} from './core-boundaries.mjs';

test('projections and fusion reject reclassification through imports, exports and dynamic imports',()=>{
  for(const source of ["import {classify} from '../../engineering/classify.js'", "export * from '../../engineering/semantic.js'", "const module=import('../../engineering/recognizeSource.js')"])
    assert.equal(coreBoundaryErrors(source,'gim/engineering/projection.ts').length,1);
  assert.equal(coreBoundaryErrors("import('./normalize.js')",'engineering/representations.ts').length,1);
});
test('geometry keeps neutral type contracts but cannot consume semantic runtime values',()=>{
  const path='gim/engineering/geometry.ts';
  assert.equal(coreBoundaryErrors("import type {Address} from '../../engineering/representations.js'",path).length,0);
  assert.equal(coreBoundaryErrors("export * from '../../engineering/fusion.js'",path).length,1);
  assert.equal(coreBoundaryErrors("import('./physicalOccurrences.js')",path).length,0);
});
test('standalone addresses reject semantic and host dependencies',()=>{
  for(const target of ['../engineering/types.js','../app/state.js','three'])
    assert.equal(coreBoundaryErrors(`import('${target}')`,'shared/representationAddresses.ts').length,1);
});
test('public SDK exports cannot bypass capability or UI/Viewer boundaries',()=>{
  for(const source of ["import('@gim/gim-sdk/semantic')","export * from '@gim/gim-sdk/semantic'"])
    assert.ok(coreBoundaryErrors(source,'gim/engineering/geometry.ts').length);
  assert.ok(coreBoundaryErrors("import('@gim/gim-sdk/source-adapter')",'gim/engineering/projection.ts').length);
  assert.ok(coreBoundaryErrors("export * from '@gim/gim-sdk/source'",'engineering/semantic.ts').length);
  for(const path of ['ui/inspector.ts','viewer/highlight.ts']){
    assert.ok(coreBoundaryErrors("import('@gim/gim-sdk/source')",path).length);
    assert.equal(coreBoundaryErrors("import type {SourceRecord} from '@gim/gim-sdk/source'",path).length,0);
  }
  assert.equal(coreBoundaryErrors("import {type SourceRecord} from '@gim/gim-sdk/source'",'ui/inspector.ts').length,0);
});
test('projection selectors do not grant access to extraction through the same module',()=>{
  assert.ok(coreBoundaryErrors("import {extractEngineeringSourceGraph} from './sourceGraph.js'",'gim/engineering/navigation.ts').length);
  assert.equal(coreBoundaryErrors("import {engineeringSourceRecords} from './sourceGraph.js'",'gim/engineering/navigation.ts').length,0);
});

test('source and geometry helper modules reject semantic runtime imports',()=>{
  assert.ok(coreBoundaryErrors("import '../../engineering/classify.js'",'gim/engineering/sourceGraph.ts').length);
  assert.ok(coreBoundaryErrors("import '@gim/gim-sdk/semantic'",'gim/geometry/affineMatrix.ts').length);
});

test('domain projection facades forward only their own declared symbols',()=>{
  const path='engineering/composition.ts';
  assert.deepEqual(coreBoundaryErrors("export {projectEngineeringComposition} from '@gim/gim-sdk/projection'",path),[]);
  for(const clause of ['export *','export {projectEngineeringNavigation}','import {projectEngineeringComposition}'])
    assert.ok(coreBoundaryErrors(clause+" from '@gim/gim-sdk/projection'",path).length);
});
