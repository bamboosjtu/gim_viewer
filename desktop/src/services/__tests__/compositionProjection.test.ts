import { afterEach, expect, it, vi } from 'vitest';
import { AppState } from '../../app/state.js';
import { extractEngineeringSourceGraph } from '../../gim/engineering/sourceGraph.js';
import { buildEngineeringSources } from '../../gim/engineering/buildSources.js';
import { projectEngineeringNavigation } from '../../gim/engineering/navigation.js';
import { projectEngineeringComposition } from '../../engineering/composition.js';
import type { IfcSpatialObject } from '../../gim/ifcSpatialParser.js';
import { installCompositionProjection, reconcileProjectionSelection } from '../compositionProjectionService.js';
import { projectSpatialComposition } from '../projections/compositionSpatial.js';
import type { ProjectionInput } from '../compositionProjectionWorker.js';
import { selectEngineeringTarget, clearEngineeringHighlight } from '../engineeringSelection.js';

vi.mock('../engineeringSelection.js',()=>({selectEngineeringTarget:vi.fn(async()=>true),clearEngineeringHighlight:vi.fn(async()=>{})}));
vi.mock('../../ui/propsDrawer.js',()=>({renderInspectorTabs:vi.fn(),sectionHtml:vi.fn(()=> '')}));

class ProjectionWorker {
  static instances: ProjectionWorker[]=[];
  input!: ProjectionInput;
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: ErrorEvent) => void;
  terminate=vi.fn();
  constructor(){ProjectionWorker.instances.push(this);}
  postMessage(input:ProjectionInput){this.input=input;}
  reply(){
    const assignments=projectSpatialComposition(this.input.snapshot,this.input.facts,this.input.bounds);
    this.onmessage?.({data:{composition:projectEngineeringComposition(this.input.snapshot,assignments,'工程组成',this.input.declarations),contexts:assignments.map(a=>[a.entityId,a.paths.map(p=>p.map(g=>g.title).join('/')).join('；')])}} as MessageEvent);
  }
}
async function fixture(){
  const state=new AppState();state.activateProject(1,'p');
  const graph=await extractEngineeringSourceGraph({paths:['project.cbm','建筑.ifc'],readText:async()=>''});
  const objects:IfcSpatialObject[]=['墙','楼板','柱'].map((name,i)=>({key:`m#${i+1}`,modelId:'m',expressId:i+1,ifcType:['IFCWALL','IFCSLAB','IFCCOLUMN'][i],name,globalId:`g${i}`,geometryStatus:'unrepresented',parentObjectKey:null,childObjectKeys:[],relationshipCount:0,hostObjectKey:null,spatialKey:null,spatialKeys:[],spatialContainment:null,sourcePath:'建筑.ifc'}));
  const built=buildEngineeringSources('p',graph,objects,[]);
  state.engineeringSnapshot=built.snapshot;state.engineeringSources=built.sources;
  state.engineeringNavigation=projectEngineeringNavigation(built.sources,built.snapshot);
  state.ifcRegionalRuntimes.set('m',{index:{objects:objects.map(o=>({...o,bounds:[0,0,-10,10,4,0]}))},release:vi.fn()} as never);
  vi.useFakeTimers();ProjectionWorker.instances=[];vi.stubGlobal('Worker',ProjectionWorker);
  const dispose=installCompositionProjection(state);
  const run=()=>{state.engineeringGeometryEvidenceChanged?.();vi.advanceTimersByTime(500);return ProjectionWorker.instances[ProjectionWorker.instances.length-1];};
  return {state,dispose,run};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks();});

it('refines only composition, preserves semantic inputs and does not accumulate search text',async()=>{
  const f=await fixture(),snapshot=f.state.engineeringSnapshot!,before=JSON.stringify(snapshot),sources=f.state.engineeringSources,base=f.state.engineeringNavigation!;
  try {
    f.state.engineeringExpandedRows.composition.add(base.composition.rootKey);
    f.state.engineeringExpandedRows.composition.add('obsolete-path');
    f.run().reply();
    const first=f.state.engineeringNavigation!;
    expect(first.compositionSearch.every(r=>r.subtitle.includes('空间推断'))).toBe(true);
    expect([...first.composition.nodes.values()].some(n=>n.kind==='group'&&n.inferred)).toBe(true);
    expect(first.sourceNodes).toBe(base.sourceNodes);expect(first.inventory).toBe(base.inventory);
    expect(f.state.engineeringExpandedRows.composition).toEqual(new Set([base.composition.rootKey]));
    f.run().reply();expect(f.state.engineeringNavigation!.compositionSearch).toEqual(first.compositionSearch);
    expect(f.state.engineeringSnapshot).toBe(snapshot);expect(JSON.stringify(snapshot)).toBe(before);expect(f.state.engineeringSources).toBe(sources);
    f.state.ifcRegionalRuntimes.clear();f.run();expect(f.state.engineeringNavigation).toBe(base);
  }finally{f.dispose();}
});

it('rejects workers superseded during debounce, snapshot replacement, project switch and disposal',async()=>{
  const f=await fixture(),base=f.state.engineeringNavigation;
  const first=f.run();f.state.engineeringGeometryEvidenceChanged?.();first.reply();expect(f.state.engineeringNavigation).toBe(base);
  vi.advanceTimersByTime(500);const second=ProjectionWorker.instances[ProjectionWorker.instances.length-1];
  f.state.engineeringSnapshot={...f.state.engineeringSnapshot!};second.reply();expect(f.state.engineeringNavigation).toBe(base);
  const third=f.run();f.state.activateProject(2,'other');third.reply();expect(f.state.engineeringNavigation).toBe(base);
  f.dispose();third.reply();expect(f.state.engineeringNavigation).toBe(base);expect(third.terminate).toHaveBeenCalled();
});

it('clears a vanished group range and rebinds an existing entity without fitting or refinement',async()=>{
  const f=await fixture();
  try {
    const request=f.state.beginSelection({kind:'engineering-group',key:'vanished'});
    f.state.onlySelected=true;
    f.state.engineeringSelection={requestId:request.id,snapshot:f.state.engineeringSnapshot!,ownerIds:new Set(),sourceIds:new Set(['s']),devRoots:new Set(['root']),ifc:[]};
    f.state.representationSelection={requestId:request.id,devRoots:new Set(['root']),ifc:[],isCurrent:()=>true};
    await reconcileProjectionSelection(f.state);
    expect(f.state.onlySelected).toBe(false);expect(f.state.engineeringSelection).toBeNull();expect(f.state.representationSelection).toBeNull();
    expect(f.state.selectionRequest?.target).toBeNull();expect(clearEngineeringHighlight).toHaveBeenCalled();
    const entity=f.state.engineeringSnapshot!.entities[0],next=f.state.beginSelection({kind:'engineering',key:entity.id});
    await reconcileProjectionSelection(f.state);
    expect(selectEngineeringTarget).toHaveBeenLastCalledWith(f.state,{kind:'engineering',key:entity.id},next,{fit:false,load:false});
  }finally{f.dispose();}
});

it('keeps the semantic view usable if the projection worker cannot start or returns an error',async()=>{
  const f=await fixture(),base=f.state.engineeringNavigation,log=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
    f.run().reply();expect(f.state.engineeringNavigation).not.toBe(base);
    const owned=f.run();owned.onmessage?.({data:{error:'projection failed'}} as MessageEvent);
    expect(f.state.engineeringNavigation).toBe(base);
    vi.stubGlobal('Worker',class{constructor(){throw Error('worker unavailable');}});
    expect(()=>f.run()).not.toThrow();expect(f.state.engineeringNavigation).toBe(base);
    expect(f.state.engineeringSnapshot).not.toBeNull();expect(log).toHaveBeenCalledTimes(2);
  }finally{f.dispose();log.mockRestore();}
});
