// Streaming STEP evidence only; does not perform CAD geometry reconstruction.
import {createReadStream,statSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
const [source,output]=process.argv.slice(2);if(!source||!output)throw Error('Usage: node ifc-source-profile.mjs source.ifc output.json');
const counts={},products=new Map(),voidHosts=new Map(),hash=createHash('sha256'),start=performance.now();let entities=0,mm=false,voidBuffer='';
const stream=createReadStream(source);stream.on('data',chunk=>hash.update(chunk));
for await(const line of createInterface({input:stream,crlfDelay:Infinity})){
  if(voidBuffer){voidBuffer+=line;if(voidBuffer.includes(';')){const refs=[...voidBuffer.matchAll(/#(\d+)/g)].map(m=>Number(m[1]));const host=refs.at(-2);voidHosts.set(host,(voidHosts.get(host)??0)+1);voidBuffer='';}continue;}
  const match=/^#(\d+)\s*=\s*(IFC[A-Z0-9]+)\s*\(/.exec(line);if(!match)continue;
  const id=Number(match[1]),type=match[2];entities++;counts[type]=(counts[type]??0)+1;
  if(type==='IFCSIUNIT'&&line.includes('.MILLI.,.METRE.'))mm=true;
  if(['IFCPLATE','IFCMEMBER','IFCMECHANICALFASTENER'].includes(type))products.set(id,{expressId:id,ifcType:type,globalId:/\(\s*'([^']+)'/.exec(line)?.[1]});
  if(type==='IFCRELVOIDSELEMENT'){voidBuffer=line;if(line.includes(';')){const refs=[...line.matchAll(/#(\d+)/g)].map(m=>Number(m[1]));const host=refs.at(-2);voidHosts.set(host,(voidHosts.get(host)??0)+1);voidBuffer='';}}
}
const report={source,bytes:statSync(source).size,sha256:hash.digest('hex'),scanMs:performance.now()-start,entities,counts,lengthUnitMillimetres:mm,
  voidHosts:[...voidHosts].map(([id,openingCount])=>({...products.get(id),expressId:id,openingCount})).sort((a,b)=>b.openingCount-a.openingCount)};
writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({entities,scanMs:report.scanMs,voidRelations:counts.IFCRELVOIDSELEMENT,hosts:report.voidHosts.length,firstPlate:report.voidHosts.find(h=>h.expressId===66438),topHosts:report.voidHosts.slice(0,3)}));
