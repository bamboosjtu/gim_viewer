// Single-file production importer smoke; no project cache or full-station load.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { transformSync } from 'esbuild';
import { IfcImporter } from '@thatopen/fragments';
const require=createRequire(import.meta.url),[source,output]=process.argv.slice(2);
const helper=readFileSync(new URL('../../src/viewer/ifcOpeningPolicy.ts',import.meta.url),'utf8');
const {omitIfcOpeningRelations}=await import('data:text/javascript;base64,'+Buffer.from(transformSync(helper,{loader:'ts',format:'esm'}).code).toString('base64'));
const bytes=new Uint8Array(readFileSync(source)),prepare=performance.now(),removedRelations=omitIfcOpeningRelations(bytes),preparationMs=performance.now()-prepare;
const importer=new IfcImporter();importer.wasm={path:dirname(require.resolve('web-ifc'))+'/',absolute:true};importer.webIfcSettings={COORDINATE_TO_ORIGIN:false};
let last=performance.now();const started=performance.now();
const converted=await importer.process({bytes,progressCallback:progress=>{if(performance.now()-last>10000){console.log(JSON.stringify({progress,elapsedMs:performance.now()-started}));last=performance.now();}}});
const result={policy:'omit-rel-voids',removedRelations,preparationMs,importerMs:performance.now()-started,fragmentBytes:converted.byteLength,sourceBytes:bytes.byteLength,rss:process.memoryUsage().rss};
writeFileSync(resolve(output),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
