import { afterEach, expect, it, vi } from 'vitest';
import { AppState } from '../../../app/state.js';
import { extractEngineeringSourceGraph } from '@gim/gim-sdk/source';
import {buildTestEngineeringSources} from '@tests/sdk-source-fixtures';
import { projectEngineeringNavigation } from '@gim/gim-sdk/projection';
import { projectEngineeringComposition } from '@gim/gim-sdk/projection';
import type { IfcSpatialObject } from '../../../gim/ifcSpatialParser.js';
import { installCompositionProjection, reconcileProjectionSelection } from '../compositionProjectionService.js';
import { projectSpatialComposition } from '../compositionSpatial.js';
import type { ProjectionInput } from '../../../infrastructure/workers/compositionProjectionWorker.js';
import { selectEngineeringTarget, clearEngineeringHighlight } from '../engineeringSelection.js';
import { EngineeringWorkerClient } from '../../../infrastructure/workers/engineeringWorkerClient.js';
import { measurementWorkerTask } from '../../../measurement/hostWorker.js';
import { measurementSnapshot, resetMeasurementRun } from '../../../measurement/runtime.js';

vi.mock('../engineeringSelection.js',()=>({selectEngineeringTarget:vi.fn(async()=>true),clearEngineeringHighlight:vi.fn(async()=>{})}));
vi.mock('../../../ui/propsDrawer.js',()=>({renderInspectorTabs:vi.fn(),sectionHtml:vi.fn(()=> '')}));

class ProjectionWorker extends EventTarget {
  static instances: ProjectionWorker[]=[];
  input!: ProjectionInput;
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: ErrorEvent) => void;
  terminate=vi.fn();
  constructor(){super();ProjectionWorker.instances.push(this);}
  postMessage(input:unknown){
    if(input && typeof input==='object' && 'snapshot' in input)this.input=input as ProjectionInput;
  }
  reply(){
    const assignments=projectSpatialComposition(this.input.snapshot,this.input.facts,this.input.bounds);
    this.onmessage?.({data:{composition:projectEngineeringComposition(this.input.snapshot,assignments,'工程组成',this.input.declarations),contexts:assignments.map(a=>[a.entityId,a.paths.map(p=>p.map(g=>g.title).join('/')).join('；')])}} as MessageEvent);
  }
}
async function fixture(){
  const state=new AppState();state.activateProject(1,'p');
  const graph=await extractEngineeringSourceGraph({paths:['project.cbm','建筑.ifc'],readText:async()=>''});
  const objects:IfcSpatialObject[]=['墙','楼板','柱'].map((name,i)=>({key:`m#${i+1}`,modelId:'m',expressId:i+1,ifcType:['IFCWALL','IFCSLAB','IFCCOLUMN'][i],name,globalId:`g${i}`,geometryStatus:'unrepresented',parentObjectKey:null,childObjectKeys:[],relationshipCount:0,hostObjectKey:null,spatialKey:null,spatialKeys:[],spatialContainment:null,sourcePath:'建筑.ifc'}));
  const built=buildTestEngineeringSources('p',graph,objects,[]);
  built.sources.incompleteReasons=[];state.engineering.status='ready';built.sources.models=[{modelId:'m',path:'建筑.ifc'}];state.engineering.snapshot=built.snapshot;state.engineering.sources=built.sources;
  state.engineering.navigation=projectEngineeringNavigation(built.sources,built.snapshot);
  state.ifc.regionalRuntimes.set('m',{index:{objects:objects.map(o=>({...o,bounds:[0,0,-10,10,4,0]}))},release:vi.fn()} as never);
  vi.useFakeTimers();ProjectionWorker.instances=[];vi.stubGlobal('Worker',ProjectionWorker);
  const dispose=installCompositionProjection(state);
  const run=()=>{state.engineeringGeometryEvidenceChanged?.();vi.advanceTimersByTime(500);return ProjectionWorker.instances[ProjectionWorker.instances.length-1];};
  return {state,dispose,run};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();resetMeasurementRun({});vi.clearAllMocks();});

it('attributes production engineering and composition tasks to distinct Worker families',async()=>{
  const f=await fixture();
  vi.stubGlobal('__GIM_MEASUREMENT_CONFIG__',{mode:'benchmark'});
  vi.stubGlobal('URL',class extends URL {
    static createObjectURL(){return 'blob:measured-worker-fixture';}
    static revokeObjectURL(){}
  });
  resetMeasurementRun({});
  const engineering=EngineeringWorkerClient.create(()=>true);
  const pending=engineering.init('fixture',[]).catch(error=>error);
  try {
    const worker=ProjectionWorker.instances[0];
    const projection=f.run();
    const mainTask=measurementWorkerTask(worker as unknown as Worker)!;
    const projectionTask=measurementWorkerTask(projection as unknown as Worker)!;
    expect(mainTask.family).toBe('engineering');
    expect(projectionTask.family).toBe('engineering-composition');
    expect(mainTask.workerId).not.toBe(projectionTask.workerId);
    const workers=measurementSnapshot()!.workers;
    expect(workers[mainTask.workerId].family).toBe(mainTask.family);
    expect(workers[projectionTask.workerId].family).toBe(projectionTask.family);
  } finally {engineering.close();f.dispose();await pending;}
});

it('refines only composition, preserves semantic inputs and does not accumulate search text',async()=>{
  const f=await fixture(),snapshot=f.state.engineering.snapshot!,before=JSON.stringify(snapshot),sources=f.state.engineering.sources,base=f.state.engineering.navigation!;
  try {
    f.state.viewState.expanded.composition.add(base.composition.rootKey);
    f.state.viewState.expanded.composition.add('obsolete-path');
    f.run().reply();
    const first=f.state.engineering.navigation!;
    expect(first.compositionSearch.every(r=>r.subtitle.includes('空间推断'))).toBe(true);
    expect([...first.composition.nodes.values()].some(n=>n.kind==='group'&&n.inferred)).toBe(true);
    expect(first.sourceNodes).toBe(base.sourceNodes);expect(first.inventory).toBe(base.inventory);
    expect(f.state.viewState.expanded.composition).toEqual(new Set([base.composition.rootKey]));
    f.run().reply();expect(f.state.engineering.navigation!.compositionSearch).toEqual(first.compositionSearch);
    expect(f.state.engineering.snapshot).toBe(snapshot);expect(JSON.stringify(snapshot)).toBe(before);expect(f.state.engineering.sources).toBe(sources);
    f.state.ifc.regionalRuntimes.clear();f.run();expect(f.state.engineering.navigation).not.toBeNull();
  }finally{f.dispose();}
});

it('does not rebuild a cached navigation projection on warm geometry evidence',async()=>{
  const f=await fixture();
  try {
    f.state.engineering.navigationCacheHit=true;f.state.engineering.navigation!.compositionComplete=true;f.state.engineering.navigation!.compositionCoverage='full';
    f.state.engineeringGeometryEvidenceChanged?.();
    vi.advanceTimersByTime(500);
    expect(ProjectionWorker.instances).toHaveLength(0);
    expect(f.state.engineering.navigation).toBeTruthy();
  } finally { f.dispose(); }
});

it('rejects workers superseded during debounce, snapshot replacement, project switch and disposal',async()=>{
  const f=await fixture(),base=f.state.engineering.navigation;
  const first=f.run();f.state.engineeringGeometryEvidenceChanged?.();first.reply();expect(f.state.engineering.navigation).toBe(base);
  vi.advanceTimersByTime(500);const second=ProjectionWorker.instances[ProjectionWorker.instances.length-1];
  f.state.engineering.snapshot={...f.state.engineering.snapshot!};second.reply();expect(f.state.engineering.navigation).toBe(base);
  const third=f.run();f.state.activateProject(2,'other');third.reply();expect(f.state.engineering.navigation).toBe(base);
  f.dispose();third.reply();expect(f.state.engineering.navigation).toBe(base);expect(third.terminate).toHaveBeenCalled();
});

it('clears a vanished group range and rebinds an existing entity without fitting or refinement',async()=>{
  const f=await fixture();
  try {
    const request=f.state.selection.beginSelection({kind:'engineering-group',key:'vanished'});
    f.state.selection.onlySelected=true;
    f.state.selection.engineeringSelection={requestId:request.id,snapshot:f.state.engineering.snapshot!,ownerIds:new Set(),sourceIds:new Set(['s']),devRoots:new Set(['root']),ifc:[]};
    f.state.selection.representationSelection={requestId:request.id,devRoots:new Set(['root']),ifc:[],isCurrent:()=>true};
    await reconcileProjectionSelection(f.state);
    expect(f.state.selection.onlySelected).toBe(false);expect(f.state.selection.engineeringSelection).toBeNull();expect(f.state.selection.representationSelection).toBeNull();
    expect(f.state.selection.selectionRequest?.target).toBeNull();expect(clearEngineeringHighlight).toHaveBeenCalled();
    const entity=f.state.engineering.snapshot!.entities[0],next=f.state.selection.beginSelection({kind:'engineering',key:entity.id});
    await reconcileProjectionSelection(f.state);
    expect(selectEngineeringTarget).toHaveBeenLastCalledWith(f.state,{kind:'engineering',key:entity.id},next,{fit:false,load:false});
  }finally{f.dispose();}
});

it('keeps the semantic view usable if the projection worker cannot start or returns an error',async()=>{
  const f=await fixture(),base=f.state.engineering.navigation,log=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
    f.run().reply();expect(f.state.engineering.navigation).not.toBe(base);
    const owned=f.run();owned.onmessage?.({data:{error:'projection failed'}} as MessageEvent);
    expect(f.state.engineering.navigation?.compositionCoverage).toBe('partial');
    vi.stubGlobal('Worker',class{constructor(){throw Error('worker unavailable');}});
    expect(()=>f.run()).not.toThrow();expect(f.state.engineering.navigation?.compositionCoverage).toBe('partial');
    expect(f.state.engineering.snapshot).not.toBeNull();expect(log).toHaveBeenCalledTimes(2);
  }finally{f.dispose();log.mockRestore();}
});
it('waits for every IFC range before publishing one complete navigation',async()=>{
 const f=await fixture();try{
  f.state.engineering.treeStatus='loading';f.state.engineering.sources!.models=[{modelId:'m',path:'建筑.ifc'},{modelId:'n',path:'结构.ifc'}];
  f.run();expect(ProjectionWorker.instances).toHaveLength(0);expect(f.state.engineering.treeStatus).toBe('loading');
  f.state.ifc.regionalRuntimes.set('n',{index:{objects:[]},release:vi.fn()} as never);
  f.run().reply();expect(f.state.engineering.treeStatus).toBe('ready');expect(f.state.engineering.navigation!.compositionComplete).toBe(true);
 }finally{f.dispose();}
});
it('reapplies a warm selection as geometry arrives without rebuilding the cached tree',async()=>{
 const f=await fixture();try{
  const view=f.state.engineering.navigation!;view.compositionComplete=true;view.compositionCoverage='full';f.state.engineering.navigationCacheHit=true;
  const target={kind:'engineering' as const,key:f.state.engineering.snapshot!.entities[0].id};f.state.selection.beginSelection(target);
  f.run();await Promise.resolve();expect(ProjectionWorker.instances).toHaveLength(0);expect(f.state.engineering.navigation).toBe(view);
  await vi.waitFor(()=>expect(selectEngineeringTarget).toHaveBeenCalledWith(f.state,target,expect.anything(),{fit:false,load:false}));
 }finally{f.dispose();}
});

it('publishes a partial tree after one IFC is skipped and keeps the source and inventory pages',async()=>{
 const f=await fixture();try{
  f.state.engineering.treeStatus='loading';f.state.engineering.ifcGeometryFinished=true;
  f.state.engineering.sources!.models=[{modelId:'m',path:'建筑.ifc'},{modelId:'n',path:'skipped.ifc'}];
  const ready=vi.fn();f.dispose();
  const dispose=installCompositionProjection(f.state,ready);
  try{
   f.run().reply();
   expect(f.state.engineering.treeStatus).toBe('ready');
   expect(f.state.engineering.navigation?.compositionCoverage).toBe('partial');
   expect(f.state.engineering.navigation?.sourceNodes.size).toBeGreaterThan(0);
   expect(f.state.engineering.navigation?.inventory?.nodes.size).toBeGreaterThan(0);
   expect(ready).toHaveBeenCalledWith(false);
  }finally{dispose();}
 }finally{f.dispose();}
});
