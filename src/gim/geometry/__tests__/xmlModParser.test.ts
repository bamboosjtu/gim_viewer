import { describe, it, expect } from 'vitest';
import { parseXmlMod } from '../xmlModParser.js';
import type { XmlModEntity, XmlModPrimitive } from '../ir.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 包裹单个 Entity 为完整 Device XML */
function wrap(entityXml: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities>
    ${entityXml}
  </Entities>
</Device>`;
}

describe('parseXmlMod', () => {
  describe('强类型 primitive 解析（11 类）', () => {
    it('Cylinder：R/H 字段', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <Cylinder R="50" H="300" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="200" G="50" B="50" A="100" />
        </Entity>`,
      );
      const doc = parseXmlMod(xml, 'MOD/cylinder.mod');
      expect(doc.isEmpty).toBe(false);
      expect(doc.entities.length).toBe(1);
      const e = doc.entities[0];
      expect(e.id).toBe(0);
      expect(e.type).toBe('simple');
      expect(e.visible).toBe(true);
      const p = e.primitive as Extract<XmlModPrimitive, { type: 'Cylinder' }>;
      expect(p.type).toBe('Cylinder');
      expect(p.r).toBe(50);
      expect(p.h).toBe(300);
      expect(e.transformMatrix).toEqual(IDENTITY);
      expect(e.color).toEqual({ r: 200, g: 50, b: 50, a: 100 });
    });

    it('Cuboid：L/W/H 字段', () => {
      const xml = wrap(
        `<Entity ID="1" Type="simple" Visible="True">
          <Cuboid L="800" W="600" H="2000" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="128" G="128" B="128" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/cuboid.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'Cuboid' }
      >;
      expect(p).toEqual({ type: 'Cuboid', l: 800, w: 600, h: 2000 });
    });

    it('StretchedBody：Array/Normal 保留 string，L 数值', () => {
      const arrayStr = '0,0;100,0;100,50;0,50';
      const normalStr = '0,0,1';
      const xml = wrap(
        `<Entity ID="2" Type="simple" Visible="True">
          <StretchedBody L="200" Array="${arrayStr}" Normal="${normalStr}" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="100" G="150" B="200" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/stretch.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'StretchedBody' }
      >;
      expect(p.type).toBe('StretchedBody');
      expect(p.l).toBe(200);
      expect(p.array).toBe(arrayStr);
      expect(p.normal).toBe(normalStr);
    });

    it('PorcelainBushing：R/R1/R2/N/H 五字段', () => {
      const xml = wrap(
        `<Entity ID="3" Type="simple" Visible="True">
          <PorcelainBushing R="30" R1="45" R2="25" N="8" H="500" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="180" G="180" B="220" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/bushing.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'PorcelainBushing' }
      >;
      expect(p).toEqual({ type: 'PorcelainBushing', r: 30, r1: 45, r2: 25, n: 8, h: 500 });
    });

    it('TruncatedCone：BR/TR/H 字段', () => {
      const xml = wrap(
        `<Entity ID="4" Type="simple" Visible="True">
          <TruncatedCone BR="100" TR="50" H="200" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="120" G="120" B="120" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/cone.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'TruncatedCone' }
      >;
      expect(p).toEqual({ type: 'TruncatedCone', br: 100, tr: 50, h: 200 });
    });

    it('Ring：R/DR/Rad 字段', () => {
      const xml = wrap(
        `<Entity ID="5" Type="simple" Visible="True">
          <Ring R="100" DR="20" Rad="3.14" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="100" G="100" B="100" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/ring.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'Ring' }
      >;
      expect(p).toEqual({ type: 'Ring', r: 100, dr: 20, rad: 3.14 });
    });

    it('TerminalBlock：12 字段含 Phase（字符串）', () => {
      const xml = wrap(
        `<Entity ID="6" Type="simple" Visible="True">
          <TerminalBlock L="200" W="100" H="50" T="10" R="5" BL="20" CL="30" CS="40" RS="50" CN="6" RN="3" Phase="A" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="80" G="80" B="80" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/terminal.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'TerminalBlock' }
      >;
      expect(p).toEqual({
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
    });

    it('TerminalBlock：H 缺失时 h=undefined', () => {
      const xml = wrap(
        `<Entity ID="7" Type="simple" Visible="True">
          <TerminalBlock L="200" W="100" T="10" R="5" BL="20" CL="30" CS="40" RS="50" CN="6" RN="3" Phase="B" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="80" G="80" B="80" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/terminal-no-h.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'TerminalBlock' }
      >;
      expect(p.h).toBeUndefined();
      expect(p.phase).toBe('B');
    });

    it('Sphere：R 字段', () => {
      const xml = wrap(
        `<Entity ID="8" Type="simple" Visible="True">
          <Sphere R="50" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="200" G="0" B="0" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/sphere.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'Sphere' }
      >;
      expect(p).toEqual({ type: 'Sphere', r: 50 });
    });

    it('ChannelSteel：L/Model 必填，D/H/B/T 可选', () => {
      // 全字段
      const full = wrap(
        `<Entity ID="9" Type="simple" Visible="True">
          <ChannelSteel L="2000" Model="C5" D="50" H="100" B="40" T="8" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="100" G="100" B="100" A="100" />
        </Entity>`,
      );
      const p1 = parseXmlMod(full, 'MOD/channel.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'ChannelSteel' }
      >;
      expect(p1).toEqual({
        type: 'ChannelSteel',
        l: 2000,
        model: 'C5',
        d: 50,
        h: 100,
        b: 40,
        t: 8,
      });

      // 仅必填
      const minimal = wrap(
        `<Entity ID="10" Type="simple" Visible="True">
          <ChannelSteel L="1500" Model="C8" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="100" G="100" B="100" A="100" />
        </Entity>`,
      );
      const p2 = parseXmlMod(minimal, 'MOD/channel-min.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'ChannelSteel' }
      >;
      expect(p2.d).toBeUndefined();
      expect(p2.h).toBeUndefined();
      expect(p2.b).toBeUndefined();
      expect(p2.t).toBeUndefined();
      expect(p2.model).toBe('C8');
    });

    it('Table：H/LL1/LL2/TL1/TL2 字段', () => {
      const xml = wrap(
        `<Entity ID="11" Type="simple" Visible="True">
          <Table H="750" LL1="800" LL2="600" TL1="80" TL2="60" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="150" G="100" B="50" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/table.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'Table' }
      >;
      expect(p).toEqual({ type: 'Table', h: 750, ll1: 800, ll2: 600, tl1: 80, tl2: 60 });
    });

    it('CircularGasket：H/Rad/OR/IR 字段', () => {
      const xml = wrap(
        `<Entity ID="12" Type="simple" Visible="True">
          <CircularGasket H="10" Rad="6.28" OR="100" IR="80" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="50" G="50" B="50" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/gasket.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'CircularGasket' }
      >;
      expect(p).toEqual({ type: 'CircularGasket', h: 10, rad: 6.28, or: 100, ir: 80 });
    });
  });

  describe('弱 schema primitive（3 类）', () => {
    it('RectangularFixedPlate：保留 raw 属性', () => {
      const xml = wrap(
        `<Entity ID="13" Type="simple" Visible="True">
          <RectangularFixedPlate L="100" W="50" T="10" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="100" G="100" B="100" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/rfp.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { raw: Record<string, string> }
      >;
      expect(p.type).toBe('RectangularFixedPlate');
      expect(p.raw).toEqual({ L: '100', W: '50', T: '10' });
    });

    it('OffsetRectangularTable：保留 raw 属性', () => {
      const xml = wrap(
        `<Entity ID="14" Type="simple" Visible="True">
          <OffsetRectangularTable H="50" L="200" W="100" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="100" G="100" B="100" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/ort.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { raw: Record<string, string> }
      >;
      expect(p.type).toBe('OffsetRectangularTable');
      expect(p.raw).toEqual({ H: '50', L: '200', W: '100' });
    });

    it('RectangularRing：保留 raw 属性', () => {
      const xml = wrap(
        `<Entity ID="15" Type="simple" Visible="True">
          <RectangularRing R="100" DR="20" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="100" G="100" B="100" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/rr.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { raw: Record<string, string> }
      >;
      expect(p.type).toBe('RectangularRing');
      expect(p.raw).toEqual({ R: '100', DR: '20' });
    });

    it('未识别 primitive：归入弱 schema 并标记 _unknown', () => {
      const xml = wrap(
        `<Entity ID="16" Type="simple" Visible="True">
          <UnknownShape Foo="1" Bar="abc" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="100" G="100" B="100" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/unknown.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { raw: Record<string, string> }
      >;
      expect(p.type).toBe('RectangularRing');
      expect(p.raw._unknown).toBe('UnknownShape');
      expect(p.raw.Foo).toBe('1');
      expect(p.raw.Bar).toBe('abc');
    });
  });

  describe('EMPTY_DEVICE_XML', () => {
    it('<Entities /> 自闭合为空 → isEmpty=true', () => {
      const xml = '<?xml version="1.0" encoding="utf-8"?><Device><Entities /></Device>';
      const doc = parseXmlMod(xml, 'MOD/empty.mod');
      expect(doc.isEmpty).toBe(true);
      expect(doc.entities).toEqual([]);
    });

    it('<Entities></Entities> 显式空 → isEmpty=true', () => {
      const xml = '<?xml version="1.0" encoding="utf-8"?><Device><Entities></Entities></Device>';
      const doc = parseXmlMod(xml, 'MOD/empty2.mod');
      expect(doc.isEmpty).toBe(true);
      expect(doc.entities).toEqual([]);
    });

    it('Device 无 Entities 子节点 → isEmpty=true', () => {
      const xml = '<?xml version="1.0" encoding="utf-8"?><Device></Device>';
      const doc = parseXmlMod(xml, 'MOD/no-entities.mod');
      expect(doc.isEmpty).toBe(true);
      expect(doc.entities).toEqual([]);
    });
  });

  describe('多 Entity 文件', () => {
    it('3 个 Entity，第 3 个 Visible=False', () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <Cuboid L="800" W="600" H="50" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="128" G="128" B="128" A="100" />
    </Entity>
    <Entity ID="1" Type="simple" Visible="True">
      <Cylinder R="25" H="300" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,200,200,25,1" />
      <Color R="200" G="50" B="50" A="100" />
    </Entity>
    <Entity ID="2" Type="simple" Visible="False">
      <Cuboid L="100" W="100" H="100" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="0" G="0" B="0" A="0" />
    </Entity>
  </Entities>
</Device>`;
      const doc = parseXmlMod(xml, 'MOD/multi.mod');
      expect(doc.isEmpty).toBe(false);
      expect(doc.entities.length).toBe(3);
      expect(doc.entities[0].visible).toBe(true);
      expect(doc.entities[1].visible).toBe(true);
      expect(doc.entities[2].visible).toBe(false);
      // 第 2 个 Entity 非单位矩阵，平移位于索引 12/13/14
      expect(doc.entities[1].transformMatrix[12]).toBe(200);
      expect(doc.entities[1].transformMatrix[13]).toBe(200);
      expect(doc.entities[1].transformMatrix[14]).toBe(25);
    });
  });

  describe('TransformMatrix 处理', () => {
    it('缺失 TransformMatrix → 回退单位矩阵', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <Cuboid L="100" W="100" H="100" />
          <Color R="128" G="128" B="128" A="100" />
        </Entity>`,
      );
      const e = parseXmlMod(xml, 'MOD/no-tm.mod').entities[0];
      expect(e.transformMatrix).toEqual(IDENTITY);
    });

    it('Value 长度不为 16 → 回退单位矩阵', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <Cuboid L="100" W="100" H="100" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0" />
          <Color R="128" G="128" B="128" A="100" />
        </Entity>`,
      );
      const e = parseXmlMod(xml, 'MOD/bad-tm-len.mod').entities[0];
      expect(e.transformMatrix).toEqual(IDENTITY);
    });

    it('Value 含 NaN → 回退单位矩阵', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <Cuboid L="100" W="100" H="100" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,abc,0,0,1" />
          <Color R="128" G="128" B="128" A="100" />
        </Entity>`,
      );
      const e = parseXmlMod(xml, 'MOD/nan-tm.mod').entities[0];
      expect(e.transformMatrix).toEqual(IDENTITY);
    });

    it('非单位矩阵正确解析（保留列主序）', () => {
      const tm = '1,0,0,0,0,1,0,0,0,0,1,0,100,200,50,1';
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <Cylinder R="50" H="100" />
          <TransformMatrix Value="${tm}" />
          <Color R="100" G="100" B="100" A="100" />
        </Entity>`,
      );
      const e = parseXmlMod(xml, 'MOD/translate.mod').entities[0];
      expect(e.transformMatrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 200, 50, 1]);
    });
  });

  describe('Color 处理', () => {
    it('缺失 Color → color=undefined', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <Cuboid L="100" W="100" H="100" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
        </Entity>`,
      );
      const e = parseXmlMod(xml, 'MOD/no-color.mod').entities[0];
      expect(e.color).toBeUndefined();
    });

    it('R 超出 0-255 → color=undefined', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <Cuboid L="100" W="100" H="100" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="300" G="100" B="100" A="100" />
        </Entity>`,
      );
      const e = parseXmlMod(xml, 'MOD/bad-r.mod').entities[0];
      expect(e.color).toBeUndefined();
    });

    it('A 超出 0-100 → color=undefined', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <Cuboid L="100" W="100" H="100" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="100" G="100" B="100" A="150" />
        </Entity>`,
      );
      const e = parseXmlMod(xml, 'MOD/bad-a.mod').entities[0];
      expect(e.color).toBeUndefined();
    });

    it('Color 含非数字 → color=undefined', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <Cuboid L="100" W="100" H="100" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="abc" G="100" B="100" A="100" />
        </Entity>`,
      );
      const e = parseXmlMod(xml, 'MOD/bad-color.mod').entities[0];
      expect(e.color).toBeUndefined();
    });

    it('Color 边界值 0 与 255 / 0 与 100 均有效', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <Cuboid L="100" W="100" H="100" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="0" G="0" B="0" A="0" />
        </Entity>`,
      );
      const e = parseXmlMod(xml, 'MOD/black-color.mod').entities[0];
      expect(e.color).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    });
  });

  describe('Entity 属性', () => {
    it('Visible="false"（小写）→ visible=false', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="false">
          <Cuboid L="100" W="100" H="100" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="0" G="0" B="0" A="0" />
        </Entity>`,
      );
      const e = parseXmlMod(xml, 'MOD/invisible.mod').entities[0];
      expect(e.visible).toBe(false);
    });

    it('Visible="TRUE"（大写）→ visible=true', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="TRUE">
          <Cuboid L="100" W="100" H="100" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="0" G="0" B="0" A="0" />
        </Entity>`,
      );
      const e = parseXmlMod(xml, 'MOD/upper.mod').entities[0];
      expect(e.visible).toBe(true);
    });

    it('Visible 属性缺失 → 默认 true', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple">
          <Cuboid L="100" W="100" H="100" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="0" G="0" B="0" A="0" />
        </Entity>`,
      );
      const e = parseXmlMod(xml, 'MOD/no-visible.mod').entities[0];
      expect(e.visible).toBe(true);
    });

    it('ID 缺失 → entity 被跳过', () => {
      const xml = wrap(
        `<Entity Type="simple" Visible="True">
          <Cuboid L="100" W="100" H="100" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="0" G="0" B="0" A="0" />
        </Entity>
        <Entity ID="1" Type="simple" Visible="True">
          <Cuboid L="200" W="200" H="200" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="0" G="0" B="0" A="0" />
        </Entity>`,
      );
      const doc = parseXmlMod(xml, 'MOD/skip-no-id.mod');
      expect(doc.entities.length).toBe(1);
      expect(doc.entities[0].id).toBe(1);
    });

    it('primitive 缺失 → entity 被跳过', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="0" G="0" B="0" A="0" />
        </Entity>`,
      );
      const doc = parseXmlMod(xml, 'MOD/no-primitive.mod');
      expect(doc.entities.length).toBe(0);
      // entity 全部被跳过 → isEmpty=true
      expect(doc.isEmpty).toBe(true);
    });
  });

  describe('数值字段解析失败', () => {
    it('Cuboid L 为非数字 → l=NaN', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <Cuboid L="abc" W="100" H="100" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="100" G="100" B="100" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/bad-l.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'Cuboid' }
      >;
      expect(Number.isNaN(p.l)).toBe(true);
      expect(p.w).toBe(100);
      expect(p.h).toBe(100);
    });

    it('Cylinder R 缺失 → r=NaN', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <Cylinder H="300" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="100" G="100" B="100" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/no-r.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'Cylinder' }
      >;
      expect(Number.isNaN(p.r)).toBe(true);
      expect(p.h).toBe(300);
    });

    it('StretchedBody.Array/Normal 缺失 → 空字符串', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <StretchedBody L="200" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="100" G="100" B="100" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/no-array.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'StretchedBody' }
      >;
      expect(p.array).toBe('');
      expect(p.normal).toBe('');
    });

    it('TerminalBlock.Phase 缺失 → 空字符串', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <TerminalBlock L="200" W="100" T="10" R="5" BL="20" CL="30" CS="40" RS="50" CN="6" RN="3" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="100" G="100" B="100" A="100" />
        </Entity>`,
      );
      const p = parseXmlMod(xml, 'MOD/no-phase.mod').entities[0].primitive as Extract<
        XmlModPrimitive,
        { type: 'TerminalBlock' }
      >;
      expect(p.phase).toBe('');
    });
  });

  describe('XML 格式异常', () => {
    it('非 XML 文本 → 抛错', () => {
      const text = 'not a xml';
      expect(() => parseXmlMod(text, 'MOD/not-xml.mod')).toThrow();
    });

    it('root 非 Device → 抛错', () => {
      const xml = '<?xml version="1.0"?><NotDevice><Entities /></NotDevice>';
      expect(() => parseXmlMod(xml, 'MOD/wrong-root.mod')).toThrow(/Device/);
    });

    it('空字符串 → 抛错', () => {
      expect(() => parseXmlMod('', 'MOD/empty-text.mod')).toThrow();
    });
  });

  describe('modPath 透传', () => {
    it('modPath 字段保留传入值', () => {
      const xml = wrap(
        `<Entity ID="0" Type="simple" Visible="True">
          <Cuboid L="100" W="100" H="100" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="100" G="100" B="100" A="100" />
        </Entity>`,
      );
      const doc = parseXmlMod(xml, 'MOD/abc-123.mod');
      expect(doc.modPath).toBe('MOD/abc-123.mod');
    });
  });

  describe('XmlModEntity 类型可用性', () => {
    it('返回的 entity 满足 XmlModEntity interface', () => {
      const xml = wrap(
        `<Entity ID="42" Type="simple" Visible="True">
          <Cylinder R="50" H="300" />
          <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
          <Color R="200" G="50" B="50" A="100" />
        </Entity>`,
      );
      const e: XmlModEntity = parseXmlMod(xml, 'MOD/typed.mod').entities[0];
      expect(e.id).toBe(42);
      expect(e.type).toBe('simple');
      expect(e.visible).toBe(true);
      expect(e.transformMatrix.length).toBe(16);
      expect(e.color?.r).toBe(200);
    });
  });
});
