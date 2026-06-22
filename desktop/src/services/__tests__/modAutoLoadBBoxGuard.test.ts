import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { diagnoseGroupBBox } from '../modAutoLoadService.js';

function makeBoxGroup(sizeM: number, centerM: [number, number, number] = [0, 0, 0]): THREE.Group {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(sizeM, sizeM, sizeM);
  geo.translate(centerM[0], centerM[1], centerM[2]);
  group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()));
  return group;
}

describe('diagnoseGroupBBox（DEV 粒度守卫）', () => {
  it('全站尺度系统（跨度 112m，如电缆沟）正常通过', () => {
    const group = makeBoxGroup(112);
    expect(diagnoseGroupBBox(group, 'MOD/site-wide.mod')).toBe(true);
  });

  it('站点尺度平移（中心距原点 800m）正常通过', () => {
    const group = makeBoxGroup(10, [800, 0, 0]);
    expect(diagnoseGroupBBox(group, 'MOD/far.mod')).toBe(true);
  });

  it('单位错误（跨度 12km，mm/m 混淆）被拒', () => {
    const group = makeBoxGroup(12000);
    expect(diagnoseGroupBBox(group, 'MOD/unit-error.mod')).toBe(false);
  });

  it('平移失控（几何正常但中心在 100km 外）被拒', () => {
    const group = makeBoxGroup(10, [100000, 0, 0]);
    expect(diagnoseGroupBBox(group, 'MOD/runaway-translation.mod')).toBe(false);
  });

  it('NaN 尺寸被拒', () => {
    const group = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([NaN, NaN, NaN], 3));
    group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()));
    expect(diagnoseGroupBBox(group, 'MOD/nan.mod')).toBe(false);
  });

  it('空几何被拒', () => {
    const group = new THREE.Group();
    expect(diagnoseGroupBBox(group, 'MOD/empty.mod')).toBe(false);
  });
});
