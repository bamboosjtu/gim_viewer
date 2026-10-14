import {createServer} from 'node:http';import {createReadStream} from 'node:fs';
const source=process.argv[2];if(!source)throw Error('Explicit source IFC required');
createServer((req,res)=>{if(req.url!=='/source.ifc'){res.writeHead(404).end();return;}res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:14331');res.setHeader('Content-Type','application/octet-stream');const stream=createReadStream(source);stream.on('error',()=>res.destroy());stream.pipe(res);}).listen(14332,'127.0.0.1',()=>console.log('Single source ready'));
