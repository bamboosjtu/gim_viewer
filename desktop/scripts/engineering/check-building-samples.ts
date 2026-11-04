/** Reproducible building-composition samples from demo/substation02/03/04.
 * Run from desktop/: npx vite-node scripts/engineering/check-building-samples.ts
 * This is a source-level projection check; native rendering/LOD is out of scope. */
import {readFileSync,readdirSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {extractEngineeringSourceGraph} from '../../src/gim/engineering/sourceGraph.js';
import {SubstationSpatialIndexBuilder} from '../../src/gim/ifcSpatialParser.js';
import {createIfcModelId} from '../../src/gim/modelIdentity.js';
import {buildEngineeringSources} from '../../src/gim/engineering/buildSources.js';
import {projectEngineeringNavigation} from '../../src/gim/engineering/navigation.js';

const root=resolve('..');
function files(dir:string,base=dir,result:string[]=[]):string[]{
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);
    if(entry.isDirectory())files(path,base,result);
    else if(/\.(?:cbm|dev|fam|ifc)$/i.test(entry.name))result.push(relative(base,path).replace(/\\/g,'/'));
  }
  return result;
}
function assert(condition:unknown,message:string):void{if(!condition)throw Error(message);}
for(const sample of ['substation02','substation03','substation04']){
  const dir=join(root,'demo',sample),paths=files(dir);
  const graph=await extractEngineeringSourceGraph({paths,readText:async path=>readFileSync(join(dir,path),'utf8')});
  const builder=new SubstationSpatialIndexBuilder(null);
  for(const ifc of graph.ifcPaths)builder.addIfcModel({modelId:createIfcModelId(ifc),path:ifc,name:ifc},readFileSync(join(dir,ifc),'utf8'));
  const spatial=builder.finalize();
  const built=buildEngineeringSources(sample,graph,spatial.objects,spatial.models,spatial.nodes);
  const view=projectEngineeringNavigation(built.sources,built.snapshot);
  const buildings=[...view.composition.nodes.values()].filter(node=>node.kind==='group'&&/\/building:[^/]+$/.test(node.key));
  const titles=buildings.map(node=>node.title);
  if(sample==='substation02')assert(titles.join('|')==='消防泵房|配电楼|警传室',`s02 buildings: ${titles.join(',')}`);
  if(sample==='substation03')assert(buildings.length===2&&buildings.every(node=>node.entityCount===0&&node.unbound),'s03 declared groups must be unbound');
  if(sample==='substation04')assert(titles.join('|')==='辅助用房|配电楼'&&!titles.includes('配电室'),`s04 buildings: ${titles.join(',')}`);
  console.log(sample,JSON.stringify(buildings.map(node=>({title:node.title,count:node.entityCount,unbound:!!node.unbound}))));
}
