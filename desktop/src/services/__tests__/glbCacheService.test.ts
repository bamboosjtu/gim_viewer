import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { serializeDevToGlb, serializeDevToGlbDetailed, parseDevGlbAsset, analyzeDevCompilation, buildDevCompilePlan, mergeDevGlbParts, InvalidDevGeometryError } from '../glbCacheService.js';
import type { DiscoveredGeometries, DiscoveredModGeometry } from '../modGeometryDiscovery.js';
import { collectDeviceGroups } from '../nodeInteractionService.js';
import { AppState } from '../../app/state.js';
import { invalidGeometryExtent, invalidGeometryBounds, stlSourceEnvelope, STL_SOURCE_ENVELOPE_KEY } from '../../viewer/geometryBounds.js';
import { DevGlbTemplate } from '../devGlbTemplateRuntime.js';
import { verifyDevGlbSourceEnvelope } from '../devGlbSourceEvidence.js';

function file(text: string, name: string): File {
  return new File([text], name, { type: 'text/plain' });
}

const IDENTITY = '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';

function triangleStl(points: number[][]): ArrayBuffer {
  const bytes = new ArrayBuffer(134), view = new DataView(bytes);
  view.setUint32(80, 1, true); view.setFloat32(92, 1, true);
  points.forEach((point,i) => point.forEach((value,j) => view.setFloat32(96+i*12+j*4,value,true)));
  return bytes;
}

it('shares repeated STL buffers while retaining occurrence identity, colors and exact affine node matrices', async () => {
  const matrices = [new THREE.Matrix4().set(1,.25,0,1200,0,1,.2,0,0,0,1,0,0,0,0,1),
    new THREE.Matrix4().makeScale(-1,2,1).setPosition(0,2000,0)];
  // Padding exercises large-source admission without a full engineering sample.
  const stl = new File([triangleStl([[0,0,0],[1000,0,0],[0,1000,0]]),new Uint8Array(2*1024*1024)], 'piece.stl');
  const read = vi.spyOn(stl, 'arrayBuffer');
  const files = new Map([
    ['DEV/device.dev',file('SOLIDMODELS.NUM=1\nSOLIDMODEL0=body.phm','device.dev')],
    ['PHM/body.phm',file(`SOLIDMODELS.NUM=24\n${Array.from({length:24},(_,i)=>`SOLIDMODEL${i}=piece.stl\nTRANSFORMMATRIX${i}=${matrices[i%2].toArray()}\nCOLOR${i}=${i%2?'0,0,255,255':'255,0,0,255'}`).join('\n')}`,'body.phm')],
    ['MOD/piece.stl',stl],
  ]);
  expect((await analyzeDevCompilation('DEV/device.dev',files)).plan).toBeNull();
  const result = await serializeDevToGlbDetailed('DEV/device.dev',files);
  expect(result.status).toBe('complete'); expect(read).toHaveBeenCalledOnce();
  const asset = await parseDevGlbAsset('DEV/device.dev',result.bytes!);
  asset!.scene.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = []; asset!.scene.traverse(node => {if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh);});
  expect(meshes).toHaveLength(24); expect(new Set(meshes.map(mesh=>mesh.geometry)).size).toBe(1);
  expect(meshes.map(mesh=>(mesh.material as THREE.MeshStandardMaterial).color.getHex())).toEqual(Array.from({length:24},(_,i)=>i%2?0x0000ff:0xff0000));
  for (let i=0;i<meshes.length;i++) {
    const expected=matrices[i%2].clone(); expected.elements[12]*=.001; expected.elements[13]*=.001;
    expect(meshes[i].matrixWorld.toArray()).toEqual(expected.toArray());
    expect(meshes[i].parent!.userData.referencePath).toBeTruthy();
    const position=meshes[i].geometry.getAttribute('position');
    const normal=meshes[i].geometry.getAttribute('normal');
    const normalMatrix=new THREE.Matrix3().getNormalMatrix(expected);
    for (let vertex=0;vertex<3;vertex++) {
      const point=new THREE.Vector3().fromBufferAttribute(position,vertex).applyMatrix4(meshes[i].matrixWorld);
      const source=[new THREE.Vector3(),new THREE.Vector3(1,0,0),new THREE.Vector3(0,1,0)][vertex].applyMatrix4(expected);
      expect(point.distanceTo(source)).toBeLessThan(1e-6);
      expect(new THREE.Vector3().fromBufferAttribute(normal,vertex).applyMatrix3(normalMatrix).normalize()
        .distanceTo(new THREE.Vector3(0,0,1).applyMatrix3(normalMatrix).normalize())).toBeLessThan(1e-6);
    }
  }
  new DevGlbTemplate('DEV/device.dev',asset!.scene).dispose();
});

it('admits a source-verified wide binary STL across GLB restore and placement, while rejecting altered or imprecise bounds', async () => {
  const files = new Map([
    ['DEV/device.dev',file('SOLIDMODELS.NUM=1\nSOLIDMODEL0=body.phm','device.dev')],
    ['PHM/body.phm',file('SOLIDMODELS.NUM=1\nSOLIDMODEL0=site.stl','body.phm')],
    ['MOD/site.stl',new File([triangleStl([[-100000,0,0],[600000,0,0],[-100000,400000,0]])],'site.stl')],
  ]);
  const result=await serializeDevToGlbDetailed('DEV/device.dev',files);
  expect(result.status).toBe('complete');
  const asset=await parseDevGlbAsset('DEV/device.dev',result.bytes!);
  expect(invalidGeometryExtent(asset!.scene)).toMatch(/extent-exceeds/);
  const sourceRead=vi.spyOn(files.get('MOD/site.stl')!,'arrayBuffer'),sourceKeys=vi.spyOn(files,'keys');
  await verifyDevGlbSourceEnvelope(asset!.scene,'DEV/device.dev',files);
  expect(sourceRead).toHaveBeenCalledOnce();const keyScans=sourceKeys.mock.calls.length;
  expect(invalidGeometryExtent(asset!.scene)).toBeNull();
  const envelope=stlSourceEnvelope(asset!.scene)!;
  expect(envelope.getSize(new THREE.Vector3()).x).toBe(700);
  const template=new DevGlbTemplate('DEV/device.dev',asset!.scene);
  const placed=template.createPlacement({placementMatrix:new THREE.Matrix4().makeTranslation(1000,2000,0).toArray()});
  const worldBounds=new THREE.Box3().setFromObject(placed);
  expect(invalidGeometryExtent(placed)).toBeNull();
  expect(invalidGeometryBounds(worldBounds,envelope.clone().applyMatrix4(placed.matrix))).toBeNull();
  const enormous=new THREE.Matrix4().makeScale(1e9,1e9,1e9);
  expect(invalidGeometryBounds(worldBounds.clone().applyMatrix4(enormous),envelope.clone().applyMatrix4(enormous))).toMatch(/extent-exceeds/);
  let owner=asset!.scene; while (!owner.userData[STL_SOURCE_ENVELOPE_KEY]) owner=owner.children[0] as THREE.Group;
  const proof=owner.userData[STL_SOURCE_ENVELOPE_KEY];
  proof.bounds[3]+=1; expect(invalidGeometryExtent(asset!.scene)).toMatch(/extent-exceeds/);
  proof.bounds[3]-=1; proof.triangles++; expect(invalidGeometryExtent(asset!.scene)).toMatch(/extent-exceeds/);
  delete owner.userData[STL_SOURCE_ENVELOPE_KEY]; expect(invalidGeometryExtent(asset!.scene)).toMatch(/extent-exceeds/);
  template.dispose();
  const altered=await parseDevGlbAsset('DEV/device.dev',result.bytes!);
  let mesh:THREE.Mesh|undefined;altered!.scene.traverse(node=>{if((node as THREE.Mesh).isMesh)mesh=node as THREE.Mesh;});
  const before=new THREE.Box3().setFromObject(altered!.scene);
  mesh!.geometry.getAttribute('position').setX(0,-90);mesh!.geometry.computeBoundingBox();
  expect(new THREE.Box3().setFromObject(altered!.scene).equals(before)).toBe(true);
  await expect(verifyDevGlbSourceEnvelope(altered!.scene,'DEV/device.dev',files)).rejects.toThrow('source evidence mismatch');
  expect(invalidGeometryExtent(altered!.scene)).toMatch(/extent-exceeds/);
  const wrongSha=await parseDevGlbAsset('DEV/device.dev',result.bytes!);
  let proofOwner=wrongSha!.scene;while(!proofOwner.userData[STL_SOURCE_ENVELOPE_KEY])proofOwner=proofOwner.children[0] as THREE.Group;
  proofOwner.userData[STL_SOURCE_ENVELOPE_KEY].sha256='0'.repeat(64);
  await expect(verifyDevGlbSourceEnvelope(wrongSha!.scene,'DEV/device.dev',files)).rejects.toThrow('source evidence mismatch');
  const cancelled=await parseDevGlbAsset('DEV/device.dev',result.bytes!);
  await expect(verifyDevGlbSourceEnvelope(cancelled!.scene,'DEV/device.dev',files,()=>false)).rejects.toMatchObject({name:'AbortError'});
  expect(sourceKeys).toHaveBeenCalledTimes(keyScans);
  files.set('MOD/site.stl',new File([triangleStl([[0,0,0],[1e15,0,0],[0,1e15,0]])],'site.stl'));
  await expect(serializeDevToGlbDetailed('DEV/device.dev',files)).rejects.toBeInstanceOf(InvalidDevGeometryError);
});

it('retains the exported world X fallback for zero STL normals under shared reflected and sheared occurrences', async () => {
  const bytes=triangleStl([[0,0,0],[1000,0,0],[0,1000,0]]);new DataView(bytes).setFloat32(92,0,true);
  const matrices=[new THREE.Matrix4().makeScale(-1,2,1),new THREE.Matrix4().set(1,.3,.2,0,0,1,.4,0,0,0,1,0,0,0,0,1)];
  const files=new Map([
    ['DEV/device.dev',file('SOLIDMODELS.NUM=1\nSOLIDMODEL0=body.phm','device.dev')],
    ['PHM/body.phm',file(`SOLIDMODELS.NUM=2\nSOLIDMODEL0=piece.stl\nTRANSFORMMATRIX0=${matrices[0].toArray()}\nSOLIDMODEL1=piece.stl\nTRANSFORMMATRIX1=${matrices[1].toArray()}`,'body.phm')],
    ['MOD/piece.stl',new File([bytes],'piece.stl')],
  ]);
  const result=await serializeDevToGlbDetailed('DEV/device.dev',files),asset=await parseDevGlbAsset('DEV/device.dev',result.bytes!);
  asset!.scene.updateMatrixWorld(true);const meshes:THREE.Mesh[]=[];
  asset!.scene.traverse(node=>{if((node as THREE.Mesh).isMesh)meshes.push(node as THREE.Mesh);});
  expect(meshes[0].geometry.getAttribute('position')).toBe(meshes[1].geometry.getAttribute('position'));
  for(const mesh of meshes){const normal=mesh.geometry.getAttribute('normal'),matrix=new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for(let vertex=0;vertex<normal.count;vertex++)expect(new THREE.Vector3().fromBufferAttribute(normal,vertex)
      .applyMatrix3(matrix).normalize().distanceTo(new THREE.Vector3(1,0,0))).toBeLessThan(1e-6);}
  new DevGlbTemplate('DEV/device.dev',asset!.scene).dispose();
});

describe('serializeDevToGlb strict dependency semantics', () => {
  it('releases earlier STL resources when a later referenced source cannot be read', async () => {
    const stl = new ArrayBuffer(134), view = new DataView(stl);
    view.setUint32(80, 1, true);
    [[0,0,0],[1000,0,0],[0,1000,0]].forEach((point,i) =>
      point.forEach((value,j) => view.setFloat32(96+i*12+j*4,value,true)));
    const broken = new File([stl], 'broken.stl');
    vi.spyOn(broken, 'arrayBuffer').mockRejectedValue(Error('source read failed'));
    const files = new Map([
      ['DEV/device.dev', file('SOLIDMODELS.NUM=1\nSOLIDMODEL0=body.phm', 'device.dev')],
      ['PHM/body.phm', file('SOLIDMODELS.NUM=2\nSOLIDMODEL0=good.stl\nSOLIDMODEL1=broken.stl', 'body.phm')],
      ['MOD/good.stl', new File([stl], 'good.stl')],
      ['MOD/broken.stl', broken],
    ]);
    const geometry = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const material = vi.spyOn(THREE.Material.prototype, 'dispose');
    try {
      await expect(serializeDevToGlbDetailed('DEV/device.dev', files)).rejects.toThrow('STL 加载失败');
      expect(geometry).toHaveBeenCalledOnce();
      expect(material).toHaveBeenCalledOnce();
    } finally { geometry.mockRestore(); material.mockRestore(); }
  });
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

it.each([0,1] as const)('LOD%d split parts defer small silhouettes until the DEV result is known',async lod=>{
  const rows:Record<string,string>={
    'DEV/outline.dev':'SOLIDMODELS.NUM=2\nSOLIDMODEL0=a.phm\nSOLIDMODEL1=b.phm',
    'PHM/a.phm':'SOLIDMODELS.NUM=2\nSOLIDMODEL0=small20.mod\nSOLIDMODEL1=small40.mod',
    'PHM/b.phm':'SOLIDMODELS.NUM=1\nSOLIDMODEL0=body.mod',
    'MOD/small20.mod':'<Device><Entities><Entity ID="1"><Cuboid L="20" W="20" H="20"/></Entity></Entities></Device>',
    'MOD/small40.mod':'<Device><Entities><Entity ID="1"><Cuboid L="40" W="40" H="40"/></Entity></Entities></Device>',
    'MOD/body.mod':'<Device><Entities><Entity ID="1"><Cuboid L="200" W="100" H="100"/></Entity></Entities></Device>',
  };
  const files=new Map(Object.entries(rows).map(([path,text])=>[path,file(text,path)]));
  const analysis=await analyzeDevCompilation('DEV/outline.dev',files);
  const references=(phm:string)=>analysis.discovered.mods.filter(edge=>edge.phmPath.endsWith(phm)).map(edge=>edge.referencePath!);
  const mono=await serializeDevToGlbDetailed('DEV/outline.dev',files,{lod,discovered:analysis.discovered});
  const small=await serializeDevToGlbDetailed('DEV/outline.dev',files,{lod,discovered:analysis.discovered,partition:{referencePaths:references('a.phm')}});
  const body=await serializeDevToGlbDetailed('DEV/outline.dev',files,{lod,discovered:analysis.discovered,partition:{referencePaths:references('b.phm')}});
  expect(small.bytes).toBeNull();expect(small.smallFallback?.extent).toBeGreaterThan(0);
  expect(body.bytes).not.toBeNull();
  const merged=await mergeDevGlbParts('DEV/outline.dev',[body.bytes!]);
  const vertices=async(bytes:Uint8Array)=>{
    const asset=await parseDevGlbAsset('DEV/outline.dev',bytes),points:string[]=[];
    asset!.scene.updateMatrixWorld(true);
    asset!.scene.traverse(object=>{
      const mesh=object as THREE.Mesh,attr=mesh.geometry?.getAttribute?.('position');
      if(!mesh.isMesh||!attr)return;
      for(let i=0;i<attr.count;i++)points.push(new THREE.Vector3().fromBufferAttribute(attr,i).applyMatrix4(mesh.matrixWorld)
        .toArray().map(n=>Math.round(n*10000)).join(','));
    });
    return points.sort();
  };
  expect(await vertices(merged)).toEqual(await vertices(mono.bytes!));
  expect(mono.diagnostics.renderableModCount).toBe(1);
  // Now every part is small: exactly the largest source occurrence survives.
  rows['MOD/body.mod']='<Device><Entities><Entity ID="1"><Cuboid L="50" W="50" H="50"/></Entity></Entities></Device>';
  files.set('MOD/body.mod',file(rows['MOD/body.mod'],'body.mod'));
  const allSmall=await serializeDevToGlbDetailed('DEV/outline.dev',files,{lod,discovered:analysis.discovered});
  const partA=await serializeDevToGlbDetailed('DEV/outline.dev',files,{lod,discovered:analysis.discovered,partition:{referencePaths:references('a.phm')}});
  const partB=await serializeDevToGlbDetailed('DEV/outline.dev',files,{lod,discovered:analysis.discovered,partition:{referencePaths:references('b.phm')}});
  expect(partA.bytes).toBeNull();expect(partB.bytes).toBeNull();
  expect(partB.smallFallback!.extent).toBeGreaterThan(partA.smallFallback!.extent);
  const recovered=await serializeDevToGlbDetailed('DEV/outline.dev',files,{lod,discovered:analysis.discovered,
    partition:{referencePaths:[partB.smallFallback!.referencePath],allowSmallFallback:true}});
  expect(recovered.bytes).not.toBeNull();
  expect(await vertices(recovered.bytes!)).toEqual(await vertices(allSmall.bytes!));
  expect(allSmall.diagnostics.renderableModCount).toBe(1);
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
    modPath:`MOD/${part}.mod`,referencePath:`solid:${g}/phm:${i}`,instanceKey:`${part}:${i}`,
  } as DiscoveredModGeometry))),stls:[]};
  const files=new Map(paths.map(part=>[`MOD/${part}.mod`,file(' '.repeat(128*1024),`${part}.mod`)]));
  const plan=buildDevCompilePlan(discovered,files);
  expect(plan).not.toBeNull();expect(plan!.parts.length).toBeGreaterThanOrEqual(3);
  expect(plan!.parts.length).toBeLessThanOrEqual(4);
  expect(Math.max(...plan!.parts.map(part=>part.estimatedInstanceWork))).toBeLessThan(plan!.estimatedInstanceWork*0.6);
  expect(plan!.parts.flatMap(part=>part.referencePaths).sort()).toEqual(discovered.mods.map(edge=>edge.referencePath!).sort());
  const repeated:DiscoveredGeometries={mods:Array.from({length:1000},(_,i)=>({
    modPath:'MOD/reused.mod',referencePath:`solid:0/phm:${i}`,instanceKey:`repeat:${i}`,
  } as DiscoveredModGeometry)),stls:[]};
  const shared=buildDevCompilePlan(repeated,new Map([['MOD/reused.mod',file(' '.repeat(128*1024),'reused.mod')]]));
  expect(shared).not.toBeNull();expect(shared!.estimatedBytes).toBe(128*1024);
  expect(shared!.estimatedInstanceWork).toBeGreaterThan(DEV_SPLIT_MIN_BYTES_FOR_TEST);
  expect(Math.max(...shared!.parts.map(part=>part.modCount))).toBeLessThan(600);
});

it('partitions one oversized MOD by visible roots while preserving its L0 world bounds',async()=>{
  const mod='<Device><Entities><Entity ID="1" Visible="TRUE"><Cuboid L="100" W="100" H="100"/></Entity>'+
    '<Entity ID="2" Visible="TRUE"><Cuboid L="200" W="100" H="100"/>'+
    '<TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,500,0,0,1"/></Entity></Entities></Device>';
  const oversized={size:71*1024*1024,text:async()=>mod,arrayBuffer:async()=>new TextEncoder().encode(mod).buffer} as unknown as File;
  const files=new Map([['DEV/root.dev',file('SOLIDMODELS.NUM=1\nSOLIDMODEL0=large.mod','root.dev')],
    ['MOD/large.mod',oversized]]);
  const discovered:DiscoveredGeometries={mods:[{modPath:'MOD/large.mod',referencePath:'solid:0',instanceKey:'one'} as DiscoveredModGeometry],stls:[]};
  const plan=buildDevCompilePlan(discovered,files)!;
  expect(plan.parts.length).toBeGreaterThanOrEqual(2);
  expect(plan.parts.every(part=>part.rootSlice)).toBe(true);
  const mono=await serializeDevToGlbDetailed('DEV/root.dev',files,{canonicalDevPath:'DEV/root.dev',discovered,lod:0});
  const pieces=await Promise.all(plan.parts.map(part=>serializeDevToGlbDetailed('DEV/root.dev',files,{
    canonicalDevPath:'DEV/root.dev',discovered:{mods:part.mods,stls:part.stls},lod:0,
    partition:{referencePaths:part.referencePaths,rootSlice:part.rootSlice}})));
  const merged=await mergeDevGlbParts('DEV/root.dev',pieces.flatMap(part=>part.bytes?[part.bytes]:[]));
  const a=await parseDevGlbAsset('DEV/root.dev',mono.bytes!),b=await parseDevGlbAsset('DEV/root.dev',merged);
  expect(a).not.toBeNull();expect(b).not.toBeNull();
  const before=new THREE.Box3().setFromObject(a!.scene),after=new THREE.Box3().setFromObject(b!.scene);
  for(let i=0;i<6;i++)expect([...after.min.toArray(),...after.max.toArray()][i])
    .toBeCloseTo([...before.min.toArray(),...before.max.toArray()][i],5);
});

const DEV_SPLIT_MIN_BYTES_FOR_TEST=6*1024*1024;

it('matches monolithic and split+merge world geometry across nested PHM, repeated MOD, STL, empty and unsupported leaves',async()=>{
  const move=(x:number,y:number,z:number)=>`1,0,0,0,0,1,0,0,0,0,1,0,${x},${y},${z},1`;
  const rotateScale=new THREE.Matrix4().compose(new THREE.Vector3(0,2000,0),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2),
    new THREE.Vector3(-1,1.5,0.75)).toArray().join(',');
  const stl=new ArrayBuffer(134),stlView=new DataView(stl);
  stlView.setUint32(80,1,true);
  [[0,0,0],[1000,0,0],[0,1000,0]].forEach((point,i)=>point.forEach((value,j)=>stlView.setFloat32(96+i*12+j*4,value,true)));
  const content=new Map<string,File>([
    ['DEV/complex.dev',file(`SOLIDMODELS.NUM=2\nSOLIDMODEL0=a.phm\nTRANSFORMMATRIX0=${move(1000,0,0)}\nSOLIDMODEL1=b.phm`,'complex.dev')],
    ['PHM/a.phm',file(`SOLIDMODELS.NUM=1\nSOLIDMODEL0=nested.phm\nTRANSFORMMATRIX0=${rotateScale}`,'a.phm')],
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
      const color=[material.type,material.color?.getHexString()??'none',material.emissive?.getHexString()??'none',
        material.side,material.transparent,material.depthWrite,
        Math.round((material.opacity??1)*1000),Math.round((material.metalness??0)*1000),
        Math.round((material.roughness??0)*1000)].join(':');
      const count=index?.count??position.count;
      for(let i=0;i+2<count;i+=3){
        const normal=geometry.getAttribute('normal'),normalMatrix=new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
        const vertex=[0,1,2].map(offset=>{
          const at=index?.getX(i+offset)??i+offset;
          const point=new THREE.Vector3().fromBufferAttribute(position,at).applyMatrix4(mesh.matrixWorld)
            .toArray().map(n=>Math.round(n*10000)).join(',');
          const n=normal?new THREE.Vector3().fromBufferAttribute(normal,at).applyMatrix3(normalMatrix).normalize()
            .toArray().map(value=>Math.round(value*1000)).join(','):'none';
          return `${point}/${n}`;
        });
        const cyclic=[vertex.join('|'),[vertex[1],vertex[2],vertex[0]].join('|'),[vertex[2],vertex[0],vertex[1]].join('|')].sort()[0];
        triangles.push(`${color}:${cyclic}`);
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
