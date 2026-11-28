import {expect,it} from 'vitest';
import {parseLineMod} from '@gim/powerline-core';
import type {GimGraphNode} from '@gim/powerline-core/gimGraphTypes.js';
import {linePreviewBatch} from '../lineGeometryPreview.js';
const node={path:'tower/A.cbm',rawProps:{}} as GimGraphNode;
it('uses the inspector source reference and selected height, retaining a rod with two missing endpoints',()=>{
 const path='MOD/t.mod',source=parseLineMod('HNum,1\nH,1000,Body1\nBody1\nP,1,0,0,0\nP,2,0,0,1000\nR,1,2,L50X5,Q235,1,0,0,0,1,0\nR,81,82','MOD/t.mod');
 const p=linePreviewBatch(node,{source,path},'sha',1000)!;
 expect(p.binding.ownerIds).toEqual([node.path]);expect([...p.batch.templates.values()].some(t=>t.kind==='mesh')).toBe(true);
 expect(p.batch.objects.some(o=>o.diagnostics.some(d=>d.code==='unresolved-line-record'))).toBe(true);
 expect(linePreviewBatch({...node,path:'tower/B.cbm'},{source,path},'sha')!.binding.ownerIds).toEqual(['tower/B.cbm']);
});
it('compiles the expanded base and rim from the referenced pile',()=>{
 const path='MOD/f.mod',source=parseLineMod('type=挖孔桩基础\nH1=1000\nH2=200\nH3=100\nH4=0\nd=100\nD=200',path);
 const out=linePreviewBatch(node,{path,source},'sha')!;
 expect(out.batch.objects.filter(o=>o.parts.length).map(o=>o.address.componentKey)).toEqual(['pile/shaft','pile/flare','pile/rim']);
});

it('renders one preview per proven split lane and retains the unlocated bundle as a chord without spacing',()=>{
 const path='Mod/w.mod',source=parseLineMod('TYPE=wire\nSECTIONALAREA=100\nOUTSIDEDIAMETER=20\nWIREWEIGHT=8\nCOEFFICIENTOFELASTICITY=100\nEXPANSIONCOEFFICIENTOFWIRE=1\nRATEDSTRENGTH=1000',path);
 const rawProps:Record<string,string>={SPLIT:'4','POINT0.BLHA':'30,115,10,0','POINT1.BLHA':'30.001,115.001,20,0'};
 for(const side of [0,1])for(let i=0;i<4;i++)rawProps['POINT'+side+'.MATRIX'+i]=[1,0,0,0,0,1,0,0,0,0,1,0,(i%2)*.5,0,12+Math.floor(i/2)*.5,1].join(',');
 const owner={...node,rawProps};
 const mapped=linePreviewBatch(owner,{source,path},'sha',undefined,undefined,{mm:500,path:'w.fam'})!;
 expect(mapped.batch.templates.size).toBe(4);expect([...mapped.batch.templates.values()].every(t=>t.kind==='mesh')).toBe(true);
 const simple=linePreviewBatch(owner,{source,path},'sha')!;expect(simple.batch.templates.size).toBe(1);expect([...simple.batch.templates.values()][0].kind).toBe('line-segments');
});
