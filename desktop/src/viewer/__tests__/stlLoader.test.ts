import { describe, it, expect } from 'vitest';
import { parseStlBinary, parseStlAscii, disposeStlGroup } from '../stlLoader.js';

/**
 * 构造 binary STL ArrayBuffer：1 个三角面，顶点在 ±100（mm 量级）。
 */
function makeBinaryStl(): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + 50);
  const dv = new DataView(buffer);
  dv.setUint32(80, 1, true);
  // normal (0,0,1)
  dv.setFloat32(84 + 0, 0, true);
  dv.setFloat32(84 + 4, 0, true);
  dv.setFloat32(84 + 8, 1, true);
  // v0 (-100,-100,0) v1 (100,-100,0) v2 (0,100,0)
  const verts = [-100, -100, 0, 100, -100, 0, 0, 100, 0];
  verts.forEach((v, i) => dv.setFloat32(84 + 12 + i * 4, v, true));
  return buffer;
}

/** 构造 ASCII STL：同样 1 个三角面。 */
function makeAsciiStl(): ArrayBuffer {
  const text = `solid AssimpScene
facet normal 0 0 1
  outer loop
    vertex -100.0 -100.0 0.0
    vertex 100.0 -100.0 0.0
    vertex 0.0 100.0 0.0
  endloop
endfacet
endsolid AssimpScene
`;
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe('parseStlBinary / parseStlAscii', () => {
  it('binary STL：长度公式命中走二进制分支', () => {
    const group = parseStlBinary(makeBinaryStl(), 'MOD/binary.stl');
    expect(group).not.toBeNull();
    const mesh = group!.children[0] as import('three').Mesh;
    const pos = (mesh.geometry.getAttribute('position') as import('three').BufferAttribute).array;
    // mm→m 烘焙：-100mm → -0.1
    expect(pos[0]).toBeCloseTo(-0.1);
    disposeStlGroup(group!);
  });

  it('ASCII STL：solid 头且不满足二进制公式 → ASCII 分支解析', () => {
    const group = parseStlBinary(makeAsciiStl(), 'MOD/ascii.stl');
    expect(group).not.toBeNull();
    const mesh = group!.children[0] as import('three').Mesh;
    const pos = (mesh.geometry.getAttribute('position') as import('three').BufferAttribute).array;
    expect(pos.length).toBe(9);
    expect(pos[0]).toBeCloseTo(-0.1); // mm→m
    expect(pos[7]).toBeCloseTo(0.1);
    disposeStlGroup(group!);
  });

  it('二进制头写 solid 但长度公式命中的文件仍走二进制分支', () => {
    // 构造一个以 "solid" 开头的合法 binary STL
    const buffer = new ArrayBuffer(84 + 50);
    const bytes = new Uint8Array(buffer);
    bytes.set(new TextEncoder().encode('solid'), 0);
    const dv = new DataView(buffer);
    dv.setUint32(80, 1, true);
    const group = parseStlBinary(buffer, 'MOD/solid-header-binary.stl');
    expect(group).not.toBeNull();
    disposeStlGroup(group!);
  });

  it('parseStlAscii 直接调用：空几何返回 null', () => {
    const text = 'solid empty\nendsolid\n';
    const buffer = new TextEncoder().encode(text).buffer as ArrayBuffer;
    expect(parseStlAscii(buffer, 'MOD/empty.stl')).toBeNull();
  });
});
