/** Compare two exported composition trees by engineering entity ID and path.
 * Run from desktop/:
 *   npx vite-node scripts/engineering/compare-review-trees.ts static.json runtime.json
 * or set GIM_REVIEW_STATIC / GIM_REVIEW_RUNTIME. Exit code 1 means differences. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

interface Node {title:string;kind:string;targetId?:string;entityCount?:number;children?:Node[]}
interface Tree {schema?:string;sample?:string;root:Node}
type Paths=Map<string,string[]>;
function walk(node:Node,labels:string[],paths:Paths):void{
  const next=[...labels,node.title];
  if(node.targetId)paths.set(node.targetId,next);
  for(const child of node.children??[])walk(child,next,paths);
}
function load(path:string):{tree:Tree;paths:Paths}{
  const tree=JSON.parse(readFileSync(resolve(path),'utf8')) as Tree;
  const paths=new Map<string,string[]>();
  walk(tree.root,[],paths);
  return {tree,paths};
}
const staticPath=process.argv[2]??process.env.GIM_REVIEW_STATIC;
const runtimePath=process.argv[3]??process.env.GIM_REVIEW_RUNTIME;
if(!staticPath||!runtimePath)throw Error('usage: compare-review-trees.ts <static.json> <runtime.json>');
const left=load(staticPath),right=load(runtimePath),missing:string[]=[],extra:string[]=[],mismatch:Array<{entityId:string;static:string[];runtime:string[]}>=[];
for(const [entityId,path] of left.paths){
  const other=right.paths.get(entityId);
  if(!other){missing.push(entityId);continue;}
  if(JSON.stringify(path)!==JSON.stringify(other))mismatch.push({entityId,static:path,runtime:other});
}
for(const entityId of right.paths.keys())if(!left.paths.has(entityId))extra.push(entityId);
const result={schema:'gim-composition-parity-v1',static:staticPath,runtime:runtimePath,staticEntities:left.paths.size,runtimeEntities:right.paths.size,missing,extra,mismatch};
console.log(JSON.stringify(result,null,2));
if(missing.length||extra.length||mismatch.length)process.exitCode=1;
