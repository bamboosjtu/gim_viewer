// Reads only this tool and its own npm dependencies. Never reads the viewer.
import {build} from 'esbuild';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),out=path.join(root,'assets/node');
await mkdir(out,{recursive:true});
const common={bundle:true,platform:'node',target:'node22',mainFields:['module','main'],logLevel:'info',legalComments:'eof',metafile:true};
const result=await build({...common,format:'esm',entryPoints:[path.join(root,'engine/export_gim.mts')],outfile:path.join(out,'export_gim.mjs')});
for(const input of Object.keys(result.metafile.inputs)){
 const full=path.resolve(input);
 if(!full.startsWith(root+path.sep))throw Error('Compiler input outside standalone tool: '+full);
}
for(const name of ['export_ifc','probe_ifc_bounds'])await build({...common,format:'cjs',external:['web-ifc'],entryPoints:[path.join(root,'assets/scripts',name+'.cjs')],outfile:path.join(out,name+'.cjs')});
await cp(path.join(root,'node_modules/web-ifc'),path.join(out,'node_modules/web-ifc'),{recursive:true});
const notices=[];
for(const name of ['three','three-bvh-csg','three-mesh-bvh','fast-xml-parser','web-ifc']){
 const pkg=JSON.parse(await readFile(path.join(root,'node_modules',name,'package.json'),'utf8'));
 notices.push({name,version:pkg.version,license:pkg.license});
 for(const file of ['LICENSE','LICENSE.md','LICENSE.txt'])try{await cp(path.join(root,'node_modules',name,file),path.join(out,name+'-'+file));}catch(e){if(e.code!=='ENOENT')throw e;}
}
await writeFile(path.join(out,'dependencies.json'),JSON.stringify({version:1,dependencies:notices},null,2));
