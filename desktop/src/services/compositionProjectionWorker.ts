import { projectSpatialComposition, type CompositionBounds } from './projections/compositionSpatial.js';
import { finalizeEngineeringComposition, projectEngineeringComposition, type CompositionDeclaration, type EngineeringComposition } from '../engineering/composition.js';
import type { EngineeringSnapshot } from '../engineering/types.js';
import type { SourceCompositionEvidence } from '../gim/engineering/compositionContexts.js';
export interface ProjectionInput {snapshot:EngineeringSnapshot;facts:SourceCompositionEvidence[];declarations:CompositionDeclaration[];bounds:CompositionBounds[]}
export type ProjectionOutput = {composition:EngineeringComposition;contexts:Array<[string,string]>} | {error:string};
self.onmessage=(event:MessageEvent<ProjectionInput>)=>{try{
  const {snapshot,facts,declarations,bounds}=event.data;
  const assignments=projectSpatialComposition(snapshot,facts,bounds,undefined,declarations);
  self.postMessage({composition:finalizeEngineeringComposition(projectEngineeringComposition(snapshot,assignments,'工程组成',declarations)),contexts:assignments.map(a=>[a.entityId,a.paths.map(p=>p.map(g=>g.title).join(' / ')).join('；')])});
}catch(error){self.postMessage({error:String(error)});}};
