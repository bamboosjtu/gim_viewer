import {engineeringSourceRecords} from '../gim/engineering/sourceGraph.js';
import { collectEngineeringSources, normalizeEngineeringSources, type EngineeringSources } from '../gim/engineering/buildSources.js';
import { projectEngineeringNavigation } from '../gim/engineering/navigation.js';
import { collectSourceGeometryOccurrences } from '../gim/engineering/geometryOccurrences.js';
import type { EngineeringSourceGraph } from '../gim/engineering/sourceGraph.js';
import type { IfcSpatialObject, IfcSpatialNode, SpatialModelSummary } from '../gim/ifcSpatialParser.js';
import type { EngineeringSnapshot } from '../engineering/types.js';
import { ENGINEERING_RECOGNITION_VERSION as ENGINEERING_RULES_VERSION } from '../gim/engineering/sourceEvidence.js';

/** Source and physical publication survives recognition and projection failures. */
export function assembleEngineeringView(scope:string,graph:EngineeringSourceGraph,objects:readonly IfcSpatialObject[],models:readonly SpatialModelSummary[],nodes:readonly IfcSpatialNode[]=[],normalize:(scope:string,sources:EngineeringSources)=>EngineeringSnapshot=normalizeEngineeringSources){
  return assembleStoredEngineeringView(scope,collectEngineeringSources(graph,objects,models,nodes),normalize);
}
export function assembleStoredEngineeringView(scope:string,sources:EngineeringSources,normalize:(scope:string,sources:EngineeringSources)=>EngineeringSnapshot=normalizeEngineeringSources){
  const graph=sources.graph,stageErrors:Record<string,string>={};
  let snapshot:EngineeringSnapshot;
  try{snapshot=normalize(scope,sources);if(snapshot.evidenceBinding.scope!==scope||snapshot.evidenceBinding.sourceRevision!==(graph.revision??0))throw Error('Engineering evidence revision mismatch');}catch(error){
    stageErrors.recognition=String(error);
    const ids=engineeringSourceRecords(graph,sources.ifcRecords).map(r=>r.id);
    snapshot={scope,rulesVersion:ENGINEERING_RULES_VERSION,entities:[],pending:[],relationships:[],aliases:[],
      memberships:ids.map(sourceId=>({sourceId,ownerId:null,disposition:'source_only',interpretation:{category:'U-OBJECT',meaning:'source_only',basis:'recognition_unavailable',conflict:'',independent:false,classificationStatus:'unresolved',categoryStatus:'unresolved',assemblyCategory:'',assemblySignature:''}})),
      evidenceBinding:{scope,sourceRevision:graph.revision??0},diagnostics:[{kind:'recognition-failed',identity:scope,name:String(error)}],recognitionCoverage:{inputSourceIds:ids,processed:0,confirmed:0,complete:false}};
  }
  const navigation=projectEngineeringNavigation(sources,snapshot);
  Object.assign(stageErrors,navigation.projectionErrors);
  return {sources,snapshot,navigation,geometryOccurrences:collectSourceGeometryOccurrences(graph),stageErrors};
}
