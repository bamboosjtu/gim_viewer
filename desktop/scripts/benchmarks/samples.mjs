import {createHash} from 'node:crypto';
import {createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, openSync, readSync, closeSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {join, relative, resolve, sep} from 'node:path';

export function workspacePath(root, path, mustExist = true) {
  const absolute = resolve(path), base = realpathSync(root);
  const lexical = relative(base, absolute);
  if (!lexical || lexical === '..' || lexical.startsWith(`..${sep}`) || resolve(base, lexical) !== absolute) throw Error('Path is outside the workspace');
  const actual = mustExist ? realpathSync(absolute) : absolute;
  const rel = relative(base, actual);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(base, rel) !== actual) throw Error('Path is outside the workspace');
  return actual;
}
export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
function walk(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en')).flatMap(entry => {
    if(entry.isSymbolicLink())return [];
    const path=join(root,entry.name);
    return entry.isDirectory()?walk(path):/\.gim$/i.test(entry.name)?[path]:[];
  });
}
function container(path) {
  const data=Buffer.alloc(Math.min(statSync(path).size,1024*1024)),fd=openSync(path,'r');
  try{readSync(fd,data,0,data.length,0);}finally{closeSync(fd);}
  const magic=data.subarray(0,7).toString('ascii');
  const seven=Buffer.from([0x37,0x7a,0xbc,0xaf,0x27,0x1c]),zip=Buffer.from([0x50,0x4b,0x03,0x04]);
  const bare=data.subarray(0,6).equals(seven)?'7z':data.subarray(0,4).equals(zip)?'zip':null;
  const offset=bare?0:magic.startsWith('GIMPKG')?data.indexOf(seven):-1;
  const zipOffset=offset<0&&magic.startsWith('GIMPKG')?data.indexOf(zip):-1;
  return {magic:/^GIMPKG[ST]?$/.test(magic)?magic:bare?'bare':'unknown',payload:bare??(offset>=0?'7z':zipOffset>=0?'zip':'unknown'),offset:offset>=0?offset:zipOffset>=0?zipOffset:null};
}
export function defaultSources(root) {
  return [
    {sampleTier:'L0',group:'common-design',paths:walk(join(root,'demo','变电站通用设计模型')).filter(p=>/三维设计\.gim$/i.test(p)),expected:48},
    {sampleTier:'L0',group:'common-model',paths:walk(join(root,'demo','通用模型')),expected:917},
    {sampleTier:'L1',group:'development-regression',paths:[...Array.from({length:4},(_,i)=>join(root,'demo','substations',`substation0${i+1}.gim`)),...Array.from({length:6},(_,i)=>join(root,'demo','lines',`line0${i+1}.gim`))].filter(existsSync),expected:10},
    {sampleTier:'L2',group:'complex-engineering',paths:walk(join(root,'demo','真实工程')),expected:19},
    {sampleTier:'L2',group:'complex-equipment',paths:walk(join(root,'demo','真实设备模型')),expected:7},
  ];
}
export async function registerSamples(root, out, sources=defaultSources(root)) {
  const groups=[],bySha=new Map(); let paths=0;
  for(const source of sources){
    groups.push({group:source.group,sampleTier:source.sampleTier,paths:source.paths.length,expected:source.expected??null});
    for(const input of source.paths){
      const path=workspacePath(root,input),before=statSync(path),sha=await sha256(path),after=statSync(path);
      if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('Sample changed during hashing');
      paths++;
      let sample=bySha.get(sha);
      if(!sample){sample={sampleId:`gim-${sha.slice(0,16)}`,sourceSha256:sha,bytes:after.size,container:container(path),memberships:[],paths:[],inventory:{status:'not-collected'}};bySha.set(sha,sample);}
      if(!sample.memberships.some(x=>x.group===source.group))sample.memberships.push({sampleTier:source.sampleTier,group:source.group});
      sample.paths.push(relative(root,path).replaceAll('\\','/'));
      if(/[/\\]substation01\.gim$/i.test(path))sample.requiredRegression='full-package-index';
    }
  }
  const samples=[...bySha.values()].sort((a,b)=>a.sourceSha256.localeCompare(b.sourceSha256));
  const registry={version:'gim-samples-v1',createdAt:new Date().toISOString(),pathCount:paths,uniqueSources:samples.length,duplicatePaths:paths-samples.length,groups,samples};
  mkdirSync(out,{recursive:true});writeFileSync(join(out,'registry.private.json'),JSON.stringify(registry,null,2));
  publishRegistry(out,registry);return registry;
}
export function publishRegistry(out,registry){
  const shareable={...registry,samples:registry.samples.map(({paths,...sample})=>({...sample,pathAliases:paths.length}))};
  writeFileSync(join(out,'registry.json'),JSON.stringify(shareable,null,2));
}
export async function inventorySamples(root,out,executable){
  const registry=JSON.parse(readFileSync(join(out,'registry.private.json'),'utf8'));
  const child=spawn(workspacePath(root,executable),[],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,TEMP:out,TMP:out,TMPDIR:out}});
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let failure;child.on('error',e=>{failure=e;});child.stderr.resume();
  const exit=new Promise(resolve=>child.on('close',code=>resolve(code)));
  let failed=false;
  try{
    for(const sample of registry.samples){
      if(failure)throw failure;
      const path=workspacePath(root,join(root,sample.paths[0]));
      if(await sha256(path)!==sample.sourceSha256)throw Error('Registered sample SHA changed');
      child.stdin.write(JSON.stringify(path)+'\n');
      let timer;
      let next;
      try{next=await Promise.race([lines.next(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native inventory timeout')),120000);})]);}
      finally{clearTimeout(timer);}
      if(next.done)throw Error('Native inventory stopped early');
      sample.inventory=JSON.parse(next.value);
    }
  }catch(error){failed=true;throw error;}
  finally{child.stdin.end();if(failed&&child.pid&&child.exitCode===null)child.kill();if(failed)await exit;}
  if(await exit!==0)throw Error('Native inventory failed');
  writeFileSync(join(out,'registry.private.json'),JSON.stringify(registry,null,2));publishRegistry(out,registry);return registry;
}

/** Deterministic candidate by source coverage, never by timing or fastest runtime. */
export function selectSamples(registry){
  registry={...registry,samples:[...registry.samples].sort((a,b)=>a.sourceSha256.localeCompare(b.sourceSha256))};
  const mandatory=new Set(),coverage=new Set(), selected=[];
  const features=sample=>{
    const tags=sample.memberships.map(x=>`${x.sampleTier}:${x.group}`);
    const ext=sample.inventory.extensions??{};
    if(ext.ifc>0)tags.push('worker:ifc-conversion','worker:ifc-regional','worker:ifc-fine','worker:spatial');
    if(ext.mod>0||ext.stl>0)tags.push('worker:dev');
    if(ext.cbm>0)tags.push('worker:engineering');
    if(sample.container.magic==='GIMPKGT')tags.push('worker:line');
    tags.push(`container:${sample.container.payload}`);
    for(const name of ['phm','stl','gl','sld'])if(ext[name]>0)tags.push(`source:${name}`);
    tags.push(`size:${sample.bytes<1024*1024?'small':sample.bytes<32*1024*1024?'medium':'large'}`);
    tags.push(`file-count:${sample.inventory.files<100?'small':sample.inventory.files<10000?'medium':sample.inventory.files<50000?'large':'very-large'}`);
    return tags;
  };
  const take=(sample,reason)=>{if(mandatory.has(sample.sampleId))return;mandatory.add(sample.sampleId);features(sample).forEach(tag=>coverage.add(tag));selected.push({sampleId:sample.sampleId,sourceSha256:sample.sourceSha256,reason,features:features(sample)});};
  for(const sample of registry.samples)if(sample.requiredRegression)take(sample,sample.requiredRegression);
  const eligible=registry.samples.filter(s=>s.inventory.status==='available'&&((s.inventory.extensions?.cbm??0)+(s.inventory.extensions?.dev??0)>0));
  for(const group of ['common-design','common-model','complex-engineering','complex-equipment']){
    const rows=eligible.filter(s=>s.memberships.some(m=>m.group===group)).sort((a,b)=>b.inventory.files-a.inventory.files||a.sourceSha256.localeCompare(b.sourceSha256));
    if(rows[0])take(rows[0],'group-workload-upper-bound');
  }
  while(true){
    const ranked=eligible.filter(s=>!mandatory.has(s.sampleId)).map(s=>({s,gain:features(s).filter(tag=>!coverage.has(tag)).length})).sort((a,b)=>b.gain-a.gain||a.s.sourceSha256.localeCompare(b.s.sourceSha256));
    if(!ranked[0]?.gain)break;take(ranked[0].s,'coverage');
  }
  return {version:'gim-selection-v1',status:'candidate',frozen:false,selectionMethod:'deterministic-coverage-no-timing',
    limitations:['File presence is candidate coverage, not proof of runtime branch execution.','Expected behavior and scenario actions require native acceptance.'],
    profiles:{'commit-gate':selected,'full-regression':registry.samples.map(s=>({sampleId:s.sampleId,sourceSha256:s.sourceSha256,expectedBehavior:'unreviewed'})),
      geometry:selected.filter(s=>s.features.includes('worker:dev')),ifc:selected.filter(s=>s.features.includes('worker:ifc-conversion')),memory:selected},
    coverage:[...coverage].sort(),unavailableInventory:registry.samples.filter(s=>s.inventory.status!=='available').map(s=>s.sampleId)};
}
