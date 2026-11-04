import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { extractEngineeringSourceGraph } from '../../src/gim/engineering/sourceGraph.js';
import { buildEngineeringSources, normalizeEngineeringSources } from '../../src/gim/engineering/buildSources.js';
import { collectSourceGeometryOccurrences } from '../../src/gim/engineering/geometryOccurrences.js';
import { SubstationSpatialIndexBuilder } from '../../src/gim/ifcSpatialParser.js';
import { createIfcModelId } from '../../src/gim/modelIdentity.js';
import { projectEngineeringNavigation } from '../../src/gim/engineering/navigation.js';
import { assertEngineeringNavigation, encodeEngineeringNavigation, decodeEngineeringNavigation } from '../../src/services/engineeringNavigationCache.js';
import { encodeEngineeringSources, decodeEngineeringSources, encodeEngineeringEntities, decodeEngineeringEntities } from '../../src/services/engineeringCacheCodec.js';
import { ENGINEERING_CATEGORY_LABELS } from '../../src/engineering/catalogLabels.js';

const hash=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex');
const digest=(data:unknown)=>hash(JSON.stringify(data));
const results:Array<Record<string,unknown>>=[];
function pathsAt(folder:string,prefix=''):string[]{return readdirSync(folder,{withFileTypes:true}).flatMap(e=>e.isDirectory()?pathsAt(join(folder,e.name),`${prefix}${e.name}/`):e.name.startsWith('.gim-')?[]:[`${prefix}${e.name}`]);}

for(const [sample,folder,packageName] of [
  ['s01','demo-substation','substation01.gim'],['s02','substation02','substation02.gim'],
  ['s03','substation03','substation03.gim'],['s04','substation04','substation04.gim'],
])it(`${sample}: separates raw organization, entities, geometry and all three projections`,async()=>{
  const packageBytes=readFileSync(resolve('../demo',packageName)),sha=hash(packageBytes),root=resolve('../demo',folder);
  expect(packageBytes.subarray(0,7).toString('ascii')).toBe('GIMPKGS');
  expect(readFileSync(join(root,'.gim-source.sha256'),'utf8').trim()).toBe(sha);
  const entries=pathsAt(root),graph=await extractEngineeringSourceGraph({paths:entries,readText:async path=>{
    const bytes=readFileSync(join(root,path));try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('gb18030',{fatal:true}).decode(bytes);}
  }});
  const catalog=collectSourceGeometryOccurrences(graph),builder=new SubstationSpatialIndexBuilder(null);
  for(const path of graph.ifcPaths)builder.addIfcModel({modelId:createIfcModelId(path),path,name:path},readFileSync(join(root,path),'utf8'));
  const spatial=builder.finalize();expect(spatial.models.filter(m=>m.parseError)).toEqual([]);
  const {sources,snapshot}=buildEngineeringSources(sha,graph,spatial.objects,spatial.models,spatial.nodes);
  const view=projectEngineeringNavigation(sources,snapshot);assertEngineeringNavigation(view,sources,snapshot);
  expect(snapshot.memberships).toHaveLength(graph.records.length+spatial.objects.length);
  expect(view.sourceRows.size).toBe(snapshot.memberships.length);
  expect(view.composition.nodes.get(view.composition.rootKey)?.entityCount).toBe(snapshot.entities.length);
  expect([...view.composition.nodes.values()].every(n=>!n.inferred)).toBe(true);
  expect(snapshot.entities.every(e=>!!ENGINEERING_CATEGORY_LABELS[e.category])).toBe(true);
  expect(view.inventory!.rowsBySource.size).toBe(snapshot.memberships.length);
  expect(view.inventorySearch).toHaveLength(snapshot.entities.length+snapshot.pending.length);
  expect(view.inventory!.nodes.get(view.inventory!.rootKey)!.children.map(key=>view.inventory!.nodes.get(key)!.title)).toEqual(['设备','装置性材料','构件','其他']);
  const neutralSets=snapshot.memberships.filter(m=>m.interpretation.meaning==='neutral_set');
  let attachmentCorrections:Record<string,number>|undefined;
  expect(view.inventory!.nodes.get(view.inventory!.rootKey)?.attachmentCount??0).toBe(neutralSets.length);
  if(sample==='s01'){
    expect(neutralSets).toHaveLength(6);
    for(const member of neutralSets){
      expect(member.interpretation).toMatchObject({category:'E01',subtype:'neutral_set',classificationStatus:'confirmed'});
      expect(snapshot.pending.find(p=>p.id===member.ownerId)?.reason).toBe('neutral_set_main_unresolved');
      const titles:string[]=[];
      for(let key:string|undefined=view.inventory!.rowsByEntity.get(member.ownerId!)![0];key;key=view.inventory!.nodes.get(key)?.parent)titles.unshift(view.inventory!.nodes.get(key)!.title);
      expect(titles.slice(1,5)).toEqual(['设备','主变压器','附件（并入本体）','中性点成套装置']);
    }
    const memberships=new Map(snapshot.memberships.map(m=>[m.sourceId,m])),entities=new Map(snapshot.entities.map(e=>[e.id,e]));
    const records=new Map([...graph.records,...sources.ifcRecords].map(r=>[r.id,r]));
    const actuators=graph.records.filter(r=>r.name==='操动机构箱');expect(actuators).toHaveLength(3);
    for(const r of actuators){const m=memberships.get(r.id)!;expect(m.ownerId).toBe(memberships.get(r.parent)!.ownerId);expect(m.interpretation).toMatchObject({meaning:'part',basis:'equipment_actuator_composition',independent:false});expect(entities.get(m.ownerId!)?.category).toBe('E05');}
    const terminals=graph.records.filter(r=>/端子箱/.test(r.name)&&records.has(r.parent)&&memberships.get(r.parent)!.interpretation.category==='E10');expect(terminals).toHaveLength(12);
    for(const r of terminals){const m=memberships.get(r.id)!;expect(m.ownerId).toBe(memberships.get(r.parent)!.ownerId);expect(m.interpretation.meaning).toBe('part');}
    const independent=sources.ifcRecords.filter(r=>/端子箱模型01:Null:275431[79]/.test(r.name));expect(independent).toHaveLength(2);
    for(const r of independent){expect(r.parent).toBe('');const m=memberships.get(r.id)!;expect(entities.get(m.ownerId!)?.category).toBe('E16.terminal_box');expect(entities.get(m.ownerId!)?.sourceIds).toEqual([r.id]);}
    const sprinklers=sources.ifcRecords.filter(r=>/喷淋头/.test(r.name));expect(sprinklers).toHaveLength(80);
    expect(sprinklers.filter(r=>/边墙型.*ZSTB-/.test(r.name))).toHaveLength(76);
    for(const r of sprinklers)expect(memberships.get(r.id)!.interpretation.category,r.name).toBe('C-D5');
    const secondary=snapshot.entities.filter(e=>e.category==='E16'&&e.subtype==='unresolved');
    for(const e of secondary){const row=view.inventory!.nodes.get(view.inventory!.rowsByEntity.get(e.id)![0])!;const titles=[];for(let key=row.parent;key;){const node=view.inventory!.nodes.get(key);if(!node)break;titles.push(node.title);key=node.parent;}expect(titles).toContain('二次设备');}
    attachmentCorrections={gisActuatorsJoined:actuators.length,capacitorTerminalsJoined:terminals.length,standaloneTerminals:independent.length,sprinklersClassified:sprinklers.length,genericSecondaryDirect:secondary.length};
  }
  const changed={...sources,graph:{...graph,documents:graph.documents.map(doc=>({...doc,fields:doc.fields.map(field=>/^SYSTEMNAME\d*$/i.test(field.keys[0])?{...field,value:'99号备用主变系统'}:field)}))}};
  expect(digest(normalizeEngineeringSources(sha,changed))).toBe(digest(snapshot));
  expect(collectSourceGeometryOccurrences(changed.graph)).toEqual(catalog);
  expect(digest(normalizeEngineeringSources(sha,{...sources,graph:{...graph,records:[...graph.records].reverse()}}))).toBe(digest(snapshot));
  // One full real-source roundtrip is sufficient to exercise the new evidence
  // schema. Larger packages are covered by raw extraction and partition checks.
  if(sample==='s04'){
    const identity={sourceSha256:sha,parserVersion:'phase1-separation',entries};
    const encoded=await encodeEngineeringSources(sources,identity),restored=await decodeEngineeringSources(encoded.bytes,identity);
    expect(normalizeEngineeringSources(sha,restored.sources)).toEqual(snapshot);
    const entityBytes=await encodeEngineeringEntities(snapshot,restored,identity);
    expect(await decodeEngineeringEntities(entityBytes,restored,identity)).toEqual(snapshot);
    const navBytes=await encodeEngineeringNavigation(view,sources,snapshot,restored.digest,identity);
    expect(await decodeEngineeringNavigation(navBytes,sources,snapshot,restored.digest,identity)).toEqual(view);
  }
  results.push({sample,sha,magic:'GIMPKGS',files:entries.length,sourceVersion:sources.version,rulesVersion:snapshot.rulesVersion,navigationVersion:view.version,compositionVersion:view.composition.version,
    devOccurrences:graph.records.length,geometryRoots:catalog.occurrences.length,ifcProducts:spatial.objects.length,entities:snapshot.entities.length,pending:snapshot.pending.length,
    unresolvedReferences:graph.references.filter(r=>r.status!=='resolved').length,complete:sources.complete,organizationInvariant:true,geometryInvariant:true,sourceOrderInvariant:true,
    projectionVersions:view.projectionVersions,categoryCounts:Object.fromEntries([...new Set(snapshot.entities.map(e=>e.category))].sort().map(c=>[c,snapshot.entities.filter(e=>e.category===c).length])),
    subtypes:[...new Set(snapshot.entities.map(e=>e.subtypeLabel).filter(Boolean))].sort(),classificationConflicts:snapshot.entities.reduce((n,e)=>n+e.classificationConflicts,0),neutralSets:neutralSets.length,inventoryAttachmentCount:view.inventory!.nodes.get(view.inventory!.rootKey)?.attachmentCount??0,attachmentCorrections});
});
afterAll(()=>{const out=resolve(process.env.GIM_ENGINEERING_OUTPUT??'../output/v020-stage1');mkdirSync(out,{recursive:true});writeFileSync(join(out,'sample-separation.json'),JSON.stringify({complete:results.length===4,scope:'Four actual substation packages: source identity, extraction, partition, catalog/subtypes, independent projections, organization/geometry independence; not native rendering or entity goldens',samples:results},null,2));});
