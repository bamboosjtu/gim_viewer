import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessCorrectness} from './correctness.mjs';

const sourceSha256='a'.repeat(64);
const complete=()=>({projectType:'substation',sourceSha256,semanticDigest:'b'.repeat(64),placementDigest:'c'.repeat(64),
  checks:[{name:'source-identity',passed:true},{name:'no-failed-geometry-occurrences',passed:true}],
  progress:{workload:{ifcSources:2}},engineeringCoverage:{complete:true}});
const incomplete=()=>({...complete(),engineeringCoverage:{complete:false,incompleteReasons:['source-reference-unresolved'],
  referenceStatuses:{resolved:9,missing:2},graphDiagnostics:0,sourceCount:11,entityCount:8,pendingEntityCount:3}});
const sourceFailure=()=>({...complete(),checks:[{name:'source-identity',passed:true},
  {name:'no-failed-geometry-occurrences',passed:false}],geometryDefects:{failedSourceCount:2,
    failedSourceSetDigest:'d'.repeat(64),failedOccurrences:4,failedVisibleRoots:0,
    failedReasons:{'source-invalid':2},sourceEvidenceComplete:true}});

test('complete model passes and a source-backed incomplete graph is partial without a sample registry',()=>{
  assert.equal(assessCorrectness(complete()).correctness,'passed');
  const partial=assessCorrectness(incomplete());
  assert.equal(partial.correctness,'partial');
  assert.equal(partial.defectAssessment.kind,'coverage');
  assert.equal(partial.defectAssessment.status,'evidence-backed');
  assert.match(partial.defectAssessment.coverageDigest,/^[a-f0-9]{64}$/);
  const changed=incomplete();changed.engineeringCoverage.referenceStatuses.missing=3;
  assert.notEqual(assessCorrectness(changed).defectAssessment.coverageDigest,partial.defectAssessment.coverageDigest);
  const geometryOnly=incomplete();geometryOnly.progress.workload.partial=999;
  assert.equal(assessCorrectness(geometryOnly).defectAssessment.coverageDigest,partial.defectAssessment.coverageDigest);
});

test('only source-invalid geometry with source evidence is partial; parser and other invariant failures fail',()=>{
  assert.equal(assessCorrectness(sourceFailure()).correctness,'partial');
  const noEvidence=sourceFailure();noEvidence.geometryDefects.sourceEvidenceComplete=false;
  assert.equal(assessCorrectness(noEvidence).correctness,'unverified');
  const parseFailure=sourceFailure();parseFailure.geometryDefects.failedReasons={'parse-failed':2};
  assert.equal(assessCorrectness(parseFailure).correctness,'failed');
  const missing=sourceFailure();missing.geometryDefects.failedReasons={'missing-dependency':2};
  assert.equal(assessCorrectness(missing).correctness,'partial');
  const other=sourceFailure();other.checks.push({name:'session-stable',passed:false});
  assert.equal(assessCorrectness(other).correctness,'failed');
  const ifc=incomplete();ifc.engineeringCoverage.incompleteReasons=['ifc-parse-failed'];
  assert.equal(assessCorrectness(ifc).correctness,'failed');
});

test('independent source and geometry limitations retain both signatures',()=>{
  const evidence=sourceFailure();evidence.engineeringCoverage=incomplete().engineeringCoverage;
  const result=assessCorrectness(evidence);
  assert.equal(result.correctness,'partial');assert.equal(result.defectAssessment.kind,'combined');
  assert.match(result.defectAssessment.coverageDigest,/^[a-f0-9]{64}$/);
  assert.match(result.defectAssessment.sourceSetDigest,/^[a-f0-9]{64}$/);
  assert.equal(assessCorrectness({...complete(),checks:[]}).correctness,'unverified');
});

test('loaded and cached IFC can coexist with an incomplete source manifest and isolated geometry failure',()=>{
  const evidence=sourceFailure();
  evidence.progress.workload.loadedIfcSources=2;
  evidence.cache={cachedIfc:2,ifcEntries:2,missingIfc:0,parserMatches:true,semanticValid:true};
  evidence.engineeringCoverage={complete:false,incompleteReasons:['ifc-manifest-incomplete'],
    referenceStatuses:{resolved:12},graphDiagnostics:0,sourceCount:14,entityCount:9,pendingEntityCount:3,
    ifcManifest:{archiveSources:2,spatialModels:1,missing:1,extra:0,duplicate:0,parseErrors:0}};
  const assessed=assessCorrectness(evidence);
  assert.equal(assessed.correctness,'partial');
  assert.equal(assessed.defectAssessment.kind,'combined');
  evidence.cache.cachedIfc=1;
  assert.equal(assessCorrectness(evidence).correctness,'failed');
});
