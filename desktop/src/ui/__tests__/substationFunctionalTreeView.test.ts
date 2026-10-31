import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../../app/state.js';
import {compareSubstationNames} from '../../gim/substationBusiness.js';
import type { CbmNode } from '../../gim/types.js';
import { buildBusinessTree, classifyBusinessObject, compareBusinessRegions, compareBusinessUnits } from '../../gim/businessTree.js';
import { renderBusinessTree, revealBusinessTarget } from '../businessTreeView.js';
import { renderCbmTreeUI } from '../cbmTreeView.js';
import { buildSubstationSpatialIndexFromTexts } from '../../gim/ifcSpatialParser.js';
import {
  buildFunctionalDomainIndex,
  buildFunctionalSearchIndex,
  renderSubstationFunctionalTree,
  revealFunctionalSearchTarget,
} from '../substationFunctionalTreeView.js';

function node(overrides: Partial<CbmNode> = {}): CbmNode {
  return {
    path: 'CBM/project.cbm',
    name: '工程',
    entityName: 'F1System',
    children: [],
    famPath: '',
    devPath: '',
    ifcFile: '',
    ifcGuid: '',
    classifyName: '',
    transformMatrix: '',
    systemNames: [],
    devSymbolName: '',
    devType: '',
    devExpanded: false,
    ...overrides,
  };
}

it('expands a large material group through the outline collector and reveals its last member',()=>{
  const root=node({children:Array.from({length:600},(_,i)=>node({path:`fitting-${i}`,name:`设备线夹${i}`,devPath:`${i}.dev`}))});
  const p=buildBusinessTree(root),host=document.createElement('div');document.body.append(host);
  renderBusinessTree(p,host,'工程',()=>{});
  const target=p.objectBySource.get('fitting-599')!;
  expect(revealBusinessTarget(p,target,host)).toBe(target);
  expect([...host.querySelectorAll<HTMLElement>('.tree-row')].some(r=>r.dataset.nodePath===target)).toBe(true);
  expect(host.textContent).toContain('金具');expect(host.textContent).toContain('设备线夹599');
  expect(p.members.get('business:root')).toHaveLength(600);
});

it('uses source XY rather than height for separated bay materials, without forcing ties or crossing wires',()=>{
  const root=node({children:['a','b'].map((path,i)=>node({path,name:'断路器',devPath:path+'.dev',systemNames:['电气系统','110kV系统',`${i+1}出线间隔`]}))});
  const spatial=buildSubstationSpatialIndexFromTexts([{entry:{modelId:'m',path:'m.ifc',name:'m'},text:[
    "#10=IFCBUILDINGELEMENTPROXY('insulator',#99,'支柱绝缘子',$,$,$,$,$,$);",
    "#11=IFCBUILDINGELEMENTPROXY('tie',#99,'设备线夹',$,$,$,$,$,$);",
    "#12=IFCBUILDINGELEMENTPROXY('cross',#99,'导线',$,$,$,$,$,$);",
    "#13=IFCBUILDINGELEMENTPROXY('bushing',#99,'穿墙套管',$,$,$,$,$,$);",
  ].join('\n')}],root);
  const source=(guid:string)=>spatial.objects.find(o=>o.globalId===guid)!.key;
  const box=(objectKey:string,min:number[],max:number[])=>({objectKey,min:min as [number,number,number],max:max as [number,number,number],evidence:'geometry' as const});
  const p=buildBusinessTree(root,new Map(),{...spatial,shapes:[box('a',[0,0,0],[2,2,2]),box('b',[20,0,0],[22,2,2]),
    box(source('insulator'),[.5,.5,12],[1,1,14]),box(source('tie'),[10.5,.5,12],[11.5,1,13]),
    box(source('cross'),[0,.5,10],[22,1,11]),box(source('bushing'),[.5,.5,15],[1,1,16])]});
  const object=(path:string)=>p.objects.get(p.objectBySource.get(path)!)!;
  expect(object(source('insulator')).assignment).toMatchObject({status:'inferred',unitKey:object('a').assignment.unitKey});
  expect(object(source('tie')).assignment.status).toBe('unresolved');
  expect(object(source('cross')).assignment.status).toBe('shared');
  expect(object(source('bushing')).kind).toBe('套管');expect(object('a').assignment.status).toBe('confirmed');
});

it('keeps plumbing beside floors, exposes foundations and rejects a total-plan container as a building',()=>{
  const root=node({children:[node({path:'main',name:'1号主变本体',devPath:'main.dev',systemNames:['电气系统','1号主变本体系统']})]}),spatial=buildSubstationSpatialIndexFromTexts([{entry:{modelId:'a',path:'建筑.ifc',name:'a'},text:[
    "#1=IFCBUILDING('b',#99,'HN-220-B-2总平面',$,$,$,$,$,.ELEMENT.,$,$);",
    "#2=IFCBUILDINGSTOREY('f',#99,'0m标高层（110配电楼）',$,$,$,$,$,.ELEMENT.,0.);",
    "#10=IFCWALL('wall',#99,'墙',$,$,$,$,$,$);",
    "#11=IFCFLOWFITTING('water',#99,'排水三通',$,$,$,$,$,$);",
    "#12=IFCFOOTING('foundation',#99,'变压器基础',$,$,$,$,$,$);",
    "#13=IFCFOOTING('building-foundation',#99,'建筑基础',$,$,$,$,$,$);",
    "#20=IFCRELAGGREGATES('r',#99,$,$,#1,(#2));",
    "#21=IFCRELCONTAINEDINSPATIALSTRUCTURE('c',#99,$,$,(#10,#11,#12),#2);",
  ].join('\n')}],root);
  const p=buildBusinessTree(root,new Map(),{...spatial,shapes:[{objectKey:'main',min:[0,0,0],max:[4,4,5],evidence:'geometry'},{objectKey:spatial.objects.find(o=>o.globalId==='building-foundation')!.key,min:[1,1,-1],max:[3,3,0],evidence:'geometry'}]}),object=(guid:string)=>p.objects.get(p.objectBySource.get(spatial.objects.find(o=>o.globalId===guid)!.key)!)!;
  const water=p.units.get(object('water').assignment.unitKey)!;
  expect(water.title).toBe('给排水');expect(water.parentKey).toBeUndefined();
  expect(p.regions.get(water.regionKey)?.title).toBe('110千伏配电楼');
  expect(object('foundation').kind).toBe('foundation');
  const foundationUnit=p.units.get(object('foundation').assignment.unitKey)!;
  expect(p.regions.get(foundationUnit.regionKey)?.title).toBe('基础');expect(foundationUnit.title).toBe('设备基础');
  expect(p.units.get(object('building-foundation').assignment.unitKey)?.title).toBe('建筑基础');expect(object('building-foundation').assignment.relatedUnitKeys).toBeUndefined();
  expect([...p.regions.values()].some(r=>/总平面/.test(r.title))).toBe(false);
  const host=document.createElement('div');document.body.append(host);renderBusinessTree(p,host,'工程',()=>{});revealBusinessTarget(p,object('foundation').key,host);
  expect([...host.querySelectorAll<HTMLElement>('.tree-row')].some(r=>r.dataset.nodePath===`${foundationUnit.key}:group:基础`)).toBe(false);
  expect([...host.querySelectorAll<HTMLElement>('.tree-row')].some(r=>r.dataset.nodePath===object('foundation').key)).toBe(true);
});

it('assigns short primary leads before bus midpoint proximity while retaining ambiguous and explicit bay ownership',()=>{
  const main=node({path:'main',name:'1号主变本体',devPath:'main.dev',systemNames:['电气系统','1号主变本体系统']});
  const bus=node({path:'bus',name:'母线',devPath:'bus.dev',systemNames:['电气系统','110kV系统','Ⅰ母线']});
  const explicit=node({path:'explicit',name:'导线',devPath:'wire.dev',systemNames:['电气系统','110kV系统','2出线间隔']});
  const root=node({children:[main,bus,explicit]}),spatial=buildSubstationSpatialIndexFromTexts([{entry:{modelId:'w',path:'w.ifc',name:'w'},text:"#10=IFCBUILDINGELEMENTPROXY('lead',#99,'导线',$,$,$,$,$,$);"}],root);
  const source=spatial.objects[0].key,shape=(objectKey:string,min:number[],max:number[])=>({objectKey,min:min as [number,number,number],max:max as [number,number,number],evidence:'geometry' as const});
  const shapes=[shape('main',[0,-8,0],[4,-6,8]),shape('bus',[0,-4.5,0],[5,0,2]),shape(source,[.5,-7,13],[4,-1.6,14]),shape('explicit',[.5,-7,13],[4,-1.6,14])];
  const p=buildBusinessTree(root,new Map(),{...spatial,shapes}),object=(p:ReturnType<typeof buildBusinessTree>,path:string)=>p.objects.get(p.objectBySource.get(path)!)!;
  expect(object(p,source).assignment).toMatchObject({status:'inferred',unitKey:object(p,'main').assignment.unitKey});
  expect(object(p,source).assignment.evidence).toContain('unique-primary-lead-contact-v1');
  expect(object(p,'explicit').assignment.status).toBe('confirmed');expect(object(p,'explicit').assignment.unitKey).not.toBe(object(p,'main').assignment.unitKey);
  root.children.push(node({path:'other',name:'断路器',devPath:'other.dev',systemNames:['电气系统','110kV系统','3出线间隔']}));
  const q=buildBusinessTree(root,new Map(),{...spatial,shapes:[...shapes,shape('other',[0,-8,0],[4,-6,8])]});
  expect(object(q,source).assignment.status).toBe('unresolved');
});

it('keeps site trenches out of houses and classifies lighting boxes and HVAC as building services',()=>{
  const root=node(),spatial=buildSubstationSpatialIndexFromTexts([{entry:{modelId:'a',path:'建筑及动力照明.ifc',name:'a'},text:[
    "#1=IFCBUILDING('building',#99,'220配电楼',$,$,$,$,$,.ELEMENT.,$,$);",
    "#2=IFCBUILDINGSTOREY('floor',#99,'0m标高层',$,$,$,$,$,.ELEMENT.,0.);",
    "#10=IFCSLAB('slab',#99,'楼板',$,$,$,$,$,.FLOOR.);",
    "#11=IFCBUILDINGELEMENTPROXY('trench',#99,'电缆沟',$,$,$,$,$,$);",
    "#12=IFCBUILDINGELEMENTPROXY('hvac',#99,'室内空调柜机',$,$,$,$,$,$);",
    "#13=IFCBUILDINGELEMENTPROXY('box',#99,'户内照明箱',$,$,$,$,$,$);",
    "#20=IFCRELAGGREGATES('r',#99,$,$,#1,(#2));",
    "#21=IFCRELCONTAINEDINSPATIALSTRUCTURE('c',#99,$,$,(#10,#11,#12),#2);",
  ].join('\n')}],root);
  const source=(guid:string)=>spatial.objects.find(o=>o.globalId===guid)!.key;
  const box=(guid:string,x:number,y:number,z=0,w=1)=>({objectKey:source(guid),min:[x,y,z] as [number,number,number],max:[x+w,y+w,z+1] as [number,number,number],evidence:'geometry' as const});
  const p=buildBusinessTree(root,new Map(),{...spatial,shapes:[box('slab',0,0,0,10),box('trench',2,2,-3),box('hvac',3,3),box('box',20,20)]});
  const object=(guid:string)=>p.objects.get(p.objectBySource.get(source(guid))!)!,unit=(guid:string)=>p.units.get(object(guid).assignment.unitKey)!;
  expect(p.regions.get(unit('trench').regionKey)?.title).toBe('电缆沟');expect(unit('trench').title).not.toMatch(/标高层/);
  expect(object('hvac').kind).toBe('lighting');expect(unit('hvac').title).toBe('照明');expect(p.regions.get(unit('hvac').regionKey)?.title).toBe('220千伏配电楼');
  expect(object('box').kind).toBe('lighting');expect(unit('box').title).toBe('照明');expect(p.regions.get(unit('box').regionKey)?.title).toBe('站区性建筑');
  expect(p.members.get('business:root')).toHaveLength(p.objects.size);
});

it('reuses a coincident main unit but preserves an unnumbered IFC main and assigns its close accessory',()=>{
  const root=node({children:[node({path:'main',name:'1号主变本体',devPath:'main.dev',systemNames:['电气系统','1号主变本体系统']})]});
  const spatial=buildSubstationSpatialIndexFromTexts([{entry:{modelId:'m',path:'m.ifc',name:'m'},text:[
    "#10=IFCBUILDINGELEMENTPROXY('body1',#99,'主变-SSZ-50000-110:1',$,$,$,$,$,$);",
    "#11=IFCBUILDINGELEMENTPROXY('body2',#99,'主变-SSZ-50000-110:2',$,$,$,$,$,$);",
    "#12=IFCBUILDINGELEMENTPROXY('arrester',#99,'35kV复合避雷器',$,$,$,$,$,$);",
  ].join('\n')}],root);
  const source=(guid:string)=>spatial.objects.find(o=>o.globalId===guid)!.key;
  const box=(objectKey:string,x:number,w=8)=>({objectKey,min:[x,0,0] as [number,number,number],max:[x+w,3,5] as [number,number,number],evidence:'geometry' as const});
  const p=buildBusinessTree(root,new Map(),{...spatial,shapes:[box('main',0),box(source('body1'),0),box(source('body2'),20),box(source('arrester'),28,1)]});
  const object=(path:string)=>p.objects.get(p.objectBySource.get(path)!)!;
  expect(object(source('body1')).assignment.unitKey).toBe(object('main').assignment.unitKey);
  expect(object(source('body2')).assignment.unitKey).not.toBe(object('main').assignment.unitKey);
  expect(p.units.get(object(source('body2')).assignment.unitKey)?.title).toBe('主变单元（源未编号）');
  expect(object(source('arrester')).assignment).toMatchObject({status:'inferred',unitKey:object(source('body2')).assignment.unitKey});
  expect(p.objects.size).toBe(4);
});

it('groups all bus sections once per voltage area, preserving couplers and bay identity', () => {
  const asset=(path:string,name:string,bay:string,voltage=220)=>node({path,name,devSymbolName:name,devPath:`${path}.dev`,systemNames:['交流电气系统',`${voltage}kV配电装置区域`,bay]});
  const root=node({children:[
    node({path:'bus1',name:'Ⅰ母线',systemNames:['交流电气系统','220kV系统','Ⅰ母线'],children:[asset('m1','管母线','Ⅰ母线')]}),
    node({path:'bus2',name:'Ⅱ母线',children:[asset('m2','管母线','Ⅱ母线')]}),
    node({path:'coupler',name:'母联间隔',children:[asset('c1','断路器','母联间隔'),asset('c2','隔离开关','母联间隔')]}),
    node({path:'bay1',name:'出线间隔',children:[asset('a1','电流互感器','出线间隔')]}),
    node({path:'bay2',name:'出线间隔',children:[asset('a2','电流互感器','出线间隔')]}),
    node({path:'bus110',name:'Ⅰ母线',children:[asset('m110','管母线','Ⅰ母线',110)]}),
    asset('cabinet','开关柜柜内母排','出线间隔'),
  ]});
  const p=buildBusinessTree(root), buses=[...p.units.values()].filter(u=>u.kind==='bus');
  expect(buses).toHaveLength(2);
  const area220=[...p.regions.values()].find(r=>r.voltage===220)!;
  const bus=buses.find(u=>u.regionKey===area220.key)!;
  expect(bus.title).toBe('母线设备间隔');
  expect(p.members.get(bus.key)?.map(k=>p.objects.get(k)!.name)).toEqual(['管母线','管母线']);
  expect([...p.units.values()].filter(u=>u.kind==='coupler')).toHaveLength(1);
  expect([...p.units.values()].filter(u=>u.title==='出线间隔')).toHaveLength(3);
  expect(p.members.get('business:root')).toHaveLength(p.objects.size);
  expect(classifyBusinessObject('主变间隔电流互感器')).toBe('device');
  expect(classifyBusinessObject('设备线夹双导线')).toBe('金具');
  expect(classifyBusinessObject('设备线夹双导线','IFCBEAM')).toBe('金具');
  expect(classifyBusinessObject('电缆隧道')).toBe('structure');
  expect(classifyBusinessObject('耐张绝缘子串均压屏蔽装置')).toBe('绝缘子');
  expect(classifyBusinessObject('母线-矩形:标准, 0 V, 单相 相位, 2 导线:2754753')).toBe('母线');
  expect(classifyBusinessObject('设备线夹:母线, 2 导线')).toBe('金具');
  const floors=['4.8m标高层','-0.3m标高层','4m标高层','-3.8m标高层'].map(title=>({key:title,title,regionKey:'building',kind:'building' as const}));
  expect(floors.sort(compareBusinessUnits).map(f=>f.title)).toEqual(['-3.8m标高层','-0.3m标高层','4m标高层','4.8m标高层']);
  const host=document.createElement('div');document.body.append(host);renderBusinessTree(p,host,'工程',()=>{});
  const target=p.objectBySource.get('m2')!;revealBusinessTarget(p,target,host);
  expect([...host.querySelectorAll<HTMLElement>('.tree-row')].some(r=>r.dataset.nodePath===target)).toBe(true);
});

it('keeps secondary engineering context, accepts named 10 kV cabinets and projects confidence as properties',()=>{
  const asset=(path:string,name:string,systemNames:string[]=[])=>node({path,name,devSymbolName:name,devPath:path+'.dev',systemNames});
  const neutral110=asset('n110','110kV中性点成套装置'),neutral220=asset('n220','220kV中性点成套装置'),body=asset('body','220kV变压器模型04');
  const meter=asset('meter','220kV电能表柜',['屏柜']);meter.rawProperties={BASEFAMILY1:'base.fam',BASEFAMILY4:'meter.fam'};
  const low=asset('low','10kV-1250-31.5 出线柜');low.famPath='low.fam';
  const unknown=asset('unknown','无明确归属的绝缘子');
  const p=buildBusinessTree(node({children:[
    node({path:'main',systemNames:['电气系统','220kV变压器系统','1号主变本体系统'],children:[neutral110,neutral220,body]}),
    node({path:'secondary',systemNames:['电气系统','跨电压等级系统','电能量采集系统'],children:[meter]}),
    node({path:'low-bay',systemNames:['电气系统','10kV系统','1-1C'],children:[low]}),unknown,
  ]}),new Map([['meter.fam',[{label:'工程中名称',rawKey:'name',rawValue:'220kV电能表柜'}]],['low.fam',[{label:'电压等级',rawKey:'voltage',rawValue:'AC12kV'}]]]));
  const object=(path:string)=>p.objects.get(p.objectBySource.get(path)!)!;
  expect(p.regions.get(p.units.get(object('meter').assignment.unitKey)!.regionKey)?.title).toBe('二次系统');
  expect(object('low').voltage).toBe(10);expect(p.units.get(object('low').assignment.unitKey)?.title).toBe('1-1C');
  const host=document.createElement('div');document.body.append(host);renderBusinessTree(p,host,'工程',()=>{});
  for(let i=0;i<5;i++)for(const row of [...host.querySelectorAll<HTMLElement>('.tree-row[aria-expanded="false"]')])row.querySelector<HTMLButtonElement>('.tree-toggle')?.click();
  const labels=[...host.querySelectorAll('.tree-label')].map(n=>n.textContent);
  expect(labels).not.toContain('设备与附件');expect(labels).not.toContain('待确认');expect(labels).not.toContain('安装区域待确认');
  const main=[...p.units.values()].find(u=>u.kind==='transformer')!,row=[...host.querySelectorAll<HTMLElement>('.tree-row')].find(r=>r.dataset.nodePath===main.key)!;
  expect([...row.nextElementSibling!.children].map(n=>n.querySelector('.tree-label')?.textContent)).toEqual(['220kV变压器模型04','220kV中性点成套装置','110kV中性点成套装置']);
  expect(revealBusinessTarget(p,object('unknown').key,host)).toBe(object('unknown').key);
  expect([...host.querySelectorAll<HTMLElement>('.tree-row')].some(r=>r.dataset.nodePath===object('unknown').key)).toBe(true);
});

it('assigns uniquely enclosed material, keeps ambiguous geometry pending and records cross-bay endpoints',()=>{
  const primary=(path:string,bay:string)=>node({path,name:'断路器',devPath:path+'.dev',systemNames:['电气系统','110kV系统',bay]});
  const root=node({children:[primary('a','1出线间隔'),primary('b','2出线间隔'),node({path:'internal',name:'柜内母排',devPath:'internal.dev',systemNames:['电气系统','110kV系统','1出线间隔']})]});
  const index=buildSubstationSpatialIndexFromTexts([{entry:{modelId:'materials',path:'materials.ifc',name:'m'},text:[
    "#10=IFCBUILDINGELEMENTPROXY('clip',#99,'设备线夹',$,$,$,$,$,$);",
    "#11=IFCBUILDINGELEMENTPROXY('wire',#99,'导线',$,$,$,$,$,$);",
    "#12=IFCBUILDINGELEMENTPROXY('ambiguous',#99,'绝缘子',$,$,$,$,$,$);",
  ].join('\n')}],root);
  const source=(guid:string)=>index.objects.find(o=>o.globalId===guid)!.key;
  const box=(objectKey:string,min:number[],max:number[])=>({objectKey,min:min as [number,number,number],max:max as [number,number,number],evidence:'geometry' as const});
  const p=buildBusinessTree(root,new Map(),{...index,shapes:[box('a',[0,0,0],[1,1,2]),box('b',[4,0,0],[5,1,2]),box(source('clip'),[.2,.2,.2],[.3,.3,.3]),box(source('wire'),[.2,.4,.5],[.8,.6,.5]),box(source('ambiguous'),[0,0,0],[5,1,2])],connections:[{objectKey:source('wire'),endpointKeys:['a','b']}]});
  const object=(key:string)=>p.objects.get(p.objectBySource.get(key)!)!;
  expect(object(source('clip')).assignment.unitKey).toBe(object('a').assignment.unitKey);expect(object(source('clip')).assignment.status).toBe('inferred');
  expect(object(source('wire')).assignment.status).toBe('shared');expect(object(source('wire')).assignment.relatedUnitKeys).toHaveLength(2);
  expect(object(source('ambiguous')).assignment.status).toBe('unresolved');expect(object(source('ambiguous')).assignment.candidates).toHaveLength(2);
  expect(object('internal').assignment.status).toBe('confirmed');expect(p.units.get(object('internal').assignment.unitKey)?.kind).toBe('bay');
  expect(p.members.get('business:root')).toHaveLength(p.objects.size);
});

it('joins IFC disciplines to named physical buildings and keeps systems parallel to floors',()=>{
  const arch={modelId:'arch',path:'arch.ifc',name:'a'},systems={modelId:'systems',path:'lighting.ifc',name:'s'};
  const text=(a:string,b:string)=>[
    "#1=IFCPROJECT('p',#99,'工程',$,$,$,$,(#90),$);",
    "#2=IFCBUILDING('building',#99,$,$,$,$,$,$,.ELEMENT.,$,$,$);",
    `#3=IFCBUILDINGSTOREY('floor1',#99,'${a}',$,$,$,$,$,.ELEMENT.,4.8);`,
    `#4=IFCBUILDINGSTOREY('floor2',#99,'${b}',$,$,$,$,$,.ELEMENT.,6.);`,
    "#20=IFCRELAGGREGATES('r',#99,$,$,#2,(#3,#4));",
  ];
  const root=node(),index=buildSubstationSpatialIndexFromTexts([
    {entry:arch,text:[...text('4.8m标高层（110配电楼）','6m标高层（220配电楼）'),"#10=IFCSLAB('slab1',#99,'楼板1',$,$,$,$,$,.FLOOR.);","#11=IFCSLAB('slab2',#99,'楼板2',$,$,$,$,$,.FLOOR.);","#21=IFCRELCONTAINEDINSPATIALSTRUCTURE('r1',#99,$,$,(#10),#3);","#22=IFCRELCONTAINEDINSPATIALSTRUCTURE('r2',#99,$,$,(#11),#4);"].join('\n')},
    {entry:systems,text:[...text('标高 1','标高 2'),"#10=IFCLIGHTFIXTURE('light',#99,'照明灯',$,$,$,$,$,$);","#11=IFCFIRESUPPRESSIONTERMINAL('fire',#99,'消防喷淋头',$,$,$,$,$,$);","#21=IFCRELCONTAINEDINSPATIALSTRUCTURE('r1',#99,$,$,(#10,#11),#3);"].join('\n')},
  ],root);
  const source=(guid:string)=>index.objects.find(o=>o.globalId===guid)!.key;
  const box=(guid:string,x:number,z:number,w=1)=>({objectKey:source(guid),min:[x,0,z] as [number,number,number],max:[x+w,w,z+.1] as [number,number,number],evidence:'geometry' as const});
  const p=buildBusinessTree(root,new Map(),{...index,modelUnits:new Map([['arch',1],['systems',1]]),shapes:[box('slab1',0,4.8,10),box('slab2',20,6,10),box('light',2,2),box('fire',22,2)]});
  expect([...p.regions.values()].filter(r=>r.domain==='construction').map(r=>r.title).sort()).toEqual(['110千伏配电楼','220千伏配电楼']);
  const light=p.objects.get(p.objectBySource.get(source('light'))!)!,floor=p.units.get(light.assignment.unitKey)!;
  expect(floor.title).toBe('照明');expect(p.regions.get(floor.regionKey)?.title).toBe('110千伏配电楼');
  expect([...p.units.values()].some(u=>u.regionKey===floor.regionKey&&u.title==='4.8m标高层')).toBe(true);
  expect(p.members.get('business:root')).toHaveLength(p.objects.size);
});

it('orders installation systems and distinct bay classes in numeric business order',()=>{
  const asset=(path:string,name:string,context:string[])=>node({path,name,devSymbolName:name,devPath:`${path}.dev`,systemNames:context});
  const voltage=['电气系统','220kV系统'];
  const p=buildBusinessTree(node({children:[
    ...['10出线间隔','2出线间隔','1出线间隔','1进线间隔','母联间隔','分段间隔','1EM PT'].map((bay,i)=>asset(`bay${i}`,'电压互感器',[...voltage,bay])),
    node({...asset('gis','组合电器',[...voltage,'2EM PT']),devSymbolName:'220kVGIS电缆出线间隔'}),
    asset('low','断路器',['电气系统','110kV系统','出线间隔']),
    asset('main','1号主变本体',['电气系统','1号主变本体系统']),
    asset('reactive','电容器',['电气系统','无功补偿']),
    asset('station','站用变压器',['电气系统','站用电']),
    asset('ground','接地网',['电气系统','接地系统']),
    asset('secondary','测控柜',['电气系统','二次系统']),
  ]}));
  expect([...p.regions.values()].sort(compareBusinessRegions).map(r=>r.title)).toEqual(['主变压器系统','220千伏配电装置区域','110千伏配电装置区域','无功补偿区域','站用电系统','电缆及接地','二次系统']);
  const area=[...p.regions.values()].find(r=>r.voltage===220)!;
  const units=[...p.units.values()].filter(u=>u.regionKey===area.key).sort(compareBusinessUnits);
  expect(units.map(u=>u.title)).toEqual(['1出线间隔','2出线间隔','10出线间隔','1进线间隔','母线设备间隔','母联间隔','分段间隔']);
  expect(units[units.length-1]?.kind).toBe('section');
  expect(p.members.get(units.find(u=>u.kind==='bus')!.key)).toHaveLength(2);
  expect(classifyBusinessObject('220kVGIS电缆出线间隔')).toBe('device');
});
it('does not turn a generic F2 voltage or mixed transformer context into cabinet ownership',()=>{
  const cabinet=node({path:'cabinet',name:'开关柜',devSymbolName:'开关柜',devPath:'cabinet.dev',systemNames:['电气系统','220kV系统','1号主变本体系统']});
  const transformer=node({path:'transformer',name:'1号主变本体',devSymbolName:'1号主变本体',devPath:'transformer.dev',systemNames:['电气系统','220kV系统','1号主变本体系统']});
  const p=buildBusinessTree(node({children:[cabinet,transformer]}));
  const c=p.objects.get(p.objectBySource.get(cabinet.path)!)!,t=p.objects.get(p.objectBySource.get(transformer.path)!)!;
  expect(c.voltage).toBeUndefined();expect(c.assignment.status).toBe('unresolved');
  expect(c.assignment.unitKey).not.toBe(t.assignment.unitKey);
  expect(p.units.get(t.assignment.unitKey)?.title).toBe('1号主变及其附件');
  const inlet=node({path:'inlet',name:'开关柜',devSymbolName:'10kV-1250-31.5 主变进线柜',devPath:'inlet.dev'});
  const protection=node({path:'protection',name:'屏柜',devSymbolName:'3号主变压器保护B柜',devPath:'protection.dev'});
  const mixed=buildBusinessTree(node({children:[inlet,protection]}));
  expect([...mixed.units.values()].some(u=>u.kind==='transformer')).toBe(false);
  const wire=node({path:'wire',name:'导线0主变区域布置',devSymbolName:'导线0主变区域布置',devPath:'wire.dev'});
  expect([...buildBusinessTree(node({children:[wire]})).units.values()].some(u=>u.kind==='transformer')).toBe(false);
});
it('retains a door without its own shape while treating an opening as a host feature',()=>{
  const root=node(),spatial=buildSubstationSpatialIndexFromTexts([{entry:{modelId:'civil',path:'CBM/civil.ifc',name:'civil'},text:[
    "#10=IFCWALL('wall',#99,'Wall',$,$,$,$,$,$);",
    "#11=IFCOPENINGELEMENT('opening',#99,'Opening',$,$,$,$,$,$);",
    "#12=IFCDOOR('door',#99,'Door',$,$,$,$,$,$,$,$);",
    "#20=IFCRELVOIDSELEMENT('void',#99,$,$,#10,#11);",
    "#21=IFCRELFILLSELEMENT('fill',#99,$,$,#11,#12);",
  ].join('\n')}],root);
  const p=buildBusinessTree(root,new Map(),spatial),wall=spatial.objects.find(o=>o.globalId==='wall')!,opening=spatial.objects.find(o=>o.globalId==='opening')!,door=spatial.objects.find(o=>o.globalId==='door')!;
  expect(p.objects.size).toBe(2);expect(p.objectBySource.has(door.key)).toBe(true);
  expect(p.objects.get(p.objectBySource.get(wall.key)!)!.featureKeys).toContain(opening.key);
  expect(p.objectBySource.get(opening.key)).toBe(p.objectBySource.get(wall.key));
});
it('keeps one pending bucket and separates rated voltage from nominal business evidence',()=>{
  const unknown=Array.from({length:3},(_,i)=>node({path:`unknown-${i}`,name:`未命名${i}`,devPath:`${i}.dev`}));
  const root=node({children:unknown}),pending=buildBusinessTree(root);
  expect(pending.units.size).toBe(1);
  for(const members of pending.members.values())expect(new Set(members).size).toBe(members.length);
  const arrester=node({path:'arrester',name:'220kV避雷器模型01',devSymbolName:'避雷器',devPath:'a.dev',famPath:'a.fam',systemNames:['电气系统','220kV系统','母线间隔']});
  const p=buildBusinessTree(node({children:[arrester]}),new Map([['a.fam',[{label:'电压等级',rawKey:'VoltageLevel',rawValue:'AC220kV'},{label:'额定电压',rawKey:'RatedVoltage',rawValue:'AC252kV'}]]]));
  const object=p.objects.get(p.objectBySource.get(arrester.path)!)!;
  expect(object.voltage).toBe(220);expect(object.voltageConflict).toBe(false);
  expect(p.units.get(object.assignment.unitKey)?.kind).toBe('bus');
  const bare=buildBusinessTree(node({children:[node({...arrester,devSymbolName:'220NAIZHANGXIANJIA01',name:'绝缘子串'})]}),new Map([['CbM/A.FAM',[{label:'电压等级',rawKey:'VoltageLevel',rawValue:'AC220kV'}]]]));
  expect(bare.units.get(bare.objects.get(bare.objectBySource.get('arrester')!)!.assignment.unitKey)?.kind).toBe('bus');
  const ranged=buildBusinessTree(node({children:[node({...arrester,systemNames:['电气系统','≥110kV且<220kV系统','110kV母线2段母线间隔'],name:'绝缘子串'})]}));
  const rangedBus=[...ranged.units.values()].find(u=>u.kind==='bus')!;
  expect(ranged.regions.get(rangedBus.regionKey)?.voltage).toBe(110);
  expect(classifyBusinessObject('三防泛光灯-立杆式:古典吊灯')).toBe('lighting');
});

it('windows a large functional branch, retaining nested expansion, search identity and keyboard navigation', async () => {
  const assets = Array.from({length: 1200}, (_, i) => node({path: `asset-${i}`, name: `设备${i}`, devPath: `${i}.dev`,
    children: i === 1199 ? [node({path: 'last-part', name: '连接片', entityName: 'PARTINDEX', devPath: 'part.dev'})] : []}));
  const root = node({children: [node({path: 'system', systemNames: ['电气系统', '设备系统'], children: assets})]});
  const state = new AppState(); state.currentCbmTree = root;
  const index = buildFunctionalDomainIndex(root), host = document.createElement('div');
  host.className = 'tab-panel'; document.body.append(host);
  const clicked = vi.fn();
  renderSubstationFunctionalTree(state, index, host, clicked);
  const key = revealFunctionalSearchTarget(index, 'asset-1199')!;
  expect(host.querySelector('.functional-virtual-outline')).not.toBeNull();
  expect(host.querySelectorAll('.functional-tree-row').length).toBeLessThan(140);
  const last = host.querySelector<HTMLElement>(`[data-node-path="${key}"]`)!;
  expect(last).not.toBeNull(); last.click(); expect(clicked).toHaveBeenLastCalledWith(assets[1199]);
  const partKey = revealFunctionalSearchTarget(index, 'last-part')!;
  expect(host.querySelector(`[data-node-path="${partKey}"]`)).not.toBeNull();
  const firstKey = revealFunctionalSearchTarget(index, 'asset-0')!;
  host.querySelector<HTMLElement>(`[data-node-path="${firstKey}"]`)!.dispatchEvent(new KeyboardEvent('keydown', {key: 'End', bubbles: true}));
  expect((document.activeElement as HTMLElement).dataset.nodePath).toBe(partKey);
  expect(host.querySelector(`[data-node-path="${key}"]`)?.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelectorAll('.functional-tree-row').length).toBeLessThan(140);
  await Promise.resolve();
  const remove = vi.spyOn(host, 'removeEventListener');
  host.remove(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
  document.body.replaceChildren();
});

it('sorts transformer body and neutral equipment by transformer number before standby wording',()=>{
  expect(['2号备用主变本体系统','3号备用主变本体系统','1号主变本体系统','3号主变中性点设备','1号主变中性点设备','2号主变中性点设备'].sort(compareSubstationNames))
    .toEqual(['1号主变本体系统','1号主变中性点设备','2号备用主变本体系统','2号主变中性点设备','3号备用主变本体系统','3号主变中性点设备']);
});

it('child display hints do not promote raw classification codes to functional domains', () => {
  const root = node({ children: [node({ entityName:'F3System', path:'CBM/system.cbm',
    systemNames:[], classifyName:'0****001', name:'0****001（含部件A、部件B）', rawProperties:{} })] });
  expect(buildFunctionalDomainIndex(root).domains.map((domain) => domain.title)).toEqual(['未归类系统']);
});

describe('substation functional tree projection', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('按 F3 功能域分组，F2 只成为专业徽标，并把未分类系统收拢为一个域', () => {
    const duplicatePart = node({
      path: 'CBM/part-index.cbm',
      name: '柜内端子',
      entityName: 'PARTINDEX',
      devPath: 'part.dev',
    });
    const virtualPart = node({
      path: 'CBM/device.cbm#dev:0:part.dev',
      name: '柜内端子',
      entityName: 'DEV_SUBDEVICE',
      devPath: 'part.dev',
    });
    const electricalSystem = node({
      path: 'CBM/electrical-system.cbm',
      name: '电气系统 / 220kV系统 / 进线间隔',
      entityName: 'F3System',
      systemNames: ['电气系统', '220kV系统', '进线间隔'],
      children: [
        node({
          path: 'CBM/component.cbm',
          entityName: 'F4System',
          name: '断路器',
          ifcFile: 'model.ifc',
          ifcGuid: 'guid-1',
        }),
        node({
          path: 'CBM/device.cbm',
          entityName: 'F4System',
          name: '保护柜',
          devPath: 'cabinet.dev',
          children: [duplicatePart, virtualPart],
        }),
      ],
    });
    const buildingSystem = node({
      path: 'CBM/building-system.cbm',
      name: '建筑物系统 / 建筑',
      entityName: 'F3System',
      systemNames: ['建筑物系统', '建筑'],
      children: [],
    });
    const unclassifiedSystem = node({
      path: 'CBM/unclassified-system.cbm',
      name: '&其他',
      entityName: 'F3System',
      systemNames: [],
      classifyName: '建筑系统代码',
      children: [],
    });
    const root = node({
      children: [
        node({ entityName: 'F2System', classifyName: 'A', children: [electricalSystem] }),
        node({ entityName: 'F2System', classifyName: 'U', children: [buildingSystem] }),
        node({ entityName: 'F2System', classifyName: '02', children: [unclassifiedSystem] }),
      ],
    });

    const index = buildFunctionalDomainIndex(root);
    expect(index.domains.map((domain) => domain.title)).toEqual(['电气系统', '建筑物系统', '未归类系统']);
    expect(index.domains.find((domain) => domain.title === '电气系统')?.disciplineLabels).toEqual([]);
    expect(index.domains.find((domain) => domain.title === '未归类系统')?.systems).toHaveLength(1);

    const electrical = index.domains[0].systems[0];
    expect(electrical.assets.map((asset) => asset.role)).toEqual(['device', 'device']);
    expect(electrical.assets[1].parts).toHaveLength(1);
    expect(electrical.assets[1].parts[0].sourceNodes).toHaveLength(2);
    expect(index.targetByKey.get(virtualPart.path)?.rowKey).toBe(electrical.assets[1].parts[0].key);
  });

  it('默认只生成工程根和功能域，搜索命中时按祖先链惰性展开', () => {
    const f3 = node({
      path: 'CBM/system.cbm',
      name: '电气系统 / 10kV系统 / 间隔01',
      entityName: 'F3System',
      systemNames: ['电气系统', '10kV系统', '间隔01'],
      children: [
        node({
          path: 'CBM/device.cbm',
          entityName: 'F4System',
          name: '设备',
          devPath: 'device.dev',
          children: [node({ path: 'CBM/part.cbm', entityName: 'PARTINDEX', name: '部件', devPath: 'part.dev' })],
        }),
      ],
    });
    const root = node({ children: [node({ entityName: 'F2System', classifyName: 'A', children: [f3] })] });
    const state = new AppState();
    state.projectName = '测试变电工程';
    state.currentCbmTree = root;
    const index = buildFunctionalDomainIndex(root);
    const host = document.createElement('div');
    document.body.appendChild(host);
    let clicked: CbmNode | null = null;
    renderSubstationFunctionalTree(state, index, host, (selected) => { clicked = selected; });

    expect(host.querySelectorAll('.functional-tree-row')).toHaveLength(2);
    const initialBadges = Array.from(host.querySelectorAll<HTMLElement>('.functional-badge'))
      .map((element) => element.textContent || '');
    expect(initialBadges).toEqual(['1 个域', '1 个系统']);
    expect(host.textContent).not.toContain('F4 1');
    const searchItems = buildFunctionalSearchIndex(state, index);
    const partItem = searchItems.find((item) => item.title === '部件');
    expect(partItem).toBeDefined();
    const rowKey = revealFunctionalSearchTarget(index, partItem!.key);
    expect(rowKey).toBeTruthy();
    expect(host.querySelector(`[data-node-path="${rowKey}"]`)).not.toBeNull();
    // 展开祖先链只操作箭头，不触发祖先对象选择。
    expect(clicked).toBeNull();
    host.querySelector<HTMLElement>(`[data-node-path="${rowKey}"]`)!.click();
    expect(clicked).not.toBeNull();
    expect(clicked!.path).toBe('CBM/part.cbm');
  });
});

it('component labels override equipment words, nested independent units keep their own identity', () => {
  const actuator = node({path:'actuator',entityName:'PARTINDEX',name:'断路器操动机构',devPath:'actuator.dev'});
  const nested = node({path:'nested',entityName:'PARTINDEX',name:'汇控柜',devPath:'cabinet.dev'});
  const breaker = node({path:'breaker',entityName:'F4System',name:'断路器',children:[actuator,nested]});
  const root = node({children:[node({path:'system',entityName:'F3System',systemNames:['电气系统','220kV系统','进线间隔'],children:[breaker]})]});
  const assets = buildFunctionalDomainIndex(root).domains[0].systems[0].assets;
  expect(assets.map(row=>[row.node.path,row.role])).toEqual([['breaker','device'],['nested','device']]);
  expect(assets[0].parts.map(part=>part.node.path)).toEqual(['actuator']);
});

it('systems and voltage groups are independent of physical depth and retain repeated parts of the same DEV', () => {
  const parts=[node({path:'part-1',name:'散热器',entityName:'PARTINDEX',devPath:'shared.dev'}),node({path:'part-2',name:'散热器',entityName:'PARTINDEX',devPath:'shared.dev'})];
  const device=node({path:'main',name:'主变压器',entityName:'F2System',children:parts});
  const context=node({path:'context',entityName:'F4System',systemNames:['电气系统','220kV系统','主变间隔'],children:[device]});
  const index=buildFunctionalDomainIndex(node({children:[context]}));
  const system=index.domains[0].systems[0];
  expect(system.title).toBe('主变间隔');expect(system.groupPath).toEqual(['220kV系统']);
  expect(system.assets.map(row=>row.node.path)).toEqual(['main']);
  expect(system.assets[0].parts.map(row=>row.node.path)).toEqual(['part-1','part-2']);
  expect(index.targetByKey.get('part-1')!.rowKey).not.toBe(index.targetByKey.get('part-2')!.rowKey);
});
it('FAM corroboration retains source rows and marks conflicting classifications', () => {
  const source=node({path:'object',name:'对象',devPath:'object.dev',famPath:'Fam/object.fam'});
  const rows=[{sourcePath:'FAM/object.fam',sourceLine:2,section:'属性',rawKey:'NAME',label:'设备名称',rawValue:'断路器',rawLine:'设备名称=NAME=断路器'}];
  const root=node({children:[source]});const fam=new Map([['FAM/OBJECT.FAM',rows]]);
  const asset=buildFunctionalDomainIndex(root,fam).domains[0].systems[0].assets[0];
  expect(asset.role).toBe('device');expect(asset.classification.famEvidence[0]).toBe(rows[0]);
  const conflict=node({path:'conflict',name:'主变散热器',devPath:'part.dev',famPath:'Fam/object.fam'});
  const classified=buildFunctionalDomainIndex(node({children:[conflict]}),fam).domains[0].systems[0].assets[0];
  expect(classified.role).toBe('component');expect(classified.classification.conflict).toBe(true);
});

it('a device SYSTEMNAME labels the unit without creating another system group',()=>{
  const unit=node({path:'breaker',name:'断路器',systemNames:['断路器'],devPath:'breaker.dev'});
  const root=node({children:[node({path:'bay',name:'主变系统',systemNames:['电气系统','220kV系统','主变间隔'],children:[unit]})]});
  const index=buildFunctionalDomainIndex(root);const system=index.domains[0].systems[0];
  expect(index.domains).toHaveLength(1);expect(system.title).toBe('主变间隔');expect(system.assets.map(row=>row.node.path)).toEqual(['breaker']);
});

it('coalesces voltage prefixes, keeps alphanumeric bays, separates secondary systems and sorts numeric bay labels', () => {
  const bay = (label:string,path:string,unit='220kV系统') => node({path,name:label,systemNames:['交流电气系统',unit,label],
    children:[node({path:`${path}/breaker`,name:'断路器',devPath:`${path}.dev`})]});
  const root = node({children:[node({path:'voltage',name:'220kV系统',systemNames:['交流电气系统','220kV系统'],children:[
    bay('18断路器间隔','bay18'),bay('02断路器间隔','bay2'),bay('01断路器间隔','bay1'),bay('1EM PT','pt'),
    bay('公用测控系统','secondary','跨电压等级系统'),
  ]})]});
  const state = new AppState(); state.currentCbmTree=root;
  const index = buildFunctionalDomainIndex(root), host = document.createElement('div');document.body.appendChild(host);
  renderSubstationFunctionalTree(state,index,host,()=>{});
  host.querySelector<HTMLButtonElement>('.tree-children .tree-toggle[data-toggle-key]')!.click();
  const labelRows = (label:string) => [...host.querySelectorAll<HTMLElement>('.functional-tree-row')]
    .filter(row => row.querySelector('.tree-label')?.textContent === label);
  expect(labelRows('220kV系统')).toHaveLength(1);
  expect(labelRows('控制及直流/二次系统')).toHaveLength(1);
  labelRows('220kV系统')[0].querySelector<HTMLButtonElement>('.tree-toggle')!.click();
  const children = labelRows('220kV系统')[0].nextElementSibling!;
  expect([...children.children].map(el => el.querySelector('.tree-label')!.textContent))
    .toEqual(['1EM PT','01断路器间隔','02断路器间隔','18断路器间隔']);
  expect(children.textContent).not.toContain('公用测控系统');
  const target = revealFunctionalSearchTarget(index,'bay2/breaker');
  expect(host.querySelector(`[data-node-path="${target}"]`)).not.toBeNull();
  document.body.innerHTML='';
});

it('counts one independent unit for a unique part alias pair while preserving repeated occurrences', () => {
  const part = (path:string,entityName:string,devPath='switch.dev') => node({path,entityName,name:'隔离开关',devPath});
  const root = node({children:[node({path:'bay',systemNames:['电气系统','220kV系统','间隔'],children:[
    node({path:'owner',name:'组合设备',devPath:'owner.dev',children:[part('pi','PARTINDEX'),part('virtual','DEV_SUBDEVICE')]}),
    node({path:'other-owner',name:'组合设备',devPath:'other.dev',children:[part('repeat-1','PARTINDEX'),part('repeat-2','PARTINDEX')]}),
  ]})]});
  const index=buildFunctionalDomainIndex(root),assets=index.domains[0].systems.find(system=>system.title==='间隔')!.assets;
  expect(assets.filter(asset=>asset.role==='device').map(asset=>asset.node.path)).toEqual(['pi','repeat-1','repeat-2']);
  expect(index.targetByKey.get('virtual')!.rowKey).toBe('pi');
  expect(index.targetByKey.get('repeat-1')!.rowKey).not.toBe(index.targetByKey.get('repeat-2')!.rowKey);
});

it('writes aria-expanded on source rows so a re-render can restore expansion', () => {
  const root = node({children:[node({path:'CBM/child.cbm',name:'子节点',entityName:'F4System'})]});
  const host = document.createElement('div');
  renderCbmTreeUI(new AppState(), root, host, () => {});
  const row = host.querySelector<HTMLElement>('.tree-row')!;
  expect(row.getAttribute('aria-expanded')).toBe('false');
  row.querySelector<HTMLElement>('.tree-toggle')!.click();
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelectorAll('.tree-row')).toHaveLength(2);
});
