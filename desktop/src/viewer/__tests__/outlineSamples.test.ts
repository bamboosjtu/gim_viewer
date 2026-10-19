/** Real MOD regression; only run by test:sample when local corpus is present. */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Evaluator } from 'three-bvh-csg';
import { parseWorkerXmlMod } from '../../gim/geometry/xmlModWorkerParser.js';
import { collectBakedGeometriesByMaterialAsync } from '../xmlModGeometry.js';
const root=resolve(process.cwd(),'../demo/substation02/MOD');
describe.skipIf(!existsSync(root))('substation02 heavy outline sources',()=>{
  it('bakes all >=300-Boolean MODs in both browsing LODs without CSG',async()=>{
    const heavy=readdirSync(root).filter(p=>/\.mod$/i.test(p)).map(p=>({path:p,text:readFileSync(join(root,p),'utf8')}))
      .filter(row=>(row.text.match(/<Boolean\b/g)??[]).length>=300);
    expect(heavy).toHaveLength(8);
    const spy=vi.spyOn(Evaluator.prototype,'evaluate');
    try {
      for(const source of heavy)for(const lod of [0,1] as const){
        const doc=parseWorkerXmlMod(source.text,source.path),t=performance.now();
        const baked=await collectBakedGeometriesByMaterialAsync(doc,lod);
        const elapsed=performance.now()-t;
        console.log(JSON.stringify({source:source.path,lod,ms:Math.round(elapsed),omitted:baked.omittedSmallParts,approximated:baked.approximatedBooleans}));
        expect(spy).not.toHaveBeenCalled(); expect(baked.size).toBeGreaterThan(0);expect(baked.failures).toEqual([]);
        expect(elapsed).toBeLessThan(1000);
        for(const geometries of baked.values())for(const geometry of geometries)geometry.dispose();
      }
    }finally{spy.mockRestore();}
  },30000);
});
