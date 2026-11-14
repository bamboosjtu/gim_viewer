import {expect,it} from 'vitest';
import type {EngineeringSnapshot} from '../../engineering/types.js';
import {engineeringSemanticEvidence} from '../engineeringEvidence.js';

function snapshot():EngineeringSnapshot{
  return {evidenceBinding:{scope:'scope',sourceRevision:0},scope:'scope',rulesVersion:'rules',entities:[],pending:[{id:'pending-1',reason:'owner-unknown',sourceIds:['source-1']}],
    memberships:[{sourceId:'source-1',ownerId:'pending-1',disposition:'pending_whole_member',
      interpretation:{category:'U-OBJECT',meaning:'neutral_set',basis:'source',conflict:'',independent:false,
        assemblyCategory:'U-OBJECT',assemblySignature:''}}],
    relationships:[],aliases:[],diagnostics:[]};
}
it('includes pending identity, source, category, disposition and reason in semantic input',()=>{
  const original=snapshot(),baseline=engineeringSemanticEvidence(original);
  expect(baseline.checks.every(check=>check.passed)).toBe(true);
  expect(baseline.pendingCount).toBe(1);
  const changed=snapshot();changed.pending[0].reason='different-reason';
  expect(engineeringSemanticEvidence(changed).semanticRows).not.toEqual(baseline.semanticRows);
  changed.pending[0].reason=original.pending[0].reason;
  changed.memberships[0].interpretation.category='E06';
  expect(engineeringSemanticEvidence(changed).pendingRows).not.toEqual(baseline.pendingRows);
});
it('rejects duplicate, orphan and inconsistent pending ownership',()=>{
  const duplicate=snapshot();duplicate.pending.push({...duplicate.pending[0]});
  expect(engineeringSemanticEvidence(duplicate).checks).toContainEqual({name:'pending-id-unique',passed:false});
  const orphan=snapshot();orphan.pending[0].sourceIds=['missing-source'];
  expect(engineeringSemanticEvidence(orphan).checks).toContainEqual({name:'pending-source-valid',passed:false});
  const empty=snapshot();empty.pending[0].sourceIds=[];
  expect(engineeringSemanticEvidence(empty).checks).toContainEqual({name:'pending-source-valid',passed:false});
  const inconsistent=snapshot();inconsistent.memberships[0].disposition='source_only';
  expect(engineeringSemanticEvidence(inconsistent).checks).toContainEqual({name:'pending-membership-consistent',passed:false});
});
