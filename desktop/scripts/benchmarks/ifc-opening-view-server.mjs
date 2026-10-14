import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory=resolve(process.argv[2]??'../output/playwright/steel-openings');
const files=new Map([
 ['/',''+fileURLToPath(new URL('./ifc-opening-viewer.html',import.meta.url))],
 ['/three.js',fileURLToPath(new URL('../../node_modules/three/build/three.module.js',import.meta.url))],
 ['/three.core.js',fileURLToPath(new URL('../../node_modules/three/build/three.core.js',import.meta.url))],
 ...['full','omit-rel-voids'].flatMap(mode=>['json','bin'].map(ext=>['/'+mode+'.'+ext,resolve(directory,mode+'.'+ext)])),
]);
createServer((request,response)=>{
 const path=files.get(new URL(request.url,'http://localhost').pathname);if(!path){response.writeHead(404).end();return;}
 response.setHeader('Content-Type',path.endsWith('.html')?'text/html; charset=utf-8':path.endsWith('.js')?'text/javascript':path.endsWith('.json')?'application/json':'application/octet-stream');
 const stream=createReadStream(path);stream.on('error',()=>response.destroy());stream.pipe(response);
}).listen(14329,'127.0.0.1',()=>console.log('Steel comparison: http://127.0.0.1:14329'));
