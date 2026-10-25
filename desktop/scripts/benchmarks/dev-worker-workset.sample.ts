/** Prepare real physical roots and source manifests; no IFC bytes or scene timing. */
import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCbmTree } from '../../src/gim/cbmParser.js';
import { collectCbmDeviceInstances, parseCbmTransformMatrix } from '../../src/services/modAutoLoadService.js';
const cases = [
  ['substation01','demo-substation','711259814db95999f5282af1871da9cb50db4548b71626637b33038b062fc390'],
  ['substation02','substation02','a1c0990162e769f678f2fe5eeb275b1266fb8640776399289197d1998d372f29'],
  ['substation03','substation03','3197c03ef2c6c423cbb85447f71491a4112db0f9a8cea0c9f72f0b410b8175ab'],
  ['substation04','substation04','00b7746d5ea6ab3b92c215c1e42ffc7eec5a9f0517c1c555fa27a596d4d800dc'],
] as const;
const output = resolve('../output/memory-workset');
for (const [sample, directory, sha] of cases) it(`${sample}: prepare source-verified browsing workload`, async () => {
  const root = resolve('../demo', directory), files = new Map<string, File>();
  expect(createHash('sha256').update(readFileSync(resolve('../demo', sample+'.gim'))).digest('hex')).toBe(sha);
  expect(readFileSync(join(root,'.gim-source.sha256'),'utf8').trim()).toBe(sha);
  const sources: {path:string;size:number}[] = [];
  const visit = (dir:string,prefix='') => {
    for (const entry of readdirSync(dir,{withFileTypes:true})) {
      const path=prefix+entry.name, full=join(dir,entry.name);
      if(entry.isDirectory())visit(full,path+'/');
      else {
        const size=statSync(full).size;
        files.set(path,{name:entry.name,size,text:async()=>readFileSync(full,'utf8')} as File);
        if(/\.(dev|phm|mod|stl|gl)$/i.test(path))sources.push({path,size});
      }
    }
  };
  visit(root);
  const instances=collectCbmDeviceInstances(await buildCbmTree(files)).map(row=>({
    rootOccurrence:row.path, devPath:/^dev\//i.test(row.devPath)?row.devPath:`DEV/${row.devPath}`,
    matrix:parseCbmTransformMatrix(row.transformMatrix),
  }));
  const roots=[...new Set(instances.map(row=>row.devPath))].sort();
  const sorted=[...roots].sort((a,b)=>(files.get(b)?.size??0)-(files.get(a)?.size??0)||a.localeCompare(b));
  const cohort=[...new Set([...sorted.slice(0,16),...Array.from({length:Math.min(48,roots.length)},
    (_,i)=>roots[Math.floor(i*roots.length/Math.min(48,roots.length))])])].sort();
  expect(roots.length).toBeGreaterThan(0);expect(cohort.length).toBeGreaterThan(0);
  mkdirSync(output,{recursive:true});
  const manifest={sample,directory,sha,sources,roots,cohort,instances};
  writeFileSync(join(output,`${sample}-input.json`),JSON.stringify(manifest));
  console.log(JSON.stringify({sample,sources:sources.length,sourceBytes:sources.reduce((n,row)=>n+row.size,0),roots:roots.length,cohort:cohort.length,occurrences:instances.length}));
});
