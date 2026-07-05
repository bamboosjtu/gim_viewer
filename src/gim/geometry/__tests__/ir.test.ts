import { describe, it, expect } from 'vitest';
import {
  isIfcSource,
  isXmlModSource,
  isLineTextModSource,
  isStlSource,
  isNoneSource,
  isCuboid,
  isCylinder,
  isStretchedBody,
  isWeakSchemaPrimitive,
  type GimGeometrySource,
  type NoneReason,
  type XmlModPrimitive,
  type XmlModEntity,
  type PhmDocument,
  type GimGeometryInstance,
} from '../ir.js';

describe('GimGeometrySource 类型守卫', () => {
  const ifc: GimGeometrySource = {
    kind: 'ifc',
    ifcFile: 'abc.ifc',
    modelId: 'abc',
    ifcGuid: 'GUID',
  };
  const xmlMod: GimGeometrySource = {
    kind: 'xml-mod',
    entities: [],
    modPath: 'MOD/x.mod',
  };
  const lineTextMod: GimGeometrySource = {
    kind: 'line-text-mod',
    format: 'text-hnum-comma-record',
    modPath: 'Mod/y.mod',
    records: [],
  };
  const stl: GimGeometrySource = {
    kind: 'stl',
    stlPath: 'PHM/z.stl',
    format: 'binary',
    triangleCount: 100,
  };
  const none: GimGeometrySource = {
    kind: 'none',
    reason: 'phm-no-solidmodel',
  };

  it('isIfcSource 正确识别 ifc kind', () => {
    expect(isIfcSource(ifc)).toBe(true);
    expect(isIfcSource(xmlMod)).toBe(false);
    expect(isIfcSource(stl)).toBe(false);
    expect(isIfcSource(none)).toBe(false);
  });

  it('isXmlModSource 正确识别 xml-mod kind', () => {
    expect(isXmlModSource(xmlMod)).toBe(true);
    expect(isXmlModSource(ifc)).toBe(false);
  });

  it('isLineTextModSource 正确识别 line-text-mod kind', () => {
    expect(isLineTextModSource(lineTextMod)).toBe(true);
    expect(isLineTextModSource(xmlMod)).toBe(false);
  });

  it('isStlSource 正确识别 stl kind', () => {
    expect(isStlSource(stl)).toBe(true);
    expect(isStlSource(ifc)).toBe(false);
  });

  it('isNoneSource 正确识别 none kind', () => {
    expect(isNoneSource(none)).toBe(true);
    expect(isNoneSource(ifc)).toBe(false);
  });

  it('5 个 kind 互斥（每个 source 只匹配一个守卫）', () => {
    const all = [ifc, xmlMod, lineTextMod, stl, none];
    for (const s of all) {
      const matches = [
        isIfcSource(s),
        isXmlModSource(s),
        isLineTextModSource(s),
        isStlSource(s),
        isNoneSource(s),
      ].filter(Boolean);
      expect(matches.length).toBe(1);
    }
  });
});

describe('NoneReason 9 种值', () => {
  it('覆盖全部 reason 取值', () => {
    const reasons: NoneReason[] = [
      'empty-device-xml',
      'phm-no-solidmodel',
      'assembly-node-without-own-geometry',
      'phm-missing-target',
      'cbm-no-objectmodelpointer',
      'dev-no-solidmodel',
      'parser-unsupported',
      'parse-failed',
      'unknown',
    ];
    expect(reasons.length).toBe(9);
    // 验证 reason 字段可赋值
    const s: GimGeometrySource = { kind: 'none', reason: 'assembly-node-without-own-geometry' };
    expect(s.kind).toBe('none');
  });

  it('区分 phm-no-solidmodel 与 assembly-node-without-own-geometry', () => {
    const phmNoSolid: GimGeometrySource = {
      kind: 'none',
      reason: 'phm-no-solidmodel',
    };
    const assemblyNoOwn: GimGeometrySource = {
      kind: 'none',
      reason: 'assembly-node-without-own-geometry',
    };
    expect((phmNoSolid as { reason: NoneReason }).reason).not.toBe(
      (assemblyNoOwn as { reason: NoneReason }).reason,
    );
  });
});

describe('XmlModPrimitive 类型守卫', () => {
  it('isCuboid 正确识别 Cuboid', () => {
    const cuboid: XmlModPrimitive = { type: 'Cuboid', l: 100, w: 50, h: 30 };
    expect(isCuboid(cuboid)).toBe(true);
    expect(isCylinder(cuboid)).toBe(false);
  });

  it('isCylinder 正确识别 Cylinder', () => {
    const cyl: XmlModPrimitive = { type: 'Cylinder', r: 50, h: 200 };
    expect(isCylinder(cyl)).toBe(true);
    expect(isCuboid(cyl)).toBe(false);
  });

  it('isStretchedBody 正确识别 StretchedBody（保留 string 字段）', () => {
    const sb: XmlModPrimitive = {
      type: 'StretchedBody',
      l: 100,
      array: '1,2,3;4,5,6',
      normal: '0,304.8,0',
    };
    expect(isStretchedBody(sb)).toBe(true);
  });

  it('isWeakSchemaPrimitive 正确识别 3 类弱 schema primitive', () => {
    const rfp: XmlModPrimitive = {
      type: 'RectangularFixedPlate',
      raw: { L: '100' },
    };
    const ort: XmlModPrimitive = {
      type: 'OffsetRectangularTable',
      raw: { H: '50' },
    };
    const rr: XmlModPrimitive = {
      type: 'RectangularRing',
      raw: { R: '10' },
    };
    const cyl: XmlModPrimitive = { type: 'Cylinder', r: 50, h: 200 };

    expect(isWeakSchemaPrimitive(rfp)).toBe(true);
    expect(isWeakSchemaPrimitive(ort)).toBe(true);
    expect(isWeakSchemaPrimitive(rr)).toBe(true);
    expect(isWeakSchemaPrimitive(cyl)).toBe(false);
  });
});

describe('XmlModEntity interface', () => {
  it('完整 Entity 含 transformMatrix + color', () => {
    const entity: XmlModEntity = {
      id: 1,
      type: 'simple',
      visible: true,
      primitive: { type: 'Cylinder', r: 50, h: 200 },
      transformMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      color: { r: 255, g: 0, b: 0, a: 100 },
    };
    expect(entity.id).toBe(1);
    expect(entity.transformMatrix.length).toBe(16);
    expect(entity.color?.a).toBe(100);
  });

  it('Entity color 可选', () => {
    const entity: XmlModEntity = {
      id: 2,
      type: 'simple',
      visible: true,
      primitive: { type: 'Cuboid', l: 10, w: 20, h: 30 },
      transformMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    };
    expect(entity.color).toBeUndefined();
  });
});

describe('PhmDocument interface', () => {
  it('NUM=0 装配节点 isEmpty=true', () => {
    const doc: PhmDocument = {
      phmPath: 'PHM/empty.phm',
      solidModels: [],
      isEmpty: true,
    };
    expect(doc.isEmpty).toBe(true);
    expect(doc.solidModels.length).toBe(0);
  });

  it('NUM=2 双 MOD 模型', () => {
    const doc: PhmDocument = {
      phmPath: 'PHM/dual.phm',
      solidModels: [
        {
          solidModelPath: 'a.mod',
          transformMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
        {
          solidModelPath: 'b.mod',
          transformMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
      ],
      isEmpty: false,
    };
    expect(doc.isEmpty).toBe(false);
    expect(doc.solidModels.length).toBe(2);
    expect(doc.solidModels[0].color).toBeUndefined();
  });

  it('STL 引用带 color', () => {
    const doc: PhmDocument = {
      phmPath: 'PHM/stl.phm',
      solidModels: [
        {
          solidModelPath: 'mesh.stl',
          transformMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          color: { r: 215, g: 215, b: 215, a: 100 },
        },
      ],
      isEmpty: false,
    };
    expect(doc.solidModels[0].color?.r).toBe(215);
  });
});

describe('GimGeometryInstance 实例化', () => {
  it('同一 source 多 instance', () => {
    const source: GimGeometrySource = {
      kind: 'stl',
      stlPath: 'shared.stl',
      format: 'binary',
      triangleCount: 10,
    };
    const inst1: GimGeometryInstance = {
      source,
      transformMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      color: { r: 100, g: 100, b: 100, a: 100 },
    };
    const inst2: GimGeometryInstance = {
      source,
      transformMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 200, 300, 1],
    };
    expect(inst1.source).toBe(inst2.source);
    expect(inst1.color).toBeDefined();
    expect(inst2.color).toBeUndefined();
  });
});
