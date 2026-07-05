import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import {
  primitiveToGeometry,
  entityToMesh,
  xmlModDocumentToGroup,
} from '../xmlModGeometry.js';
import { parseXmlMod } from '../../gim/geometry/xmlModParser.js';
import type {
  XmlModEntity,
  XmlModPrimitive,
  XmlModColor,
} from '../../gim/geometry/ir.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 构造一个最小 Entity 用于测试 */
function makeEntity(
  primitive: XmlModPrimitive,
  opts: { id?: number; visible?: boolean; matrix?: number[]; color?: XmlModColor } = {},
): XmlModEntity {
  return {
    id: opts.id ?? 0,
    type: 'simple',
    visible: opts.visible ?? true,
    primitive,
    transformMatrix: opts.matrix ?? IDENTITY,
    color: opts.color,
  };
}

describe('primitiveToGeometry', () => {
  describe('强类型 primitive（11 类）', () => {
    it('Cylinder → CylinderGeometry 顶点数正确', () => {
      const g = primitiveToGeometry({ type: 'Cylinder', r: 50, h: 300 });
      expect(g).toBeInstanceOf(THREE.CylinderGeometry);
      const cg = g as THREE.CylinderGeometry;
      expect(cg.parameters.radiusTop).toBe(50);
      expect(cg.parameters.radiusBottom).toBe(50);
      expect(cg.parameters.height).toBe(300);
      expect(cg.parameters.radialSegments).toBe(32);
      // 顶点数 > 0
      expect(g.attributes.position.count).toBeGreaterThan(0);
    });

    it('Cuboid → BoxGeometry 尺寸正确', () => {
      // 实现使用 BoxGeometry(l, w, h) → width=l, height=w, depth=h
      // （Three.js BoxGeometry 参数顺序固定为 width/height/depth，GIM 的 l/w/h 与之直接对应）
      const g = primitiveToGeometry({ type: 'Cuboid', l: 800, w: 600, h: 2000 });
      expect(g).toBeInstanceOf(THREE.BoxGeometry);
      const bg = g as THREE.BoxGeometry;
      expect(bg.parameters.width).toBe(800);
      expect(bg.parameters.height).toBe(600);
      expect(bg.parameters.depth).toBe(2000);
      // BoxGeometry 8 角 × 6 面 = 24 顶点（去重前）
      expect(g.attributes.position.count).toBe(24);
    });

    it('Sphere → SphereGeometry 参数正确', () => {
      const g = primitiveToGeometry({ type: 'Sphere', r: 50 });
      expect(g).toBeInstanceOf(THREE.SphereGeometry);
      const sg = g as THREE.SphereGeometry;
      expect(sg.parameters.radius).toBe(50);
    });

    it('TruncatedCone → CylinderGeometry（顶/底半径不同）', () => {
      const g = primitiveToGeometry({ type: 'TruncatedCone', br: 100, tr: 50, h: 200 });
      expect(g).toBeInstanceOf(THREE.CylinderGeometry);
      const cg = g as THREE.CylinderGeometry;
      expect(cg.parameters.radiusTop).toBe(50);
      expect(cg.parameters.radiusBottom).toBe(100);
      expect(cg.parameters.height).toBe(200);
    });

    it('Ring → TorusGeometry 参数正确', () => {
      const g = primitiveToGeometry({ type: 'Ring', r: 100, dr: 20, rad: 3.14 });
      expect(g).toBeInstanceOf(THREE.TorusGeometry);
      const tg = g as THREE.TorusGeometry;
      expect(tg.parameters.radius).toBe(100);
      expect(tg.parameters.tube).toBe(10);
      expect(tg.parameters.arc).toBe(3.14);
    });

    it('CircularGasket → TorusGeometry（外/内环推导管半径）', () => {
      const g = primitiveToGeometry({
        type: 'CircularGasket',
        h: 10,
        rad: 6.28,
        or: 100,
        ir: 80,
      });
      expect(g).toBeInstanceOf(THREE.TorusGeometry);
      const tg = g as THREE.TorusGeometry;
      expect(tg.parameters.radius).toBe(100);
      // 管半径 = (OR - IR) / 2 = 10
      expect(tg.parameters.tube).toBe(10);
    });

    it('PorcelainBushing → CylinderGeometry（伞裙结构 P1 实现，P0 简化）', () => {
      const g = primitiveToGeometry({
        type: 'PorcelainBushing',
        r: 30,
        r1: 45,
        r2: 25,
        n: 8,
        h: 500,
      });
      expect(g).toBeInstanceOf(THREE.CylinderGeometry);
      const cg = g as THREE.CylinderGeometry;
      // P0 简化：top=R1，bottom=R
      expect(cg.parameters.radiusTop).toBe(45);
      expect(cg.parameters.radiusBottom).toBe(30);
      expect(cg.parameters.height).toBe(500);
    });

    it('TerminalBlock → BoxGeometry 简化', () => {
      const g = primitiveToGeometry({
        type: 'TerminalBlock',
        l: 200,
        w: 100,
        h: 50,
        t: 10,
        r: 5,
        bl: 20,
        cl: 30,
        cs: 40,
        rs: 50,
        cn: 6,
        rn: 3,
        phase: 'A',
      });
      expect(g).toBeInstanceOf(THREE.BoxGeometry);
      const bg = g as THREE.BoxGeometry;
      // BoxGeometry(l, w, h) → width=l, height=w, depth=h
      expect(bg.parameters.width).toBe(200);
      expect(bg.parameters.height).toBe(100);
      expect(bg.parameters.depth).toBe(50);
    });

    it('ChannelSteel → BoxGeometry 简化', () => {
      const g = primitiveToGeometry({
        type: 'ChannelSteel',
        l: 2000,
        model: 'C5',
        d: 50,
        h: 100,
        b: 40,
        t: 8,
      });
      expect(g).toBeInstanceOf(THREE.BoxGeometry);
      const bg = g as THREE.BoxGeometry;
      expect(bg.parameters.width).toBe(2000);
      expect(bg.parameters.height).toBe(100);
      expect(bg.parameters.depth).toBe(40);
    });

    it('Table → BoxGeometry 简化（仅台面）', () => {
      const g = primitiveToGeometry({
        type: 'Table',
        h: 750,
        ll1: 800,
        ll2: 600,
        tl1: 80,
        tl2: 60,
      });
      expect(g).toBeInstanceOf(THREE.BoxGeometry);
      const bg = g as THREE.BoxGeometry;
      expect(bg.parameters.width).toBe(800);
      expect(bg.parameters.height).toBe(750);
      expect(bg.parameters.depth).toBe(600);
    });

    it('StretchedBody → ExtrudeGeometry 沿 Z 轴拉伸', () => {
      const g = primitiveToGeometry({
        type: 'StretchedBody',
        l: 200,
        array: '0,0;100,0;100,50;0,50',
        normal: '0,0,1',
      });
      expect(g).toBeInstanceOf(THREE.ExtrudeGeometry);
      // boundingBox: x [0,100], y [0,50], z [0,200]（沿 Z 轴拉伸 200）
      g.computeBoundingBox();
      const box = g.boundingBox!;
      expect(box.min.x).toBeCloseTo(0, 5);
      expect(box.max.x).toBeCloseTo(100, 5);
      expect(box.min.y).toBeCloseTo(0, 5);
      expect(box.max.y).toBeCloseTo(50, 5);
      expect(box.min.z).toBeCloseTo(0, 5);
      expect(box.max.z).toBeCloseTo(200, 5);
    });

    it('StretchedBody 沿 Y 轴拉伸（Normal=0,1,0）', () => {
      const g = primitiveToGeometry({
        type: 'StretchedBody',
        l: 100,
        array: '0,0;50,0;50,50;0,50',
        normal: '0,1,0',
      });
      expect(g).toBeInstanceOf(THREE.ExtrudeGeometry);
      g.computeBoundingBox();
      const box = g.boundingBox!;
      // 形状原本在 XY 平面，被旋转到 XZ 平面后拉伸 Y
      // 旋转 Z+ → Y+ 会把 (x,y,z) 映射到 (x, z, -y)
      // 原 extrude 后范围 x[0,50] y[0,50] z[0,100] → 旋转后 x[0,50] y[0,100] z[-50,0]
      expect(box.max.y).toBeCloseTo(100, 5);
      // X 范围保留
      expect(box.max.x).toBeCloseTo(50, 5);
      // Z 范围跨度 = 原 Y 范围跨度（50），方向被翻转到 -Z
      expect(box.max.z - box.min.z).toBeCloseTo(50, 5);
    });

    it('StretchedBody.Normal 长度 304.8 自动归一化', () => {
      const g = primitiveToGeometry({
        type: 'StretchedBody',
        l: 100,
        array: '0,0;10,0;10,10;0,10',
        normal: '0,0,304.8',
      });
      expect(g).toBeInstanceOf(THREE.ExtrudeGeometry);
      g.computeBoundingBox();
      const box = g.boundingBox!;
      // Normal 归一化后仍是 (0,0,1)，拉伸应沿 Z 轴
      expect(box.max.z).toBeCloseTo(100, 5);
    });

    it('StretchedBody.Array 含 3D 点（取前 2 个分量）', () => {
      const g = primitiveToGeometry({
        type: 'StretchedBody',
        l: 50,
        array: '0,0,0;20,0,0;20,10,0;0,10,0',
        normal: '0,0,1',
      });
      expect(g).toBeInstanceOf(THREE.ExtrudeGeometry);
      g.computeBoundingBox();
      const box = g.boundingBox!;
      expect(box.max.x).toBeCloseTo(20, 5);
      expect(box.max.y).toBeCloseTo(10, 5);
      expect(box.max.z).toBeCloseTo(50, 5);
    });
  });

  describe('弱 schema primitive（3 类）', () => {
    it('RectangularFixedPlate → BoxGeometry 占位 + warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const g = primitiveToGeometry({
        type: 'RectangularFixedPlate',
        raw: { L: '100', W: '50', T: '10' },
      });
      expect(g).toBeInstanceOf(THREE.BoxGeometry);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('RectangularFixedPlate');
      warnSpy.mockRestore();
    });

    it('OffsetRectangularTable → BoxGeometry 占位 + warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const g = primitiveToGeometry({
        type: 'OffsetRectangularTable',
        raw: { H: '50', L: '200' },
      });
      expect(g).toBeInstanceOf(THREE.BoxGeometry);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('RectangularRing → BoxGeometry 占位 + warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const g = primitiveToGeometry({
        type: 'RectangularRing',
        raw: { R: '100', DR: '20' },
      });
      expect(g).toBeInstanceOf(THREE.BoxGeometry);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });

  describe('NaN 数值安全化', () => {
    it('Cylinder 含 NaN → 按 0 处理', () => {
      const g = primitiveToGeometry({ type: 'Cylinder', r: NaN, h: NaN });
      expect(g).toBeInstanceOf(THREE.CylinderGeometry);
      const cg = g as THREE.CylinderGeometry;
      expect(cg.parameters.radiusTop).toBe(0);
      expect(cg.parameters.height).toBe(0);
    });
  });
});

describe('entityToMesh', () => {
  describe('primitive → mesh', () => {
    it('Cuboid → mesh geometry 为 BoxGeometry', () => {
      const e = makeEntity({ type: 'Cuboid', l: 100, w: 200, h: 300 });
      const mesh = entityToMesh(e);
      expect(mesh.geometry).toBeInstanceOf(THREE.BoxGeometry);
    });

    it('Cylinder → mesh geometry 为 CylinderGeometry', () => {
      const e = makeEntity({ type: 'Cylinder', r: 50, h: 300 });
      const mesh = entityToMesh(e);
      expect(mesh.geometry).toBeInstanceOf(THREE.CylinderGeometry);
    });
  });

  describe('TransformMatrix 应用', () => {
    it('单位矩阵 → mesh.position = (0,0,0)，mesh.quaternion = identity', () => {
      const e = makeEntity(
        { type: 'Cuboid', l: 100, w: 100, h: 100 },
        { matrix: IDENTITY },
      );
      const mesh = entityToMesh(e);
      expect(mesh.position.x).toBe(0);
      expect(mesh.position.y).toBe(0);
      expect(mesh.position.z).toBe(0);
      expect(mesh.quaternion.x).toBe(0);
      expect(mesh.quaternion.y).toBe(0);
      expect(mesh.quaternion.z).toBe(0);
      expect(mesh.quaternion.w).toBe(1);
    });

    it('平移矩阵 → mesh.position 正确', () => {
      // 行主序平移矩阵：translation (100, 200, 50)
      // 1,0,0,100, 0,1,0,200, 0,0,1,50, 0,0,0,1
      const matrix = [1, 0, 0, 100, 0, 1, 0, 200, 0, 0, 1, 50, 0, 0, 0, 1];
      const e = makeEntity(
        { type: 'Cuboid', l: 100, w: 100, h: 100 },
        { matrix },
      );
      const mesh = entityToMesh(e);
      expect(mesh.position.x).toBe(100);
      expect(mesh.position.y).toBe(200);
      expect(mesh.position.z).toBe(50);
    });

    it('非 16 长度矩阵 → 不应用变换（mesh.position 保持原点）', () => {
      const e = makeEntity(
        { type: 'Cuboid', l: 100, w: 100, h: 100 },
        { matrix: [1, 0, 0, 0] }, // 长度 4
      );
      const mesh = entityToMesh(e);
      expect(mesh.position.x).toBe(0);
      expect(mesh.position.y).toBe(0);
      expect(mesh.position.z).toBe(0);
    });
  });

  describe('Color 应用', () => {
    it('缺失 color → 默认灰色不透明材质', () => {
      const e = makeEntity({ type: 'Cuboid', l: 100, w: 100, h: 100 });
      const mesh = entityToMesh(e);
      const mat = mesh.material as THREE.MeshStandardMaterial;
      expect(mat).toBeInstanceOf(THREE.MeshStandardMaterial);
      // 默认灰色 0x888888（sRGB hex，避开 ColorManagement 的 sRGB↔linear 转换）
      expect(mat.color.getHex()).toBe(0x888888);
      expect(mat.transparent).toBe(false);
      expect(mat.opacity).toBe(1);
    });

    it('R/G/B/A 全值 → material.color 与 opacity 正确', () => {
      const color: XmlModColor = { r: 200, g: 50, b: 50, a: 80 };
      const e = makeEntity({ type: 'Cuboid', l: 100, w: 100, h: 100 }, { color });
      const mesh = entityToMesh(e);
      const mat = mesh.material as THREE.MeshStandardMaterial;
      // 实现按 (r<<16)|(g<<8)|b 拼成 sRGB hex，由 THREE.Color 按 sRGB 解释
      // getHex() 在 ColorManagement 开启时返回 sRGB hex，可无损回环比较
      expect(mat.color.getHex()).toBe((200 << 16) | (50 << 8) | 50);
      expect(mat.transparent).toBe(true);
      expect(mat.opacity).toBeCloseTo(0.8, 4);
    });

    it('A=100 → 不透明材质', () => {
      const color: XmlModColor = { r: 128, g: 128, b: 128, a: 100 };
      const e = makeEntity({ type: 'Cuboid', l: 100, w: 100, h: 100 }, { color });
      const mesh = entityToMesh(e);
      const mat = mesh.material as THREE.MeshStandardMaterial;
      expect(mat.transparent).toBe(false);
      expect(mat.opacity).toBe(1);
    });

    it('A=0 → 完全透明', () => {
      const color: XmlModColor = { r: 0, g: 0, b: 0, a: 0 };
      const e = makeEntity({ type: 'Cuboid', l: 100, w: 100, h: 100 }, { color });
      const mesh = entityToMesh(e);
      const mat = mesh.material as THREE.MeshStandardMaterial;
      expect(mat.transparent).toBe(true);
      expect(mat.opacity).toBe(0);
    });
  });

  describe('Visible 属性', () => {
    it('Visible=True → mesh.visible = true', () => {
      const e = makeEntity(
        { type: 'Cuboid', l: 100, w: 100, h: 100 },
        { visible: true },
      );
      const mesh = entityToMesh(e);
      expect(mesh.visible).toBe(true);
    });

    it('Visible=False → mesh.visible = false（不在 entityToMesh 中处理，由 xmlModDocumentToGroup 控制）', () => {
      // entityToMesh 不读 visible，由 xmlModDocumentToGroup 设置
      const e = makeEntity(
        { type: 'Cuboid', l: 100, w: 100, h: 100 },
        { visible: false },
      );
      const mesh = entityToMesh(e);
      // entityToMesh 不感知 visible，由调用方决定
      expect(mesh.visible).toBe(true); // 默认 true
    });
  });
});

describe('xmlModDocumentToGroup', () => {
  it('EMPTY_DEVICE_XML → Group 为空', () => {
    const xml = '<?xml version="1.0"?><Device><Entities /></Device>';
    const doc = parseXmlMod(xml, 'MOD/empty.mod');
    const group = xmlModDocumentToGroup(doc);
    expect(group.children.length).toBe(0);
    expect(group.name).toBe('xml-mod:MOD/empty.mod');
  });

  it('单 Entity → Group 含 1 个 mesh', () => {
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
    const doc = parseXmlMod(xml, 'MOD/cyl.mod');
    const group = xmlModDocumentToGroup(doc);
    expect(group.children.length).toBe(1);
    const mesh = group.children[0] as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.geometry).toBeInstanceOf(THREE.CylinderGeometry);
  });

  it('多 Entity（含 Visible=False）→ Visible=False 的 mesh.visible=false', () => {
    const xml = `<?xml version="1.0"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <Cuboid L="100" W="100" H="100" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="128" G="128" B="128" A="100" />
    </Entity>
    <Entity ID="1" Type="simple" Visible="False">
      <Cuboid L="200" W="200" H="200" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="0" G="0" B="0" A="0" />
    </Entity>
  </Entities>
</Device>`;
    const doc = parseXmlMod(xml, 'MOD/multi.mod');
    const group = xmlModDocumentToGroup(doc);
    expect(group.children.length).toBe(2);
    expect((group.children[0] as THREE.Mesh).visible).toBe(true);
    expect((group.children[1] as THREE.Mesh).visible).toBe(false);
  });

  it('TransformMatrix 平移保留到 group 内 mesh.position', () => {
    const xml = `<?xml version="1.0"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <Cuboid L="100" W="100" H="100" />
      <TransformMatrix Value="1,0,0,100,0,1,0,200,0,0,1,50,0,0,0,1" />
      <Color R="100" G="100" B="100" A="100" />
    </Entity>
  </Entities>
</Device>`;
    const doc = parseXmlMod(xml, 'MOD/translate.mod');
    const group = xmlModDocumentToGroup(doc);
    const mesh = group.children[0] as THREE.Mesh;
    expect(mesh.position.x).toBe(100);
    expect(mesh.position.y).toBe(200);
    expect(mesh.position.z).toBe(50);
  });

  it('Group.name 包含 modPath', () => {
    const xml = `<?xml version="1.0"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <Cuboid L="100" W="100" H="100" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="100" G="100" B="100" A="100" />
    </Entity>
  </Entities>
</Device>`;
    const doc = parseXmlMod(xml, 'MOD/abc-123.mod');
    const group = xmlModDocumentToGroup(doc);
    expect(group.name).toBe('xml-mod:MOD/abc-123.mod');
  });
});
