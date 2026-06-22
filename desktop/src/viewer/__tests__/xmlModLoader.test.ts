import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import {
  loadXmlModFromText,
  loadXmlModFromFiles,
  columnMajorToMatrix4,
  disposeXmlModGroup,
} from '../xmlModLoader.js';

describe('loadXmlModFromText', () => {
  it('StretchedBody MOD 会生成可渲染网格而不是空 Group', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Device><Entities><Entity ID="1" Type="simple" Visible="True">
  <StretchedBody Array="0,0,0;100,0,0;100,50,0;0,50,0;" Normal="0,0,304.8" L="20" />
  <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
  <Color R="215" G="215" B="215" A="100" />
</Entity></Entities></Device>`;

    const group = loadXmlModFromText(xml, 'MOD/stretched.mod');
    expect(group.children).toHaveLength(1);
    expect(group.children[0]).toBeInstanceOf(THREE.Mesh);
    expect(new THREE.Box3().setFromObject(group).isEmpty()).toBe(false);
  });

  it('StretchedBody 可与同材质内置几何合并为一个 Mesh', () => {
    const xml = `<?xml version="1.0"?><Device><Entities>
<Entity ID="1" Type="simple" Visible="True">
  <StretchedBody Array="0,0,0;100,0,0;100,50,0;0,50,0;" Normal="0,0,1" L="20" />
  <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
  <Color R="215" G="215" B="215" A="100" />
</Entity>
<Entity ID="2" Type="simple" Visible="True">
  <Cuboid L="100" W="50" H="20" />
  <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,200,0,0,1" />
  <Color R="215" G="215" B="215" A="100" />
</Entity>
</Entities></Device>`;

    const group = loadXmlModFromText(xml, 'MOD/stretched-mixed.mod');
    expect(group.children).toHaveLength(1);
    expect(group.children[0]).toBeInstanceOf(THREE.Mesh);
  });

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
    // 方案 B 按 Material 合并后保留的是烘焙后的 BufferGeometry。
    expect(mesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
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

describe('columnMajorToMatrix4', () => {
  it('有效 16 元素列主序 → 正确 Matrix4', () => {
    // GIM 矩阵为列主序展开，平移在 [12]/[13]/[14]
    // 等同 Three.js Matrix4.elements 布局，使用 fromArray 直接加载
    const arr = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 200, 50, 1];
    const m = columnMajorToMatrix4(arr);
    expect(m.elements[12]).toBe(100);
    expect(m.elements[13]).toBe(200);
    expect(m.elements[14]).toBe(50);
  });

  it('单位矩阵 → Matrix4 identity', () => {
    const arr = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const m = columnMajorToMatrix4(arr);
    expect(m.elements[0]).toBe(1);
    expect(m.elements[5]).toBe(1);
    expect(m.elements[10]).toBe(1);
    expect(m.elements[15]).toBe(1);
  });

  it('长度不为 16 → 返回单位矩阵', () => {
    const m = columnMajorToMatrix4([1, 0, 0, 0]);
    expect(m.elements[0]).toBe(1);
    expect(m.elements[5]).toBe(1);
    expect(m.elements[10]).toBe(1);
    expect(m.elements[15]).toBe(1);
  });

  it('空数组 → 返回单位矩阵', () => {
    const m = columnMajorToMatrix4([]);
    expect(m.elements[0]).toBe(1);
    expect(m.elements[5]).toBe(1);
    expect(m.elements[10]).toBe(1);
    expect(m.elements[15]).toBe(1);
  });
});

describe('disposeXmlModGroup', () => {
  it('方案 B：释放 Group 独有的 merged geometry，但保留共享 material', () => {
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

    const geoSpy1 = vi.spyOn(geo1, 'dispose');
    const geoSpy2 = vi.spyOn(geo2, 'dispose');
    const geoSpy3 = vi.spyOn(geo3, 'dispose');
    const matSpy1 = vi.spyOn(mat1, 'dispose');
    const matSpy2 = vi.spyOn(mat2, 'dispose');
    const matSpy3 = vi.spyOn(mat3, 'dispose');

    disposeXmlModGroup(group);

    expect(geoSpy1).toHaveBeenCalledTimes(1);
    expect(geoSpy2).toHaveBeenCalledTimes(1);
    expect(geoSpy3).toHaveBeenCalledTimes(1);
    expect(matSpy1).not.toHaveBeenCalled();
    expect(matSpy2).not.toHaveBeenCalled();
    expect(matSpy3).not.toHaveBeenCalled();
  });

  it('空 Group → 不抛错', () => {
    const group = new THREE.Group();
    expect(() => disposeXmlModGroup(group)).not.toThrow();
  });
});
