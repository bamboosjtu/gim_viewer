import {expect,it} from 'vitest';
import {estimateArtifactBytes,isNearArtifactKey} from '../ifcNearCachePolicy.js';
it('accounts shared typed-array backing storage once without expanding mesh vertices',()=>{
  const buffer=new ArrayBuffer(1024);const value={a:new Float32Array(buffer),b:new Uint32Array(buffer)};
  expect(estimateArtifactBytes(value)).toBe(1060);
  const cyclic:any={mesh:buffer};cyclic.self=cyclic;
  expect(estimateArtifactBytes(cyclic)).toBe(1072);
});
it('limits only near templates and properties, leaving far artifacts in their existing domain',()=>{
  expect(isNearArtifactKey('far|sha|steel.ifc')).toBe(false);
  expect(isNearArtifactKey('far|sha|steel.ifc|near-templates-v1|42')).toBe(true);
  expect(isNearArtifactKey('far|sha|steel.ifc|properties|42')).toBe(true);
});
