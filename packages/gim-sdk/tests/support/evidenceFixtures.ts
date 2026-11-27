import type {ObjectEvidence} from '../../src/semantic/types.js';
/** Explicit declarations for projection/selection tests. No recognition heuristics. */
const declarations:Record<string,Partial<ObjectEvidence>>={
  '主变压器':{typeCategory:'E01'},'变压器':{typeCategory:'E-T'},
  '测控柜':{typeCategory:'E16.control_cabinet'},'断路器':{typeCategory:'E06'},
  '墙':{typeCategory:'C-A1'},'板':{typeCategory:'C-A5'},'梁':{typeCategory:'C-A4'},'柱':{typeCategory:'C-A3'},
  '设备支架':{typeCategory:'C-B1'},'楼板':{typeCategory:'C-A5'},'支架':{typeCategory:'C-B1'},'主变基础':{typeCategory:'C-B2'},'基础':{typeCategory:'C-B4'},
  '散热器':{typeCategory:'part',componentTypeCandidates:[{value:'radiator',confidence:'confirmed',evidenceId:'fixture:type:radiator'}]},
  '金具球':{objectRoles:[{value:'part',evidenceId:'fixture:role:part'}]},
};
export function declaredObject(sourceId:string,name:string,extra:Partial<ObjectEvidence>={}):ObjectEvidence {
  return {sourceId,name,traits:{},designations:[],identityCodes:[],identityNames:[],phases:[],...declarations[name],...extra};
}
