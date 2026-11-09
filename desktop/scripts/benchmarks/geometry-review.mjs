import {digest,reviewerValid,sha} from './evidence.mjs';

const groupIdentity=run=>({sourceSha256:run.conditions?.sourceSha256,sampleId:run.conditions?.sampleId,
  scenario:run.conditions?.scenario,cacheState:run.conditions?.cacheState,profileDigest:run.conditions?.profileDigest,
  workloadDigest:run.conditions?.workloadDigest,routeDigest:run.conditions?.routeDigest,viewportDigest:run.conditions?.viewportDigest});
const content=run=>({buildFingerprint:run.buildFingerprint,...run.contentEvidence});
export const geometryTransition=(baseline,candidate)=>({identity:groupIdentity(baseline),baseline:content(baseline),candidate:content(candidate)});

function changedGroups(baseline,candidate){
  const groups=rows=>{const result=new Map();for(const run of rows??[]){const key=digest(groupIdentity(run));
    if(!result.has(key))result.set(key,[]);result.get(key).push(run);}return result;};
  const before=groups(baseline.runs),after=groups(candidate.runs),changes=[];
  if(before.size!==after.size)throw Error('Geometry verification requires matching scenarios');
  for(const [key,left] of before){
    const right=after.get(key);if(!right)throw Error('Geometry verification scenario is missing');
    if(left.length!==right.length||new Set(left.map(run=>digest(content(run)))).size!==1||
      new Set(right.map(run=>digest(content(run)))).size!==1)throw Error('Geometry content varies within repetitions');
    const a=left[0],b=right[0],p=a.contentEvidence,q=b.contentEvidence;
    if(p?.digest===q?.digest)continue;
    if(!sha(a.buildFingerprint)||!sha(b.buildFingerprint)||p?.complete!==true||q?.complete!==true||
      p.availability!=='available'||q.availability!=='available'||!sha(p.digest)||!sha(q.digest)||
      p.placementFingerprint!==q.placementFingerprint||!sha(p.placementFingerprint)||
      p.coveredOccurrences!==q.coveredOccurrences||p.expectedShownOccurrences!==q.expectedShownOccurrences||
      p.coveredOccurrences!==p.expectedShownOccurrences||q.coveredOccurrences!==q.expectedShownOccurrences||
      p.missingArtifactSha!==0||q.missingArtifactSha!==0||p.duplicateArtifactIds!==0||q.duplicateArtifactIds!==0)
      throw Error('Geometry verification cannot waive missing content, coverage or placement changes');
    changes.push(geometryTransition(a,b));
  }
  if(!changes.length)throw Error('No changed DEV content to approve');
  return changes;
}

/** Import a separate geometry verifier's result; timing and bounds alone are never evidence. */
export function createGeometryReview(baseline,candidate,verification,approver){
  if(!reviewerValid(approver)||!reviewerValid(verification?.verifier)||
    verification.verifier.trim().toLowerCase()===approver.trim().toLowerCase())
    throw Error('Geometry approval requires a distinct verifier and approver');
  if(verification.version!=='gim-geometry-equivalence-v1'||verification.outcome!=='PASS'||
    verification.baselineDigest!==digest(baseline)||verification.candidateDigest!==digest(candidate)||
    verification.method!=='independent-mesh-equivalence-v1')throw Error('Geometry verification is missing or bound to another comparison');
  const changes=changedGroups(baseline,candidate),checks=verification.checks??[];
  if(checks.length!==changes.length||new Set(checks.map(row=>row.transitionDigest)).size!==checks.length||
    changes.some(change=>!checks.some(row=>row.transitionDigest===digest(change)&&
      row.coveredOccurrences===change.baseline.coveredOccurrences&&sha(row.evidenceSha256)&&
      ['positions','topology','normals','materials','transforms','sourceBindings'].every(key=>row[key]===true))))
    throw Error('Independent geometry checks must cover every changed occurrence and attribute');
  const review={version:'gim-geometry-review-v1',baselineDigest:digest(baseline),candidateDigest:digest(candidate),
    approver:approver.trim(),approvedAt:new Date().toISOString(),verification,changes};
  return {...review,reviewDigest:digest(review)};
}
export function geometryReviewIssue(review,baseline,candidate){
  if(!review)return 'geometry-review-required';
  const {reviewDigest,...body}=review;
  if(body.version!=='gim-geometry-review-v1'||reviewDigest!==digest(body))return 'geometry-review-digest-mismatch';
  try{
    const expected=createGeometryReview(baseline,candidate,body.verification,body.approver);
    if(body.baselineDigest!==expected.baselineDigest||body.candidateDigest!==expected.candidateDigest||
      digest(body.changes)!==digest(expected.changes))return 'geometry-review-comparison-mismatch';
  }catch(error){return `geometry-review-invalid:${error.message}`;}
  return null;
}
export function geometryChangeAllowed(baseline,candidate,changes=[]){
  const transition=digest(geometryTransition(baseline,candidate));
  return changes.some(change=>digest(change)===transition);
}
