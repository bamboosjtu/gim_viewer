import type {AppState} from '../app/state.js';
import type {BufferGeometry,Material,Texture} from 'three';
import {recordHostMemory} from './runtime.js';
import {engineeringSemanticEvidence} from './engineeringEvidence.js';
import {perfIfcPublicationSnapshot,perfProductMomentSnapshot} from '../utils/perfTimings.js';
const n=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:0;

/** Read existing owners/counters only. No parser, source scan, refinement or validation rules. */
export function benchmarkProgress(state:AppState){
  const dev=state.deviceLodRuntime?.diagnostics;
  const ifcPublication=perfIfcPublicationSnapshot();
  const line=state.currentProjectType==='transmission_line';
  const linePersistence=state.lineCachePersistence;
  const moments=perfProductMomentSnapshot(),spatialMoment=moments.spatialSemanticReady;
  const backgroundStatus=state.currentProjectType!=='substation'||state.currentIfcEntries.length===0?'not-applicable'
    :spatialMoment===null?'pending':spatialMoment.meta?.available===false?'failed':'ready';
  const cachePersistenceStatus=state.currentProjectType!=='substation'?'not-applicable':
    moments.cachePersistenceReady?.meta?.available===false?'failed':moments.cachePersistenceReady?'ready':'not-observed';
  const backgroundSettled=backgroundStatus!=='pending';
  const semantic=line?!!state.currentGimGraph:state.currentProjectType==='equipment'?!!state.currentCbmTree:state.engineeringStatus==='ready'||state.engineeringStatus==='partial';
  const baseSettled=dev?dev.baseRepresentationsSettled===true:!state.ifcBackgroundPending&&state.loadedModels.size===state.currentIfcEntries.length;
  return {semantic,automaticSettled:semantic&&!state.ifcBackgroundPending&&(line||baseSettled)&&n(dev?.pending)===0&&n(dev?.viewPendingOccurrences)===0,
    backgroundSettled,backgroundStatus,cachePersistenceStatus,
    cacheSettled:(!dev||dev.cacheWritesSettled===true)&&!['loading','saving'].includes(state.engineeringCacheStatus)&&ifcPublication.settled>=state.currentIfcEntries.length
      &&(!line||linePersistence==='saved'||linePersistence==='failed'||linePersistence==='not-applicable'),
    workload:{cbmNodes:state.cbmNodeIndex.size,lineNodes:state.currentGimGraph?.nodesByPath.size??0,
      sources:state.engineeringSnapshot?.memberships.length??0,entities:state.engineeringSnapshot?.entities.length??0,
      ifcSources:state.currentIfcEntries.length,loadedIfcSources:state.loadedModels.size,
      connectionObjects:n(state.substationConnectionPreview?.diagnostics?.objects),
      occurrences:n(dev?.occurrences),devSources:n(dev?.uniqueDevSources),shown:n(dev?.shown),failed:n(dev?.failedOccurrences),empty:n(dev?.emptyOccurrences),partial:n(dev?.partialOccurrences),unsupported:n(dev?.unsupportedOccurrences),
      pending:n(dev?.pending),sourcePlacementWarnings:n(dev?.sourcePlacementWarnings)},
    cache:{engineering:state.engineeringCacheStatus,linePersistence,devCatalogHits:n(dev?.catalogHits),devLodHits:dev?.lodHits??[],devLodMisses:dev?.lodMisses??[],
      writePending:n(dev?.cacheWritePendingCount),writeFailures:n(dev?.artifactWriteFailures)+n(dev?.catalogWriteFailures)+ifcPublication.failed+(linePersistence==='failed'?1:0),readFailures:n(dev?.cacheReadErrorCount)},
  };
}
async function hash(value:unknown){const bytes=new TextEncoder().encode(JSON.stringify(value));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');}
async function geometryEvidence(state:AppState){
  const rows:unknown[]=[];const geometries=new Set<BufferGeometry>(),materials=new Set<Material>(),textures=new Set<Texture>(),buffers=new Set<ArrayBufferLike>();
  let roots=0,meshes=0,finite=true,missingBounds=0;
  const round=(values:readonly number[])=>values.map(v=>{if(!Number.isFinite(v))finite=false;return Math.round(v*1e6)/1e6;});
  state.deviceLodRuntime?.forEachLoadedRoot?.((id,root,lod)=>{
    roots++;const parts:unknown[]=[];
    root.traverse(object=>{
      const mesh=object as unknown as {geometry?:BufferGeometry;material?:Material|Material[]};if(!mesh.geometry)return;
      const g=mesh.geometry;meshes++;
      if(!geometries.has(g)){
        geometries.add(g);for(const a of Object.values(g.attributes)){const value=a.array;if(value)buffers.add(value.buffer);}if(g.index)buffers.add(g.index.array.buffer);
      }
      for(const m of Array.isArray(mesh.material)?mesh.material:mesh.material?[mesh.material]:[]){
        if(materials.has(m))continue;materials.add(m);
        for(const value of Object.values(m))if(value&&typeof value==='object'&&(value as Texture).isTexture)textures.add(value as Texture);
      }
      if(!g.boundingBox)missingBounds++;
      parts.push([g.getAttribute('position')?.count??0,g.index?.count??0,g.boundingBox?round([...g.boundingBox.min.toArray(),...g.boundingBox.max.toArray()]):null,round(object.matrixWorld.elements)]);
    });rows.push([id,lod,parts]);
  });
  let bytes=0;for(const buffer of buffers)bytes+=buffer.byteLength;
  const available=!!state.deviceLodRuntime?.forEachLoadedRoot;
  recordHostMemory({name:'dev-geometry-cpu-buffer-capacity',scope:'graphics',method:'unique-three-backing-buffers',quality:'measured-capacity',availability:available?'available':'not-applicable',bytes:available?bytes:null,sampleDelayMs:0});
  return {scope:'DEV-representations-only',available,roots,meshes,geometries:geometries.size,materials:materials.size,textures:textures.size,cpuBufferBytes:bytes,
    gpuBytes:null,gpuAvailability:'unsupported',finite,missingBounds,structuralFingerprint:available?await hash(rows.sort()):null,
    fingerprintKind:'structural-counts-bounds-transforms',quantizationMetres:1e-6};
}
export async function benchmarkEvidence(state:AppState){
  const session=state.captureProjectSession(),snapshot=state.engineeringSnapshot,progress=benchmarkProgress(state);
  const sources=state.engineeringSources;
  const referenceStatuses:Record<string,number>={};
  for(const reference of sources?.graph.references??[])referenceStatuses[reference.status]=(referenceStatuses[reference.status]??0)+1;
  const canonicalIfc=(path:string)=>path.replace(/\\/g,'/').toLowerCase();
  const archiveIfc=new Set((sources?.graph.ifcPaths??[]).map(canonicalIfc));
  const spatialIfc=new Set((sources?.models??[]).map(model=>canonicalIfc(model.path)));
  const ifcManifest=sources?{
    archiveSources:archiveIfc.size,spatialModels:sources.models.length,
    missing:[...archiveIfc].filter(path=>!spatialIfc.has(path)).length,
    extra:[...spatialIfc].filter(path=>!archiveIfc.has(path)).length,
    duplicate:sources.models.length-spatialIfc.size,
    parseErrors:sources.models.filter(model=>!!model.error).length,
  }:null;
  const engineeringCoverage=state.currentProjectType==='substation'?{
    complete:sources?.complete??null,incompleteReasons:[...(sources?.incompleteReasons??[])].sort(),
    referenceStatuses,graphDiagnostics:sources?.graph.diagnostics.length??null,
    ifcManifest,
    sourceCount:progress.workload.sources,entityCount:progress.workload.entities,
    pendingEntityCount:snapshot?.pending.length??null,
  }:null;
  const geometryDiagnostics={templates:state.geometryDiagnosticsByDevPath.size,statuses:{} as Record<string,number>,nonFailureReasons:{} as Record<string,number>};
  const failedGeometryReasons:Record<string,number>={};
  const partialGeometryReasons:Record<string,number>={};
  const failedSourcePaths:string[]=[];
  let failedVisibleRoots=0,sourceEvidenceComplete=true;
  for(const diagnostic of state.geometryDiagnosticsByDevPath.values()){
    geometryDiagnostics.statuses[diagnostic.status]=(geometryDiagnostics.statuses[diagnostic.status]??0)+1;
    if(diagnostic.status==='failed'){
      const reason=diagnostic.reason??'unknown';failedGeometryReasons[reason]=(failedGeometryReasons[reason]??0)+1;
      failedSourcePaths.push(diagnostic.devPath.replace(/\\/g,'/').toLowerCase());
      failedVisibleRoots+=diagnostic.failedVisibleRootCount??0;
      if(!(reason==='source-invalid'&&diagnostic.detail?.startsWith('source-origin-span-v1')||
        reason==='missing-dependency'&&diagnostic.detail?.startsWith('source-reference-missing-v1')))
        sourceEvidenceComplete=false;
    }else if(diagnostic.reason)geometryDiagnostics.nonFailureReasons[diagnostic.reason]=(geometryDiagnostics.nonFailureReasons[diagnostic.reason]??0)+1;
    if(diagnostic.status==='partial'){
      const causes=[
        Object.values(diagnostic.unsupportedPrimitiveTypeCounts).some(Boolean)?'unsupported-primitive':null,
        (diagnostic.omittedSmallParts??0)>0||(diagnostic.simplifiedBooleans??0)>0?'lod-policy-simplification':null,
        (diagnostic.emptySourceCount??0)>0?'empty-source':null,
      ].filter((reason):reason is string=>!!reason);
      for(const cause of causes.length?causes:['unclassified'])partialGeometryReasons[cause]=(partialGeometryReasons[cause]??0)+1;
    }
  }
  const geometryDefects={failedSourceCount:failedSourcePaths.length,failedSourceSetDigest:failedSourcePaths.length?await hash(failedSourcePaths.sort()):null,
    failedOccurrences:progress.workload.failed,failedVisibleRoots,failedReasons:failedGeometryReasons,sourceEvidenceComplete};
  const checks:{name:string;passed:boolean}[]=[{name:'source-identity',passed:!!session.sourceSha256},{name:'automatic-settled',passed:progress.automaticSettled},{name:'ifc-source-count',passed:progress.workload.loadedIfcSources===progress.workload.ifcSources},
    {name:'no-failed-geometry-occurrences',passed:progress.workload.failed===0},
    {name:'line-cache-persistence',passed:state.currentProjectType!=='transmission_line'||state.lineCachePersistence!=='failed'},
    {name:'background-settled',passed:progress.backgroundSettled}];
  checks.push({name:'background-spatial-available',passed:progress.backgroundStatus!=='failed'});
  let semanticDigest:string|null=null,pendingDigest:string|null=null,pendingCount:number|null=null,pendingSourceCount:number|null=null;
  if(snapshot){
    const sources=new Set(snapshot.memberships.map(row=>row.sourceId)),owners=new Set([...snapshot.entities,...snapshot.pending].map(row=>row.id));
    const engineering=engineeringSemanticEvidence(snapshot);
    checks.push({name:'unique-source-membership',passed:sources.size===snapshot.memberships.length},
      {name:'membership-owner-exists',passed:snapshot.memberships.every(row=>row.ownerId===null||owners.has(row.ownerId))},
      {name:'entity-sources-exist',passed:snapshot.entities.every(row=>row.sourceIds.every(id=>sources.has(id)))},
      ...engineering.checks);
    pendingCount=engineering.pendingCount;pendingSourceCount=engineering.pendingSourceCount;
    pendingDigest=await hash(engineering.pendingRows);
    semanticDigest=await hash(engineering.semanticRows);
  }else if(state.currentGimGraph){semanticDigest=await hash([...state.currentGimGraph.nodesByPath].map(([id,node])=>[id,node.entityName,node.children]).sort());}
  else if(state.currentCbmTree){semanticDigest=await hash([...state.cbmNodeIndex].map(([id,node])=>[id,node.entityName,node.children.map(child=>child.path)]).sort());}
  const placementDigest=state.engineeringGeometryCatalog?await hash(state.engineeringGeometryCatalog.occurrences.map(row=>[row.id,row.devPath,row.placementMatrix]).sort()):null;
  const geometry=await geometryEvidence(state);
  const baseRows=state.deviceLodRuntime?.baseRepresentationEvidence?.()??[];
  const quantize=(values:number[])=>values.map(v=>Math.round(v*1e6)/1e6);
  const baseGeometryDigest=baseRows.length?await hash(baseRows.map(row=>[row.id,quantize(row.bounds),quantize(row.matrix),row.status]).sort()):null;
  const baseArtifactDigest=baseRows.length?await hash(baseRows.map(row=>[row.id,row.sha]).sort()):null;
  const devSources=progress.workload.devSources,shown=progress.workload.shown;
  const missingArtifactSha=baseRows.filter(row=>!/^[a-f0-9]{64}$/i.test(row.sha)).length;
  const duplicateArtifactIds=baseRows.length-new Set(baseRows.map(row=>row.id)).size;
  const contentEvidence={scope:'DEV-L0-GLB-artifacts',method:'worker-output-or-validated-cache-sha256',
    availability:devSources?'available':'not-applicable',coveredOccurrences:baseRows.length,
    expectedShownOccurrences:shown,missingArtifactSha,duplicateArtifactIds,
    digest:baseArtifactDigest,placementFingerprint:baseGeometryDigest,
    complete:devSources===0&&shown===0||shown>0&&baseRows.length===shown&&missingArtifactSha===0&&duplicateArtifactIds===0&&
      baseArtifactDigest!==null&&baseGeometryDigest!==null};
  if(state.deviceLodRuntime)checks.push({name:'geometry-evidence-available',passed:geometry.available},{name:'finite-geometry-transforms',passed:geometry.finite},{name:'represented-root-count',passed:geometry.roots===progress.workload.shown});
  let cache:Record<string,unknown>|null=null;
  if(state.currentProjectId!==null){
    const {getProjectDiagnostic}=await import('@desktop/database.js');const d=await getProjectDiagnostic(state.currentProjectId);
    cache={sourceMatches:d.sha256===session.sourceSha256,entries:d.entries_count,semanticValid:d.substation_semantic_cache_valid,
      linePack:d.project_type==='transmission_line'?d.line_semantic_pack_status:'uncommitted',
      linePackAssessment:d.project_type==='transmission_line'?d.line_semantic_pack_status:'uncommitted',
      projectTypeCommitted:d.project_type==='transmission_line',linePersistence:state.lineCachePersistence,
      ifcEntries:d.ifc_entry_count,cachedIfc:d.cached_ifc_count,missingIfc:d.missing_cache_paths.length,parserMatches:d.parser_version_match};
  }
  if(cache&&state.loadedModels.size){
    const {peekViewerRuntime}=await import('../viewer/viewerRuntime.js');const viewer=await peekViewerRuntime();
    cache.ifcFarHits=viewer?[...state.loadedModels.values()].filter(row=>viewer.ctx.fragments.list.get(row.runtimeModelId)?.object.userData.ifcLodCacheHit===true).length:0;
  }
  checks.push({name:'session-stable',passed:state.isCurrentSession(session)},{name:'cache-source-matches',passed:cache?.sourceMatches===true});
  return {version:'gim-runtime-evidence-v1',scope:'runtime-regression-invariants-not-standard-compliance',projectType:state.currentProjectType,
    engineeringCoverage,checks,semanticDigest,semanticDigestScope:snapshot?'engineering-with-pending-v2':'format-projection-v1',
    pendingDigest,pendingCount,pendingSourceCount,placementDigest,
    progress,cache,geometry,geometryDiagnostics,geometryStatuses:geometryDiagnostics.statuses,
    failedGeometryReasons,partialGeometryReasons,geometryDiagnosticScope:'requested-templates-only',geometryDefects,
    geometryStructuralFingerprint:geometry.structuralFingerprint,contentEvidence,
    baseGeometryDigest,baseArtifactDigest,baseEvidenceCount:baseRows.length,sourceSha256:session.sourceSha256,passed:checks.every(c=>c.passed)};
}
