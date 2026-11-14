/** Developer-local export of the current application algorithm. The standalone
 * tools never import or invoke this adapter. No renderer or SDK is constructed. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer as createHttpServer} from 'node:http';
import {createServer} from 'vite';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),args=process.argv.slice(2);
const option=key=>args[args.indexOf(key)+1];
if(!args.includes('--source-dir')||!args.includes('--out'))throw Error('--source-dir and --out required');
if(process.env.CI)throw Error('Engineering package verification is developer-local only');
const directory=path.resolve(option('--source-dir')),out=path.resolve(option('--out'));
if(!out.startsWith(path.join(root,'tmp')+path.sep)&&!out.startsWith(path.join(root,'output')+path.sep))throw Error('Output must remain in workspace tmp/output');
for(const name of ['TEMP','TMP','TMPDIR'])process.env[name]=path.join(root,'tmp');
const files=new Map();
async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Linked package entries unsupported');
  if(entry.isDirectory())await walk(file);else if(entry.isFile())files.set(path.relative(directory,file).replaceAll('\\','/'),file);
}}
await walk(directory);await fs.mkdir(path.dirname(out),{recursive:true});
const http=createHttpServer(),server=await createServer({configFile:false,root:path.join(root,'desktop'),cacheDir:path.join(root,'tmp/engineering-export-vite'),server:{middlewareMode:true,hmr:{server:http},watch:{ignored:['**/*']}}});
try{
  const {decodeGimText}=await server.ssrLoadModule('/src/shared/textDecode.ts');
  const {extractEngineeringSourceGraph,engineeringSourceRecords}=await server.ssrLoadModule('/src/gim/engineering/sourceGraph.ts');
  const {buildCbmTree}=await server.ssrLoadModule('/src/gim/cbmParser.ts');
  const {SubstationSpatialIndexBuilder}=await server.ssrLoadModule('/src/gim/ifcSpatialParser.ts');
  const {createIfcModelId}=await server.ssrLoadModule('/src/gim/modelIdentity.ts');
  const {collectEngineeringSources,normalizeEngineeringSources}=await server.ssrLoadModule('/src/gim/engineering/buildSources.ts');
  const {collectSourceGeometryOccurrences}=await server.ssrLoadModule('/src/gim/engineering/geometryOccurrences.ts');
  const readText=async p=>decodeGimText(await fs.readFile(files.get(p))).text;
  const graph=await extractEngineeringSourceGraph({paths:[...files.keys()],readText});
  const map=new Map([...files].filter(([p])=>/\.(?:cbm|dev|fam)$/i.test(p)).map(([p,file])=>[p,{name:p,text:()=>readText(p),arrayBuffer:async()=>{const bytes=await fs.readFile(file);return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}}]));
  const fields=JSON.parse(await fs.readFile(path.join(root,'desktop/src/gim/engineering/recognitionFields.json'),'utf8'));
  const tree=await buildCbmTree(map),builder=new SubstationSpatialIndexBuilder(tree,[],undefined,fields);
  for(const p of graph.ifcPaths){const bytes=await fs.readFile(files.get(p));builder.addIfcModel({path:p,name:path.basename(p),modelId:createIfcModelId(p)},decodeGimText(bytes).text,bytes.length);}
  const index=builder.finalize(),sources=collectEngineeringSources(graph,index.objects,index.models,index.nodes),snapshot=normalizeEngineeringSources(option('--scope')??'local-export',sources);
  const records=engineeringSourceRecords(graph,sources.ifcRecords).map(r=>({id:r.id,track:r.track,source:r.source,name:r.name,parent:r.parent,source_type:r.source_type,attributeOnly:r.attributeOnly??false}));
  await fs.writeFile(out,JSON.stringify({schema:'gim-engineering-local-export-v1',snapshot,records,physicalOccurrences:collectSourceGeometryOccurrences(graph),complete:sources.complete,incompleteReasons:sources.incompleteReasons}));
  console.log(JSON.stringify({records:records.length,entities:snapshot.entities.length,pending:snapshot.pending.length,physicalRoots:collectSourceGeometryOccurrences(graph).occurrences.length}));
}finally{await server.close();http.close();}
