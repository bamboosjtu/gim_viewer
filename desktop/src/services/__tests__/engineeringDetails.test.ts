import {beforeEach,expect,it,vi} from 'vitest';
import {AppState} from '../../app/state.js';
import {extractEngineeringSourceGraph} from '../../gim/engineering/sourceGraph.js';
import {buildEngineeringSources} from '../../gim/engineering/buildSources.js';
import {projectEngineeringNavigation} from '../../gim/engineering/navigation.js';
const evidence=vi.hoisted(()=>({ensure:vi.fn(),query:vi.fn()}));
vi.mock('../engineeringService.js',()=>({ensureEngineeringEvidence:evidence.ensure,queryEngineeringEvidence:evidence.query}));

beforeEach(()=>{
  vi.resetModules();vi.clearAllMocks();HTMLElement.prototype.scrollIntoView=vi.fn();
  document.body.innerHTML='<div id="cbm-tree-panel" class="tab-panel"></div><aside id="props-drawer"><div id="props-drawer-body"></div></aside><button id="btn-close-props"></button><button id="btn-export-props"></button>';
  evidence.ensure.mockResolvedValue({revision:7});
  evidence.query.mockResolvedValue({coverage:[{entryId:'a.fam',status:'complete'}],attributes:[{rawKey:'vendor',rawValue:'observed-value'}],assignments:[]});
});
async function select(owner:boolean){
  const raw:Record<string,string>={'project.cbm':'OBJECTMODELPOINTER=a.dev','a.dev':'TYPE=GIS\nBASEFAMILY=a.fam','a.fam':'[设计]\n设备名称=DEVICENAME=GIS'};
  const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>raw[p]});
  const built=buildEngineeringSources('scope',graph,[],[]),state=new AppState();state.activateProject(1,'scope');state.currentProjectType='substation';
  if(!owner){built.snapshot.entities=[];built.snapshot.pending=[];built.snapshot.memberships=built.snapshot.memberships.map(m=>({...m,ownerId:null,disposition:'source_only'}));}
  state.engineeringSources=built.sources;state.engineeringSnapshot=built.snapshot;state.engineeringNavigation=projectEngineeringNavigation(built.sources,built.snapshot);
  const {configurePresentation}=await import('../../app/presentationBindings.js');configurePresentation();
  const {selectEngineeringTarget}=await import('../engineeringSelection.js');
  await selectEngineeringTarget(state,{kind:'engineering-source',key:graph.records[0].id});
  return state;
}
it.each([true,false])('loads DEV attributes through the details button with owner=%s',async owner=>{
  const state=await select(owner);
  expect(!!document.getElementById('engineering-owner')).toBe(owner);
  const button=document.getElementById('engineering-details');expect(button).not.toBeNull();
  button!.click();
  await vi.waitFor(()=>expect(document.getElementById('engineering-details-result')?.textContent).toContain('observed-value'));
  expect(evidence.ensure).toHaveBeenCalledWith(state,{entryIds:['a.fam'],kinds:['attributes','assignments']});
  expect(evidence.query).toHaveBeenCalledWith(state,expect.objectContaining({revision:7}));
});
it('does not submit a DEV detail query after the selection changes during ensure',async()=>{
  let finish!:(value:{revision:number})=>void;
  evidence.ensure.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const state=await select(true);document.getElementById('engineering-details')!.click();
  await vi.waitFor(()=>expect(evidence.ensure).toHaveBeenCalled());
  state.beginSelection({kind:'engineering-source',key:'newer'});finish({revision:8});
  await vi.waitFor(()=>expect(document.getElementById('engineering-details-result')?.textContent).toContain('选择已变化'));
  expect(evidence.query).not.toHaveBeenCalled();
});
