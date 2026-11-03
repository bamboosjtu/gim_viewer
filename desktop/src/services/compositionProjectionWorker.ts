import { projectSpatialComposition, type CompositionBounds } from '../engineering/compositionSpatial.js';
import { projectEngineeringComposition, type CompositionDeclaration } from '../engineering/composition.js';
import type { EngineeringSnapshot } from '../engineering/types.js';
import type { CompositionContextEvidence } from '../engineering/compositionTemplate.js';
export interface ProjectionInput {snapshot:EngineeringSnapshot;facts:CompositionContextEvidence[];declarations:CompositionDeclaration[];bounds:CompositionBounds[]}
self.onmessage=(event:MessageEvent<ProjectionInput>)=>{try{
  const {snapshot,facts,declarations,bounds}=event.data;
  const assignments=projectSpatialComposition(snapshot,facts,bounds);
  self.postMessage({composition:projectEngineeringComposition(snapshot,assignments,'工程组成',declarations),contexts:assignments.map(a=>[a.entityId,a.paths.map(p=>p.map(g=>g.title).join(' / ')).join('；')])});
}catch(error){self.postMessage({error:String(error)});}};
