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
    unresolvedReferences:graph.references.filter(r=>r.status!=='resolved').length,complete:sources.complete,organizationInvariant:true,geometryInvariant:true,sourceOrderInvariant:true});
});
afterAll(()=>{const out=resolve('../output/v020-stage1');mkdirSync(out,{recursive:true});writeFileSync(join(out,'sample-separation.json'),JSON.stringify({complete:results.length===4,scope:'Four actual substation packages: source identity, extraction, partition, projection, organization/geometry independence; not native rendering or entity goldens',samples:results},null,2));});
