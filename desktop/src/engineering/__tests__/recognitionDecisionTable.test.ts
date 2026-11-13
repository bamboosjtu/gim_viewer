import {expect,it} from 'vitest';
import {extractEngineeringSourceGraph} from '../../gim/engineering/sourceGraph.js';
import {buildEngineeringSources} from '../../gim/engineering/buildSources.js';

// The same source declaration is exercised as an outward root, a real DEV
// child, and an attribute-only PARTINDEX reference. No geometry is consulted.
const decisions=[
  {rule:'R01',lines:'TYPE=OilImmersedTransformer',category:'E-T',status:'candidate',equipment:'oil_immersed_transformer',component:undefined,purpose:undefined,part:false,independent:false},
  {rule:'R02',lines:'TYPE=OilImmersedTransformer\nPURPOSE=站用',category:'E03',status:'confirmed',equipment:'oil_immersed_transformer',component:undefined,purpose:'station_service_transformer',part:false,independent:false},
  {rule:'R03',lines:'TYPE=GIS',category:'E05',status:'confirmed',equipment:'gis',component:undefined,purpose:undefined,part:false,independent:false},
  {rule:'R04',lines:'TYPE=ACPorcelainCircuitBreaker',category:'E06',status:'confirmed',equipment:'ac_porcelain_circuit_breaker',component:undefined,purpose:undefined,part:false,independent:false},
  {rule:'R05',lines:'TYPE=Body',category:'',status:'unresolved',equipment:undefined,component:'body',purpose:undefined,part:true,independent:false},
  {rule:'R06',lines:'TYPE=ControlCabinet\nOBJECTROLE=内部部件',category:'E16.control_cabinet',status:'confirmed',equipment:undefined,component:'control_cabinet',purpose:undefined,part:true,independent:false},
  {rule:'R07',lines:'TYPE=ControlCabinet\nOBJECTROLE=独立',category:'E16.control_cabinet',status:'confirmed',equipment:undefined,component:'control_cabinet',purpose:undefined,part:false,independent:true},
  {rule:'R08',lines:'TYPE=GIS\nEQUIPMENTTYPE=HGIS',category:'U-OBJECT',status:'unresolved',equipment:undefined,component:undefined,purpose:undefined,part:false,independent:false},
  {rule:'R09',lines:'SYSCLASSIFYNAME=GIS',category:'E05',status:'confirmed',equipment:'gis',component:undefined,purpose:undefined,part:false,independent:false},
  {rule:'R10',lines:'TYPE=Radiator',category:'',status:'unresolved',equipment:undefined,component:'radiator',purpose:undefined,part:true,independent:false},
  {rule:'R11',lines:'TYPE=OTHERS\nSYMBOLNAME=断路器',category:'E06',status:'candidate',equipment:undefined,component:undefined,purpose:undefined,part:false,independent:false},
] as const;
it.each(decisions)('$rule preserves independent classification, type, purpose, role and boundary across three source contexts',async decision=>{
  for(const context of ['root','assembly','attributes'] as const){
    const raw:Record<string,string>={'project.cbm':context==='root'?'OBJECTMODELPOINTER=target.dev':'OBJECTMODELPOINTER=host.dev\nSUBDEVICE0=attributes.cbm',
      'host.dev':'TYPE=GIS'+(context==='assembly'?'\nSUBDEVICE0=target.dev':''),'target.dev':decision.lines,
      'attributes.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=target.dev\nBASEFAMILY=attributes.fam','attributes.fam':'[设计]\n额定电压=RATEDVOLTAGE=1 kV'};
    const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>raw[p]}),built=buildEngineeringSources('scope',graph,[],[]);
    const target=graph.records.find(r=>r.source==='target.dev');
    if(context==='attributes'){
      expect(target).toBeUndefined();expect(graph.aliases[0]).toMatchObject({status:'unresolved',candidates:[]});
      expect(built.snapshot.entities).toHaveLength(1);continue;
    }
    const member=built.snapshot.memberships.find(m=>m.sourceId===target!.id)!,result=member.interpretation;
    expect(result.category,decision.rule).toBe(decision.category);expect(result.categoryStatus).toBe(decision.status);
    expect(result.equipmentType?.id).toBe(decision.equipment);expect(result.componentType?.id).toBe(decision.component);
    expect(result.purpose?.id).toBe(decision.purpose);expect(result.purpose?.status).toBe(decision.purpose?'confirmed':'unresolved');
    if(decision.equipment)expect(result.equipmentType?.evidence.length).toBeGreaterThan(0);
    if(decision.component)expect(result.componentType?.evidence.length).toBeGreaterThan(0);
    if(decision.part)expect(result.objectRole?.id).toBe('part');
    if(decision.independent)expect(result.objectRole).toMatchObject({id:'object',status:'confirmed'});
    const owner=built.snapshot.entities.find(e=>e.id===member.ownerId);
    if(context==='root')expect(owner?.boundaryStatus??'unresolved').toBe(decision.independent?'confirmed':decision.part||decision.rule==='R08'?'unresolved':'candidate');
    if(context==='assembly'&&decision.part)expect(member.ownerId).toBe(built.snapshot.memberships.find(m=>m.sourceId===graph.records[0].id)?.ownerId);
  }
});

it.each(['root','assembly','attributes'] as const)('keeps absent evidence and incompatible declarations unresolved in %s context',async context=>{
  for(const lines of ['TYPE=OTHERS','TYPE=GIS\nEQUIPMENTTYPE=HGIS','TYPE=ControlCabinet\nOBJECTROLE=独立\nCOMPONENTROLE=内部部件']){
    const raw:Record<string,string>={'project.cbm':context==='root'?'OBJECTMODELPOINTER=target.dev':'OBJECTMODELPOINTER=host.dev\nSUBDEVICE0=a.cbm',
      'host.dev':'TYPE=GIS'+(context==='assembly'?'\nSUBDEVICE0=target.dev':''),'target.dev':lines,'a.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=target.dev'};
    const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>raw[p]}),built=buildEngineeringSources('scope',graph,[],[]);
    if(context==='attributes'){expect(graph.records.some(r=>r.source==='target.dev')).toBe(false);continue;}
    const target=graph.records.find(r=>r.source==='target.dev')!,result=built.snapshot.memberships.find(m=>m.sourceId===target.id)!.interpretation;
    expect(result.categoryStatus).toBe('unresolved');expect(result.category).toBe('U-OBJECT');
    if(lines.includes('HGIS'))expect(result.equipmentType).toMatchObject({status:'unresolved'});
    expect(built.snapshot.entities.find(e=>e.id===built.snapshot.memberships.find(m=>m.sourceId===target.id)?.ownerId)?.boundaryStatus).not.toBe('confirmed');
  }
});
