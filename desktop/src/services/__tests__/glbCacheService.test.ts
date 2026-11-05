import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { serializeDevToGlb, serializeDevToGlbDetailed, parseDevGlbAsset, analyzeDevCompilation, buildDevCompilePlan, mergeDevGlbParts, InvalidDevGeometryError } from '../glbCacheService.js';
import type { DiscoveredGeometries, DiscoveredModGeometry } from '../modGeometryDiscovery.js';
import { collectDeviceGroups } from '../nodeInteractionService.js';
import { AppState } from '../../app/state.js';

function file(text: string, name: string): File {
  return new File([text], name, { type: 'text/plain' });
}

const IDENTITY = '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';

describe('serializeDevToGlb strict dependency semantics', () => {
  it('finite extreme source Entity translations are rejected before normal GLB publication', async () => {
    const files = new Map(Object.entries({
      'DEV/device.dev': 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=body.phm',
      'PHM/body.phm': 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=body.mod',
      'MOD/body.mod': `<Device><Entities><Entity ID="2"><Cuboid L="1000" W="1000" H="1000"/><TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,-251014909666872,609402508870763,-175,1"/></Entity><Entity ID="3"><Cuboid L="1000" W="1000" H="1000"/></Entity></Entities></Device>`,
    }).map(([path,text]) => [path,file(text,path)]));
    await expect(serializeDevToGlbDetailed('DEV/device.dev',files)).rejects.toBeInstanceOf(InvalidDevGeometryError);
  });
  it('compiles nested PHM and repeated MOD deterministically, keeps child identity and ignores GL sidecar', async () => {
    const uuid = '12345678-1234-1234-1234-123456789abc';
    const files = new Map(Object.entries({
      'DEV/root.dev': `SUBDEVICES.NUM=1\nSUBDEVICE0=${uuid}.dev`,
      [`DEV/${uuid}.dev`]: 'SOLIDMODELS.NUM=2\nSOLIDMODEL0=first.phm\nSOLIDMODEL1=second.phm',
      'PHM/first.phm': 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=nested.phm',
      'PHM/second.phm': 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=leaf.mod\nTRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,40,0,0,1',
      'PHM/nested.phm': 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=leaf.mod',
      'MOD/leaf.mod': '<Device><Entities><Entity ID="1" Visible="TRUE"><Cuboid L="10" W="10" H="10"/></Entity></Entities></Device>',
      [`MOD/${uuid}.gl`]: '<Device><Entities><Entity ID="1"><GimGeCableConcentration/></Entity></Entities></Device>',
    }).map(([path, text]) => [path, file(text, path)]));
    const first = await serializeDevToGlbDetailed('DEV/root.dev', files);
    const second = await serializeDevToGlbDetailed('DEV/root.dev', files);
    expect(first.status).toBe('complete');
    expect(first.diagnostics).toMatchObject({ discoveredModCount: 2, renderableModCount: 2, unsupportedSourceCount: 0 });
    expect(second.bytes).toEqual(first.bytes);
    expect(first.bytes).not.toBeNull();
    const asset = await parseDevGlbAsset('DEV/root.dev', first.bytes!);
    expect(asset).not.toBeNull();
    const state = new AppState();
    state.loadedXmlModGroups.set('root', asset!.scene);
    expect(collectDeviceGroups(state, `${uuid}.dev`)).toHaveLength(2);
    expect(collectDeviceGroups(state, 'DEV/root.dev')).toHaveLength(1);
  });

  it('missing DEV rejects instead of producing an empty cache entry', async () => {
    await expect(serializeDevToGlb('DEV/missing.dev', new Map())).rejects.toThrow('DEV 文件不存在');
  });

  it('missing PHM/MOD rejects instead of producing an empty cache entry', async () => {
    const dev = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=missing.phm',
      `TRANSFORMMATRIX0=${IDENTITY}`,
    ].join('\n'), 'device.dev');
    await expect(serializeDevToGlb(
      'DEV/device.dev',
      new Map([['DEV/device.dev', dev]]),
    )).rejects.toThrow('PHM 文件不存在');

    const phm = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=missing.mod',
      `TRANSFORMMATRIX0=${IDENTITY}`,
      'COLOR0=',
    ].join('\n'), 'device.phm');
    await expect(serializeDevToGlb(
      'DEV/device.dev',
      new Map([
        ['DEV/device.dev', file([
          'SOLIDMODELS.NUM=1',
          'SOLIDMODEL0=device.phm',
          `TRANSFORMMATRIX0=${IDENTITY}`,
        ].join('\n'), 'device.dev')],
        ['PHM/device.phm', phm],
      ]),
    )).rejects.toThrow('MOD 文件不存在');
  });

  it('所有依赖存在但 MOD 是合法空占位时返回 null（可记录 empty）', async () => {
    const dev = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=device.phm',
      `TRANSFORMMATRIX0=${IDENTITY}`,
    ].join('\n'), 'device.dev');
    const phm = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=empty.mod',
      `TRANSFORMMATRIX0=${IDENTITY}`,
      'COLOR0=',
    ].join('\n'), 'device.phm');
    const emptyMod = file('<?xml version="1.0"?><Device><Entities /></Device>', 'empty.mod');

    await expect(serializeDevToGlb(
      'DEV/device.dev',
      new Map([
        ['DEV/device.dev', dev],
        ['PHM/device.phm', phm],
        ['MOD/empty.mod', emptyMod],
      ]),
    )).resolves.toBeNull();
  });

  it('空 DEV 在诊断中记录 IR 原因', async () => {
    const dev = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=device.phm',
      `TRANSFORMMATRIX0=${IDENTITY}`,
    ].join('\n'), 'device.dev');
    const phm = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=empty.mod',
      `TRANSFORMMATRIX0=${IDENTITY}`,
      'COLOR0=',
    ].join('\n'), 'device.phm');
    const emptyMod = file('<?xml version="1.0"?><Device><Entities /></Device>', 'empty.mod');
    const result = await serializeDevToGlbDetailed(
      'DEV/device.dev',
      new Map([
        ['DEV/device.dev', dev],
        ['PHM/device.phm', phm],
        ['MOD/empty.mod', emptyMod],
      ]),
    );
    expect(result.status).toBe('empty');
    expect(result.diagnostics.reason).toBe('empty-device-xml');
  });

  it('PHM 无 SOLIDMODEL 时记录 phm-no-solidmodel', async () => {
    const dev = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=device.phm',
      `TRANSFORMMATRIX0=${IDENTITY}`,
    ].join('\n'), 'device.dev');
    const phm = file('SOLIDMODELS.NUM=0', 'device.phm');
    const result = await serializeDevToGlbDetailed('DEV/device.dev', new Map([
      ['DEV/device.dev', dev],
      ['PHM/device.phm', phm],
    ]));
    expect(result.status).toBe('empty');
    expect(result.diagnostics.reason).toBe('phm-no-solidmodel');
  });

  it('完全没有 SOLIDMODEL 的 DEV 记录 dev-no-solidmodel', async () => {
    const dev = file('SOLIDMODELS.NUM=0', 'device.dev');
    const result = await serializeDevToGlbDetailed('DEV/device.dev', new Map([['DEV/device.dev', dev]]));
    expect(result.status).toBe('empty');
    expect(result.diagnostics.reason).toBe('dev-no-solidmodel');
  });

  it('非空但未知 primitive 不会被伪装成 deterministic empty', async () => {
    const dev = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=device.phm',
      `TRANSFORMMATRIX0=${IDENTITY}`,
    ].join('\n'), 'device.dev');
    const phm = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=unknown.mod',
      `TRANSFORMMATRIX0=${IDENTITY}`,
      'COLOR0=',
    ].join('\n'), 'device.phm');
    const unknownMod = file(
      '<Device><Entities><Entity ID="0" Type="simple" Visible="true"><UnknownPrimitive Foo="1" /></Entity></Entities></Device>',
      'unknown.mod',
    );

    const result = await serializeDevToGlbDetailed(
      'DEV/device.dev',
      new Map([
        ['DEV/device.dev', dev],
        ['PHM/device.phm', phm],
        ['MOD/unknown.mod', unknownMod],
      ]),
    );

    expect(result.status).toBe('unsupported');
    expect(result.bytes).toBeNull();
    expect(result.diagnostics.emptySourceCount).toBe(0);
    expect(result.diagnostics.unsupportedSourceCount).toBe(1);
    expect(result.diagnostics.unsupportedPrimitiveTypeCounts).toEqual({ UnknownPrimitive: 1 });
  });
});

it('outline serialization filters across MOD boundaries and retains one silhouette for an all-small DEV', async () => {
  const input=(big:boolean)=>new Map(Object.entries({
    'DEV/test.dev':'SOLIDMODELS.NUM=1\nSOLIDMODEL0=test.phm',
    'PHM/test.phm':'SOLIDMODELS.NUM=2\nSOLIDMODEL0=a.mod\nSOLIDMODEL1=b.mod',
    'MOD/a.mod':'<Device><Entities><Entity ID="1"><Cuboid L="20" W="20" H="20"/></Entity></Entities></Device>',
    'MOD/b.mod':`<Device><Entities><Entity ID="1"><Cuboid L="${big?200:40}" W="40" H="40"/></Entity></Entities></Device>`,
  }).map(([p,t])=>[p,file(t,p)]));
  for(const big of [false,true]){
    const result=await serializeDevToGlbDetailed('DEV/test.dev',input(big),{lod:0});
    expect(result.status).toBe('complete');expect(result.bytes).not.toBeNull();
    expect(result.diagnostics).toMatchObject({representationPolicy:'outline',renderableModCount:1,emptySourceCount:0,omittedSmallParts:big?1:2});
    expect(await parseDevGlbAsset('DEV/test.dev',result.bytes!)).not.toBeNull();
  }
});

it('splits a large DEV by real assembly subtrees, compiles parts and merges one template', async () => {
  const rows: [string, string][] = [
    ['DEV/huge.dev', 'SOLIDMODELS.NUM=4\nSOLIDMODEL0=a.phm\nSOLIDMODEL1=b.phm\nSOLIDMODEL2=c.phm\nSOLIDMODEL3=d.phm'],
  ];
  for (const group of ['a', 'b', 'c', 'd']) {
    rows.push([`PHM/${group}.phm`, `SOLIDMODELS.NUM=12\n${Array.from({ length: 12 }, (_, i) => `SOLIDMODEL${i}=${group}${i}.mod`).join('\n')}`]);
    for (let i = 0; i < 12; i++) {
      // Source bytes (not instance count) decide the split. Pad each MOD past
      // 128 KiB so this fixture represents a real multi-megabyte assembly.
      rows.push([`MOD/${group}${i}.mod`, `${' '.repeat(128 * 1024)}<Device><Entities><Entity ID="1"><Cuboid L="1000" W="1000" H="1000"/></Entity></Entities></Device>`]);
    }
  }
  const files = new Map(rows.map(([path, text]) => [path, file(text, path)]));
  const analysis = await analyzeDevCompilation('DEV/huge.dev', files);
  expect(analysis.plan?.parts).toHaveLength(4);
  expect(analysis.plan?.parts.map(part => part.referencePaths.length)).toEqual([12, 12, 12, 12]);
  const parts = await Promise.all(analysis.plan!.parts.map(part => serializeDevToGlbDetailed('DEV/huge.dev', files, {
    lod: 0, canonicalDevPath: analysis.canonicalDevPath, discovered: analysis.discovered,
    partition: { referencePaths: part.referencePaths },
  })));
  expect(parts.every(part => part.status === 'complete' && part.bytes)).toBe(true);
  expect(parts.reduce((total, part) => total + part.diagnostics.discoveredModCount, 0)).toBe(48);
  const merged = await mergeDevGlbParts('DEV/huge.dev', parts.map(part => part.bytes!));
  const asset = await parseDevGlbAsset('DEV/huge.dev', merged);
  expect(asset).not.toBeNull();
  expect(new THREE.Box3().setFromObject(asset!.scene).isEmpty()).toBe(false);
});

it('keeps a small DEV on the single-template compiler path', async () => {
  const files = new Map(Object.entries({
    'DEV/small.dev': 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=a.phm',
    'PHM/a.phm': 'SOLIDMODELS.NUM=2\nSOLIDMODEL0=a.mod\nSOLIDMODEL1=b.mod',
    'MOD/a.mod': '<Device><Entities><Entity ID="1"><Cuboid L="10" W="10" H="10"/></Entity></Entities></Device>',
    'MOD/b.mod': '<Device><Entities><Entity ID="1"><Cuboid L="10" W="10" H="10"/></Entity></Entities></Device>',
  }).map(([path, text]) => [path, file(text, path)]));
  const analysis = await analyzeDevCompilation('DEV/small.dev', files);
  expect(analysis.plan).toBeNull();
  expect((await serializeDevToGlbDetailed('DEV/small.dev', files)).status).toBe('complete');
});

it('subdivides a dominant PHM and counts repeated MOD occurrences separately from unique source bytes',()=>{
  const paths=['a','b','c','d'];
  const discovered:DiscoveredGeometries={mods:paths.flatMap((part,g)=>Array.from({length:g===0?1000:10},(_,i)=>({
    modPath:`MOD/${part}.mod`,referencePath:`solid:${g}/phm:0/mod:${i}`,instanceKey:`${part}:${i}`,
  } as DiscoveredModGeometry))),stls:[]};
  const files=new Map(paths.map(part=>[`MOD/${part}.mod`,file(' '.repeat(128*1024),`${part}.mod`)]));
  const plan=buildDevCompilePlan(discovered,files);
  expect(plan).not.toBeNull();expect(plan!.parts.length).toBeGreaterThanOrEqual(3);
  expect(plan!.parts.length).toBeLessThanOrEqual(4);
  expect(Math.max(...plan!.parts.map(part=>part.estimatedInstanceWork))).toBeLessThan(plan!.estimatedInstanceWork*0.6);
  expect(plan!.parts.flatMap(part=>part.referencePaths).sort()).toEqual(discovered.mods.map(edge=>edge.referencePath!).sort());
  const repeated:DiscoveredGeometries={mods:Array.from({length:1000},(_,i)=>({
    modPath:'MOD/reused.mod',referencePath:`solid:0/phm:0/mod:${i}`,instanceKey:`repeat:${i}`,
  } as DiscoveredModGeometry)),stls:[]};
  const shared=buildDevCompilePlan(repeated,new Map([['MOD/reused.mod',file(' '.repeat(128*1024),'reused.mod')]]));
  expect(shared).not.toBeNull();expect(shared!.estimatedBytes).toBe(128*1024);
  expect(shared!.estimatedInstanceWork).toBeGreaterThan(DEV_SPLIT_MIN_BYTES_FOR_TEST);
  expect(Math.max(...shared!.parts.map(part=>part.modCount))).toBeLessThan(600);
});

const DEV_SPLIT_MIN_BYTES_FOR_TEST=6*1024*1024;

it('matches monolithic and split+merge world geometry across nested PHM, repeated MOD, STL, empty and unsupported leaves',async()=>{
  const move=(x:number,y:number,z:number)=>`1,0,0,0,0,1,0,0,0,0,1,0,${x},${y},${z},1`;
  const stl=new ArrayBuffer(134),stlView=new DataView(stl);
  stlView.setUint32(80,1,true);
  [[0,0,0],[1000,0,0],[0,1000,0]].forEach((point,i)=>point.forEach((value,j)=>stlView.setFloat32(96+i*12+j*4,value,true)));
  const content=new Map<string,File>([
    ['DEV/complex.dev',file(`SOLIDMODELS.NUM=2\nSOLIDMODEL0=a.phm\nTRANSFORMMATRIX0=${move(1000,0,0)}\nSOLIDMODEL1=b.phm`,'complex.dev')],
    ['PHM/a.phm',file(`SOLIDMODELS.NUM=1\nSOLIDMODEL0=nested.phm\nTRANSFORMMATRIX0=${move(0,2000,0)}`,'a.phm')],
    ['PHM/nested.phm',file(`SOLIDMODELS.NUM=2\nSOLIDMODEL0=reused.mod\nTRANSFORMMATRIX0=${move(0,0,0)}\nSOLIDMODEL1=reused.mod\nTRANSFORMMATRIX1=${move(2000,0,0)}`,'nested.phm')],
    ['PHM/b.phm',file(`SOLIDMODELS.NUM=3\nSOLIDMODEL0=piece.stl\nCOLOR0=220,30,40,255\nTRANSFORMMATRIX0=${move(0,0,1000)}\nSOLIDMODEL1=empty.mod\nSOLIDMODEL2=unknown.mod`,'b.phm')],
    ['MOD/reused.mod',file('<Device><Entities><Entity ID="1" Visible="true"><Cuboid L="1000" W="500" H="700"/></Entity></Entities></Device>','reused.mod')],
    ['MOD/empty.mod',file('<Device><Entities/></Device>','empty.mod')],
    ['MOD/unknown.mod',file('<Device><Entities><Entity ID="1" Visible="true"><UnknownPrimitive/></Entity></Entities></Device>','unknown.mod')],
    ['MOD/piece.stl',new File([stl],'piece.stl')],
  ]);
  const analysis=await analyzeDevCompilation('DEV/complex.dev',content);
  expect(analysis.discovered.mods).toHaveLength(4);
  expect(analysis.discovered.stls).toHaveLength(1);
  const mono=await serializeDevToGlbDetailed('DEV/complex.dev',content,{lod:2,canonicalDevPath:analysis.canonicalDevPath,discovered:analysis.discovered});
  const groups=[analysis.discovered.mods.filter(edge=>edge.phmPath.endsWith('nested.phm')),
    analysis.discovered.mods.filter(edge=>edge.phmPath.endsWith('b.phm'))];
  const partitions=[{mods:groups[0],stls:[]},{mods:groups[1],stls:analysis.discovered.stls}];
  const parts=await Promise.all(partitions.map(part=>serializeDevToGlbDetailed('DEV/complex.dev',content,{
    lod:2,canonicalDevPath:analysis.canonicalDevPath,discovered:analysis.discovered,
    partition:{referencePaths:[...part.mods,...part.stls].map(edge=>edge.referencePath!)},
  })));
  const merged=await mergeDevGlbParts('DEV/complex.dev',parts.filter(part=>part.bytes).map(part=>part.bytes!));
  const first=await parseDevGlbAsset('DEV/complex.dev',mono.bytes!);
  const second=await parseDevGlbAsset('DEV/complex.dev',merged);
  expect(first&&second).toBeTruthy();
  expect(parts.reduce((count,part)=>count+part.diagnostics.discoveredModCount,0)).toBe(mono.diagnostics.discoveredModCount);
  expect(parts.reduce((count,part)=>count+part.diagnostics.discoveredStlCount,0)).toBe(mono.diagnostics.discoveredStlCount);
  expect(parts.reduce((count,part)=>count+part.diagnostics.unsupportedSourceCount,0)).toBe(mono.diagnostics.unsupportedSourceCount);
  const summarize=(root:THREE.Object3D)=>{
    root.updateMatrixWorld(true);
    const triangles:string[]=[],materials=new Map<string,number>();let meshCount=0;
    root.traverse(object=>{
      const mesh=object as THREE.Mesh;
      if(!mesh.isMesh||!mesh.geometry?.getAttribute('position'))return;
      meshCount++;
      const geometry=mesh.geometry,position=geometry.getAttribute('position'),index=geometry.getIndex();
      const material=mesh.material as THREE.MeshStandardMaterial;
      const color=`${material.color?.getHexString()??'none'}:${Math.round((material.opacity??1)*1000)}`;
      const count=index?.count??position.count;
      for(let i=0;i+2<count;i+=3){
        const vertex=[0,1,2].map(offset=>new THREE.Vector3().fromBufferAttribute(position,index?.getX(i+offset)??i+offset)
          .applyMatrix4(mesh.matrixWorld).toArray().map(n=>Math.round(n*10000)).join(','));
        triangles.push(`${color}:${vertex.sort().join('|')}`);
      }
      materials.set(color,(materials.get(color)??0)+Math.floor(count/3));
    });
    return {meshCount,triangles:triangles.sort(),materials:[...materials].sort(),bounds:[...new THREE.Box3().setFromObject(root).min.toArray(),...new THREE.Box3().setFromObject(root).max.toArray()]};
  };
  const left=summarize(first!.scene),right=summarize(second!.scene);
  expect(mono.status).toBe('partial');
  expect(parts.map(part=>part.status)).toEqual(['complete','partial']);
  expect(left.triangles.length).toBeGreaterThan(0);
  expect(right.triangles).toEqual(left.triangles);
  expect(right.materials).toEqual(left.materials);
  expect(right.bounds).toEqual(left.bounds);
  expect(left.meshCount).toBeGreaterThan(0);
  expect(right.meshCount).toBe(left.meshCount);
});
