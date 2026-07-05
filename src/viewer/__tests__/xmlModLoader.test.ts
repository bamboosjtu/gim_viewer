import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import {
  loadXmlModFromText,
  loadXmlModFromFiles,
  rowMajorToMatrix4,
  applyExternalTransforms,
  disposeXmlModGroup,
} from '../xmlModLoader.js';

describe('loadXmlModFromText', () => {
  it('有效 MOD XML → Group 含 mesh', () => {
    const xml = `<?xml version="1.0"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <Cylinder R="50" H="300" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="200" G="50" B="50" A="100" />
    </Entity>
  </Entities>
</Device>`;
    const group = loadXmlModFromText(xml, 'MOD/test.mod');
    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.children.length).toBe(1);
    expect(group.name).toBe('xml-mod:MOD/test.mod');
    const mesh = group.children[0] as THREE.Mesh;
    expect(mesh.geometry).toBeInstanceOf(THREE.CylinderGeometry);
  });

  it('EMPTY_DEVICE_XML → 空 Group', () => {
    const xml = '<?xml version="1.0"?><Device><Entities /></Device>';
    const group = loadXmlModFromText(xml, 'MOD/empty.mod');
    expect(group.children.length).toBe(0);
    expect(group.name).toBe('xml-mod:MOD/empty.mod');
  });

  it('无效 XML → 抛错', () => {
    const invalid = 'not xml at all';
    expect(() => loadXmlModFromText(invalid, 'MOD/bad.mod')).toThrow();
  });

  it('root 非 Device → 抛错', () => {
    const xml = '<?xml version="1.0"?><NotDevice></NotDevice>';
    expect(() => loadXmlModFromText(xml, 'MOD/bad.mod')).toThrow(/Device/);
  });

  it('多 Entity → Group 含多个 mesh', () => {
    const xml = `<?xml version="1.0"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <Cuboid L="100" W="100" H="100" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="128" G="128" B="128" A="100" />
    </Entity>
    <Entity ID="1" Type="simple" Visible="True">
      <Sphere R="50" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="50" G="200" B="50" A="100" />
    </Entity>
  </Entities>
</Device>`;
    const group = loadXmlModFromText(xml, 'MOD/multi.mod');
    expect(group.children.length).toBe(2);
  });
});

describe('loadXmlModFromFiles', () => {
  it('文件存在 → 返回 Group', async () => {
    const xml = `<?xml version="1.0"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <Cylinder R="50" H="300" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="200" G="50" B="50" A="100" />
    </Entity>
  </Entities>
</Device>`;
    const files = new Map<string, File>([
      ['MOD/abc.mod', new File([xml], 'abc.mod', { type: 'application/xml' })],
    ]);
    const group = await loadXmlModFromFiles('MOD/abc.mod', files);
    expect(group).not.toBeNull();
    expect(group!.children.length).toBe(1);
  });

  it('文件不存在 → 返回 null + warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const files = new Map<string, File>();
    const group = await loadXmlModFromFiles('MOD/missing.mod', files);
    expect(group).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('MOD/missing.mod');
    warnSpy.mockRestore();
  });

  it('XML 解析失败 → 返回 null + error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const files = new Map<string, File>([
      ['MOD/bad.mod', new File(['not xml'], 'bad.mod', { type: 'text/plain' })],
    ]);
    const group = await loadXmlModFromFiles('MOD/bad.mod', files);
    expect(group).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});

describe('rowMajorToMatrix4', () => {
  it('有效 16 元素列主序 → 正确 Matrix4', () => {
    // GIM 矩阵为列主序展开，平移在 [12]/[13]/[14]
    // 等同 Three.js Matrix4.elements 布局，使用 fromArray 直接加载
    const arr = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 200, 50, 1];
    const m = rowMajorToMatrix4(arr);
    expect(m.elements[12]).toBe(100);
    expect(m.elements[13]).toBe(200);
    expect(m.elements[14]).toBe(50);
  });

  it('单位矩阵 → Matrix4 identity', () => {
    const arr = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const m = rowMajorToMatrix4(arr);
    expect(m.elements[0]).toBe(1);
    expect(m.elements[5]).toBe(1);
    expect(m.elements[10]).toBe(1);
    expect(m.elements[15]).toBe(1);
  });

  it('长度不为 16 → 返回单位矩阵', () => {
    const m = rowMajorToMatrix4([1, 0, 0, 0]);
    expect(m.elements[0]).toBe(1);
    expect(m.elements[5]).toBe(1);
    expect(m.elements[10]).toBe(1);
    expect(m.elements[15]).toBe(1);
  });

  it('空数组 → 返回单位矩阵', () => {
    const m = rowMajorToMatrix4([]);
    expect(m.elements[0]).toBe(1);
    expect(m.elements[5]).toBe(1);
    expect(m.elements[10]).toBe(1);
    expect(m.elements[15]).toBe(1);
  });
});

describe('applyExternalTransforms', () => {
  it('单位矩阵 + 单位矩阵 → Group 不变形', () => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
    mesh.position.set(5, 5, 5);
    group.add(mesh);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    applyExternalTransforms(group, identity, identity);
    expect(mesh.position.x).toBe(5);
    expect(mesh.position.y).toBe(5);
    expect(mesh.position.z).toBe(5);
  });

  it('PHM 平移 + DEV 单位 → group.position 反映 PHM 平移', () => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
    group.add(mesh);
    const devMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    // 列主序，平移在 [12]/[13]/[14]
    const phmMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 200, 50, 1];
    applyExternalTransforms(group, devMatrix, phmMatrix);
    expect(group.position.x).toBe(100);
    expect(group.position.y).toBe(200);
    expect(group.position.z).toBe(50);
  });

  it('PHM 单位 + DEV 平移 → group.position 反映 DEV 平移', () => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
    group.add(mesh);
    // DEV: 平移 (100, 200, 50)（列主序）
    const devMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 200, 50, 1];
    const phmMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    applyExternalTransforms(group, devMatrix, phmMatrix);
    expect(group.position.x).toBe(100);
    expect(group.position.y).toBe(200);
    expect(group.position.z).toBe(50);
  });

  it('PHM 平移 + DEV 平移 → 累加平移', () => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
    group.add(mesh);
    // PHM: 平移 (100, 0, 0)（列主序）
    const phmMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1];
    // DEV: 平移 (0, 200, 0)（列主序）
    const devMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 200, 0, 1];
    applyExternalTransforms(group, devMatrix, phmMatrix);
    // final = DEV × PHM × origin = (100, 200, 0)
    expect(group.position.x).toBe(100);
    expect(group.position.y).toBe(200);
    expect(group.position.z).toBe(0);
  });
});

describe('disposeXmlModGroup', () => {
  it('遍历 Group 释放所有 mesh 的 geometry + material', () => {
    const group = new THREE.Group();
    const geo1 = new THREE.BoxGeometry(1, 1, 1);
    const mat1 = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const mesh1 = new THREE.Mesh(geo1, mat1);
    group.add(mesh1);

    const geo2 = new THREE.SphereGeometry(1);
    const mat2 = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    const mesh2 = new THREE.Mesh(geo2, mat2);
    group.add(mesh2);

    // 嵌套 Group
    const childGroup = new THREE.Group();
    const geo3 = new THREE.CylinderGeometry(1, 1, 1);
    const mat3 = new THREE.MeshStandardMaterial({ color: 0x0000ff });
    const mesh3 = new THREE.Mesh(geo3, mat3);
    childGroup.add(mesh3);
    group.add(childGroup);

    const disposeSpy1 = vi.spyOn(geo1, 'dispose');
    const disposeSpy2 = vi.spyOn(geo2, 'dispose');
    const disposeSpy3 = vi.spyOn(geo3, 'dispose');
    const matSpy1 = vi.spyOn(mat1, 'dispose');
    const matSpy2 = vi.spyOn(mat2, 'dispose');
    const matSpy3 = vi.spyOn(mat3, 'dispose');

    disposeXmlModGroup(group);

    expect(disposeSpy1).toHaveBeenCalledTimes(1);
    expect(disposeSpy2).toHaveBeenCalledTimes(1);
    expect(disposeSpy3).toHaveBeenCalledTimes(1);
    expect(matSpy1).toHaveBeenCalledTimes(1);
    expect(matSpy2).toHaveBeenCalledTimes(1);
    expect(matSpy3).toHaveBeenCalledTimes(1);
  });

  it('mesh 含材质数组 → 全部释放', () => {
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat1 = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const mat2 = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    const mesh = new THREE.Mesh(geo, [mat1, mat2]);
    group.add(mesh);

    const spy1 = vi.spyOn(mat1, 'dispose');
    const spy2 = vi.spyOn(mat2, 'dispose');

    disposeXmlModGroup(group);
    expect(spy1).toHaveBeenCalledTimes(1);
    expect(spy2).toHaveBeenCalledTimes(1);
  });

  it('空 Group → 不抛错', () => {
    const group = new THREE.Group();
    expect(() => disposeXmlModGroup(group)).not.toThrow();
  });
});
