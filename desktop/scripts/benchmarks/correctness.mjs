import {digest} from './compare.mjs';

const sha=value=>/^[a-f0-9]{64}$/.test(value??'');
const sourceCoverageReasons=new Set(['source-graph-incomplete','source-reference-unresolved','ifc-manifest-incomplete']);
const orderedStatuses=value=>Object.entries(value??{}).sort(([a],[b])=>a.localeCompare(b));

function assessGeometry(evidence,failures){
  if(!failures.length)return null;
  if(failures.length!==1||failures[0]!=='no-failed-geometry-occurrences')
    return {correctness:'failed',defectAssessment:{status:'product-invariant-failed'}};
  const observed=evidence.geometryDefects;
  if(!observed||observed.failedVisibleRoots!==0||!observed.failedReasons||
    Object.keys(observed.failedReasons).some(reason=>!['source-invalid','missing-dependency'].includes(reason))||
    Object.values(observed.failedReasons).reduce((total,count)=>total+count,0)!==observed.failedSourceCount)
    return {correctness:'failed',defectAssessment:{status:'product-geometry-failed'}};
  if(!observed.sourceEvidenceComplete||!sha(observed.failedSourceSetDigest)||
    !Number.isSafeInteger(observed.failedSourceCount)||observed.failedSourceCount<1||
    !Number.isSafeInteger(observed.failedOccurrences)||observed.failedOccurrences<1)
    return {correctness:'unverified',defectAssessment:{status:'source-evidence-incomplete'}};
  return {correctness:'partial',defectAssessment:{kind:'source-geometry',status:'evidence-backed',
    sourceSha256:evidence.sourceSha256,sourceSetDigest:observed.failedSourceSetDigest,
    failedSourceCount:observed.failedSourceCount,failedOccurrences:observed.failedOccurrences}};
}

function assessCoverage(evidence){
  if(evidence.projectType!=='substation')return null;
  const row=evidence.engineeringCoverage;
  if(!row||typeof row.complete!=='boolean')
    return {correctness:'unverified',defectAssessment:{status:'coverage-evidence-missing'}};
  if(row.complete)return null;
  if(!Array.isArray(row.incompleteReasons)||!row.incompleteReasons.length||
    row.incompleteReasons.some(reason=>!sourceCoverageReasons.has(reason)))
    return {correctness:'failed',defectAssessment:{status:'engineering-source-failed'}};
  const statuses=orderedStatuses(row.referenceStatuses);
  const missing=Number(row.referenceStatuses?.missing??0),ambiguous=Number(row.referenceStatuses?.ambiguous??0);
  const ifcIncomplete=row.incompleteReasons.includes('ifc-manifest-incomplete');
  const manifest=row.ifcManifest;
  const manifestCounts=manifest&&[manifest.archiveSources,manifest.spatialModels,manifest.missing,
    manifest.extra,manifest.duplicate,manifest.parseErrors];
  const runtimeIfc=evidence.progress?.workload?.ifcSources;
  if(ifcIncomplete&&(!manifestCounts?.every(value=>Number.isSafeInteger(value)&&value>=0)||
    manifest.archiveSources<1||manifest.spatialModels<1||
    manifest.archiveSources-manifest.missing+manifest.extra!==manifest.spatialModels-manifest.duplicate||
    manifest.missing+manifest.extra+manifest.duplicate<1))
    return {correctness:'unverified',defectAssessment:{status:'ifc-manifest-evidence-incomplete'}};
  if(ifcIncomplete&&(manifest.parseErrors>0||runtimeIfc!==evidence.progress?.workload?.loadedIfcSources||
    runtimeIfc!==evidence.cache?.cachedIfc||runtimeIfc!==evidence.cache?.ifcEntries||
    evidence.cache?.missingIfc!==0||evidence.cache?.parserMatches!==true||evidence.cache?.semanticValid!==true))
    return {correctness:'failed',defectAssessment:{status:'ifc-runtime-incomplete'}};
  if(!sha(evidence.semanticDigest)||!sha(evidence.sourceSha256)||
    !(evidence.placementDigest===null||sha(evidence.placementDigest))||
    ![row.graphDiagnostics,row.sourceCount,row.entityCount,row.pendingEntityCount,
      evidence.progress?.workload?.ifcSources,missing,ambiguous].every(value=>Number.isSafeInteger(value)&&value>=0)||
    row.sourceCount<1||missing+ambiguous+row.graphDiagnostics+(ifcIncomplete?manifest.missing+manifest.extra+manifest.duplicate:0)<1||
    statuses.some(([status,count])=>!['resolved','missing','ambiguous'].includes(status)||!Number.isSafeInteger(count)||count<0))
    return {correctness:'unverified',defectAssessment:{status:'coverage-evidence-incomplete'}};
  const coverageDigest=digest(['engineering-coverage-v1',evidence.semanticDigest,evidence.placementDigest,
    row.sourceCount,row.entityCount,row.pendingEntityCount,evidence.progress.workload.ifcSources,
    [...row.incompleteReasons].sort(),statuses,row.graphDiagnostics,ifcIncomplete?manifest:null]);
  return {correctness:'partial',defectAssessment:{kind:'coverage',status:'evidence-backed',
    sourceSha256:evidence.sourceSha256,coverageDigest}};
}

/** Generic evidence rules: no sample SHA or hand-maintained expected list controls correctness. */
export function assessCorrectness(evidence){
  if(!evidence)return {correctness:'unverified',defectAssessment:null};
  if(!Array.isArray(evidence.checks)||!evidence.checks.length)
    return {correctness:'unverified',defectAssessment:{status:'runtime-checks-missing'}};
  const failures=evidence.checks.filter(row=>!row.passed).map(row=>row.name);
  const geometry=assessGeometry(evidence,failures),coverage=assessCoverage(evidence);
  for(const result of [geometry,coverage])if(result?.correctness==='failed')return result;
  for(const result of [geometry,coverage])if(result?.correctness==='unverified')return result;
  if(geometry&&coverage){
    const a=geometry.defectAssessment,b=coverage.defectAssessment;
    return {correctness:'partial',defectAssessment:{kind:'combined',status:'evidence-backed',
      sourceSha256:evidence.sourceSha256,sourceSetDigest:a.sourceSetDigest,failedOccurrences:a.failedOccurrences,
      coverageDigest:b.coverageDigest}};
  }
  return geometry??coverage??{correctness:'passed',defectAssessment:null};
}
