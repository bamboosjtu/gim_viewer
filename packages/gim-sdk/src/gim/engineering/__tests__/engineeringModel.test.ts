import {it,expect} from 'vitest';
import type {IfcSpatialObject} from '../../ifcSpatialTypes.js';
import {extractEngineeringSourceGraph} from '../sourceGraph.js';
import {collectEngineeringSourceModel} from '../engineeringModel.js';

const object=(sourcePath:string,globalId='guid',expressId=1):IfcSpatialObject=>({
  sourcePath,globalId,expressId,modelId:sourcePath,key:`${sourcePath}:${expressId}`,ifcType:'IFCWALL',name:'wall',geometryStatus:'unrepresented',
  parentObjectKey:null,childObjectKeys:[],relationshipCount:0,hostObjectKey:null,spatialKey:null,spatialKeys:[],spatialContainment:null,
});
async function graph(text:string){
  const entries:Record<string,string>={'project.cbm':text,'a.ifc':'','b.ifc':''};
  return extractEngineeringSourceGraph({paths:Object.keys(entries),readText:async path=>entries[path]});
}
it('scopes identical GUIDs to the explicitly declared file, including repeated identical file facts',async()=>{
  const source=await graph('IFCFILE=a.ifc\nIFCFILE=a.ifc\nIFCGUID=guid');
  const model=collectEngineeringSourceModel(source,[object('a.ifc'),object('b.ifc')]);
  expect(model.ifcMatches[0]).toMatchObject({status:'confirmed',ifcSourceIds:['ifc:["a.ifc",1]']});
  expect(source.references.filter(row=>row.field==='IFCFILE')).toHaveLength(1);
});
it('preserves conflicting IFCFILE references without binding the last candidate',async()=>{
  const source=await graph('IFCFILE=a.ifc\nIFCFILE=b.ifc\nIFCGUID=guid');
  const model=collectEngineeringSourceModel(source,[object('a.ifc'),object('b.ifc')]);
  expect(model.ifcMatches[0]).toMatchObject({status:'ambiguous',ifcSourceIds:[]});
  expect(source.references.find(row=>row.field==='IFCFILE')).toMatchObject({status:'ambiguous',values:['a.ifc','b.ifc'],lines:[1,2]});
});
it('preserves conflicting IFCGUID facts without binding the first value',async()=>{
  const source=await graph('IFCFILE=a.ifc\nIFCGUID=first\nIFCGUID=second');
  const model=collectEngineeringSourceModel(source,[object('a.ifc','first'),object('a.ifc','second',2)]);
  expect(model.ifcMatches[0]).toMatchObject({status:'ambiguous',rawGuid:'',rawGuidValues:['first','second'],ifcSourceIds:[]});
  expect(source.diagnostics).toContainEqual(expect.objectContaining({kind:'ambiguous-field',field:'IFCGUID',lines:[2,3]}));
});
