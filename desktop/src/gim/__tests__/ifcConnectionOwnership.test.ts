import {expect,it} from 'vitest';
import type {CbmNode,IfcEntry} from '../types.js';
import {IfcConnectionOwnershipIndex,ifcConnectionOwnershipIndex} from '../ifcConnectionOwnership.js';
const node=(path:string, extra:Partial<CbmNode>={}):CbmNode=>({path,name:path,entityName:'F4System',children:[],famPath:'',devPath:'',ifcFile:'',ifcGuid:'',classifyName:'',transformMatrix:'',systemNames:[],devSymbolName:'',devType:'',devExpanded:false,...extra});
const entries=[{path:'CBM/source.ifc',modelId:'source',name:'source.ifc'},{path:'DEV/other.ifc',modelId:'other',name:'other.ifc'}] as IfcEntry[];
it('keeps explicit semantic ownership separate from physical DEV containment and electrical connection claims',()=>{
 const child=node('child',{ifcFile:'SOURCE.IFC',ifcGuid:'CaseSensitiveGUID'}),parent=node('parent',{devPath:'DEV/device.dev',children:[child]});
 const evidence=new IfcConnectionOwnershipIndex(parent,entries).get('source','CaseSensitiveGUID');
 expect(evidence.status).toBe('confirmed');expect(evidence.semanticNodes).toEqual([child]);expect(evidence.deviceNodes).toEqual([parent]);
 const unparented=new IfcConnectionOwnershipIndex(child,entries).get('source','CaseSensitiveGUID');
 expect(unparented.status).toBe('confirmed');expect(unparented.deviceNodes).toEqual([]);
});
it('never guesses by bare GUID, case folding, duplicate basename, name or proximity',()=>{
 const a=node('a',{ifcFile:'source.ifc',ifcGuid:'GUID'}),index=new IfcConnectionOwnershipIndex(a,entries);
 expect(index.get('other','GUID').status).toBe('unresolved');expect(index.get('source','guid').status).toBe('unresolved');
 const duplicate=[...entries,{path:'MOD/source.ifc',modelId:'duplicate',name:'source.ifc'}] as IfcEntry[];
 expect(new IfcConnectionOwnershipIndex(a,duplicate).get('source','GUID').status).toBe('unresolved');
});
it('preserves multiple source candidates and caches only within the same tree and entry projection',()=>{
 const a=node('a',{ifcFile:'source.ifc',ifcGuid:'GUID'}),b=node('b',{ifcFile:'CBM/source.ifc',ifcGuid:'GUID'}),root=node('root',{children:[a,b]});
 const index=ifcConnectionOwnershipIndex(root,entries);
 expect(index.get('source','GUID').status).toBe('ambiguous');expect(index.get('source','GUID').semanticNodes).toEqual([a,b]);
 expect(ifcConnectionOwnershipIndex(root,entries)).toBe(index);expect(ifcConnectionOwnershipIndex(node('new'),entries)).not.toBe(index);
});
