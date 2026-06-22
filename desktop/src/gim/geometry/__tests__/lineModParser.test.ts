import { describe, it, expect } from 'vitest';
import {
  classifyLineMod,
  parseLineMod,
  parseHNumCommaRecord,
  parsePointLine,
  parseSectionKvRecord,
  parseKeyValue,
} from '../lineModParser.js';
import type {
  HNumModFile,
  PointLineModFile,
  BoltModFile,
  TowerDeviceModFile,
  WireModFile,
  UnknownKvModFile,
  RRecord,
  LineTextModGeometrySource,
} from '../ir.js';

// ============================================================================
// §1 classifyLineMod 分类器
// ============================================================================

describe('classifyLineMod', () => {
  it('TEXT_POINT_LINE：CODE + POINTNUM + LINENUM 同时存在', () => {
    const text = `CODE=201
POINTNUM=4
LINENUM=4
POINT1=1,26.5,112.6,81.9,13
LINE1=1,2`;
    expect(classifyLineMod(text)).toBe('text-point-line');
  });

  it('TEXT_HNUM_COMMA_RECORD：HNum, 行首', () => {
    const text = `HNum,10
H,27000,Body1,Leg1
Body1
P,1,0,0,0`;
    expect(classifyLineMod(text)).toBe('text-hnum-comma-record');
  });

  it('TEXT_SECTION_KV_RECORD：Bolt 独立行', () => {
    const text = `Bolt
BoltNum=4
Bolt1=M64,232.0,2,49.1,104.8,2,1,150.0,20.0,2160.0,1,30;210,165.0,165.0,0.0`;
    expect(classifyLineMod(text)).toBe('text-section-kv-record');
  });

  it('TEXT_KEY_VALUE：KEY=VALUE 形式', () => {
    const text = `type=灌注桩单桩基础
H1=12700.00
d=1600.00`;
    expect(classifyLineMod(text)).toBe('text-key-value');
  });

  it('无法识别返回 null', () => {
    const text = 'some random content\nwithout any known format';
    expect(classifyLineMod(text)).toBeNull();
  });

  it('空文本返回 null', () => {
    expect(classifyLineMod('')).toBeNull();
  });

  it('带 BOM 头的文本能正确分类', () => {
    const text = '\uFEFFHNum,10\nH,27000,Body1,Leg1';
    expect(classifyLineMod(text)).toBe('text-hnum-comma-record');
  });
});

// ============================================================================
// §2 parseHNumCommaRecord
// ============================================================================

/** 标准 HNum 样本（基于 11 号文档 §2.2） */
const SAMPLE_HNUM = `HNum,10
H,27000,Body1,Leg1
H,30000,Body1,Leg2
H,33000,Body1,Leg3
H,36000,Body1,Leg4
H,39000,Body2,Leg5
Body1
HBody1,26720.401
P,1,7519.597693,-953.003542,56293.389910
P,2,13970.086400,-649.820596,54093.616930
R,1,2,L140X12,Q420,-0.322168,-0.013625,-0.946585,-0.042063,0.999012,0.014347
R,3,4,L140X12,Q420,0.041362,0.999045,0.014108,0.322021,-0.015798,-0.946601
R,2,3,φ325.000000X6.000000,Q235
G,G,后地1,-15950.000000,-325.000000,61042.000000
G,C,后导2,-13950.000000,-600.000000,54042.000000
Body2
HBody2,35720.500
P,5,100,200,300
R,5,6,φ325X6,Q235
HSubLeg1,-3000
HSubLeg2,-2000
HSubLeg3,-1000
HSubLeg4,0
HLeg1,0,7997.065
HLeg2,3961.944,7894.048
HLeg3,6895.407,7894.048
HLeg4,0,7997.065`;

describe('parseHNumCommaRecord', () => {
  it('解析完整样本：HNum + H + Body + P + R + G + HSubLeg + HLeg', () => {
    const doc = parseHNumCommaRecord(SAMPLE_HNUM, 'MOD/tower.mod');
    expect(doc.hNum).toBe(10);
    expect(doc.hRecords.length).toBe(5);
    expect(doc.hRecords[0]).toEqual({
      height: 27000,
      body: 'Body1',
      leg: 'Leg1',
    });
    expect(doc.hRecords[4]).toEqual({
      height: 39000,
      body: 'Body2',
      leg: 'Leg5',
    });
    expect(doc.bodySections.length).toBe(2);
    expect(doc.bodySections[0].name).toBe('Body1');
    expect(doc.bodySections[0].hBody).toBe(26720.401);
    expect(doc.bodySections[0].points.length).toBe(2);
    expect(doc.bodySections[0].points[0]).toEqual({
      id: 1,
      x: 7519.597693,
      y: -953.003542,
      z: 56293.389910,
    });
    expect(doc.bodySections[0].rods.length).toBe(3);
    expect(doc.bodySections[0].groundPoints.length).toBe(2);
    expect(doc.bodySections[1].name).toBe('Body2');
    expect(doc.bodySections[1].hBody).toBe(35720.500);
    expect(doc.bodySections[1].points.length).toBe(1);
    expect(doc.bodySections[1].rods.length).toBe(1);
    expect(doc.hSubLegs.length).toBe(4);
    expect(doc.hSubLegs[0]).toEqual({ index: 1, offset: -3000 });
    expect(doc.hSubLegs[3]).toEqual({ index: 4, offset: 0 });
    expect(doc.hLegs.length).toBe(4);
    expect(doc.hLegs[0]).toEqual({ index: 1, x: 0, y: 7997.065 });
  });

  it('R 记录三变体：angle(11 token) / tube(5 token) / unknown', () => {
    const doc = parseHNumCommaRecord(SAMPLE_HNUM, 'MOD/tower.mod');
    const body1 = doc.bodySections[0];
    // 11 token 角钢
    const angle = body1.rods[0] as Extract<RRecord, { kind: 'angle' }>;
    expect(angle.kind).toBe('angle');
    expect(angle.id1).toBe(1);
    expect(angle.id2).toBe(2);
    expect(angle.spec).toBe('L140X12');
    expect(angle.material).toBe('Q420');
    expect(angle.dir1).toEqual([-0.322168, -0.013625, -0.946585]);
    expect(angle.dir2).toEqual([-0.042063, 0.999012, 0.014347]);
    // 5 token 钢管
    const tube = body1.rods[2] as Extract<RRecord, { kind: 'tube' }>;
    expect(tube.kind).toBe('tube');
    expect(tube.id1).toBe(2);
    expect(tube.id2).toBe(3);
    expect(tube.spec).toBe('φ325.000000X6.000000');
    expect(tube.material).toBe('Q235');
  });

  it('R 记录 9 token 罕见变体兜底为 unknown', () => {
    const text = `HNum,1
H,1000,Body1,Leg1
Body1
P,1,0,0,0
P,2,100,0,0
R,1,2,,Q235,100.000000,500.000000,8.000000,0`;
    const doc = parseHNumCommaRecord(text, 'MOD/rare.mod');
    const rod = doc.bodySections[0].rods[0] as Extract<RRecord, { kind: 'unknown' }>;
    expect(rod.kind).toBe('unknown');
    expect(rod.raw).toBe('R,1,2,,Q235,100.000000,500.000000,8.000000,0');
  });

  it('支持 \\r\\n 换行', () => {
    const text = SAMPLE_HNUM.replace(/\n/g, '\r\n');
    const doc = parseHNumCommaRecord(text, 'MOD/tower.mod');
    expect(doc.hNum).toBe(10);
    expect(doc.hRecords.length).toBe(5);
    expect(doc.bodySections.length).toBe(2);
  });

  it('支持 BOM 头', () => {
    const text = '\uFEFF' + SAMPLE_HNUM;
    const doc = parseHNumCommaRecord(text, 'MOD/tower.mod');
    expect(doc.hNum).toBe(10);
  });

  it('缺失 HBody 时 hBody 为 undefined', () => {
    const text = `HNum,1
H,1000,Body1,Leg1
Body1
P,1,0,0,0`;
    const doc = parseHNumCommaRecord(text, 'MOD/noHBody.mod');
    expect(doc.bodySections[0].hBody).toBeUndefined();
  });

  it('空文件抛错', () => {
    expect(() => parseHNumCommaRecord('', 'MOD/empty.mod')).toThrow();
  });

  it('跳过空行与未识别行', () => {
    const text = `HNum,1

H,1000,Body1,Leg1

Body1

P,1,0,0,0

# 这是一个注释，应被忽略
unknown_line_should_be_skipped`;
    const doc = parseHNumCommaRecord(text, 'MOD/with_blanks.mod');
    expect(doc.hNum).toBe(1);
    expect(doc.bodySections[0].points.length).toBe(1);
  });
});

// ============================================================================
// §3 parsePointLine
// ============================================================================

const SAMPLE_POINT_LINE = `CODE=201
POINTNUM=4
POINT1=1,26.57769030,112.62875108,81.959975,13
POINT2=2,26.57775523,112.62872826,81.959975,13
POINT3=3,26.57769941,112.62853199,81.959975,13
POINT4=4,26.57763453,112.62855482,81.959975,13
LINENUM=4
LINE1=1,2
LINE2=2,3
LINE3=3,4
LINE4=4,1`;

describe('parsePointLine', () => {
  it('解析完整样本：CODE + 4 POINT + 4 LINE', () => {
    const doc = parsePointLine(SAMPLE_POINT_LINE, 'MOD/cross.mod');
    expect(doc.code).toBe('201');
    expect(doc.pointNum).toBe(4);
    expect(doc.lineNum).toBe(4);
    expect(doc.points.length).toBe(4);
    expect(doc.points[0]).toEqual({
      id: 1,
      lat: 26.57769030,
      lon: 112.62875108,
      alt: 81.959975,
      type: '13',
    });
    expect(doc.points[3]).toEqual({
      id: 4,
      lat: 26.57763453,
      lon: 112.62855482,
      alt: 81.959975,
      type: '13',
    });
    expect(doc.lines.length).toBe(4);
    expect(doc.lines[0]).toEqual({ fromId: 1, toId: 2 });
    expect(doc.lines[3]).toEqual({ fromId: 4, toId: 1 });
  });

  it('CODE=30 + POINTNUM=4 + LINENUM=3（开口三边形）', () => {
    const text = `CODE=30
POINTNUM=4
POINT1=1,25.77,112.43,0,13
POINT2=2,25.78,112.43,0,13
POINT3=3,25.78,112.44,0,13
POINT4=4,25.77,112.44,0,13
LINENUM=3
LINE1=1,2
LINE2=2,3
LINE3=3,4`;
    const doc = parsePointLine(text, 'MOD/cross30.mod');
    expect(doc.code).toBe('30');
    expect(doc.pointNum).toBe(4);
    expect(doc.lineNum).toBe(3);
    expect(doc.lines.length).toBe(3);
  });

  it('type=42 点类型', () => {
    const text = `CODE=31
POINTNUM=1
POINT1=1,26.0,112.5,100.5,42
LINENUM=0`;
    const doc = parsePointLine(text, 'MOD/type42.mod');
    expect(doc.points[0].type).toBe('42');
    expect(doc.points[0].alt).toBe(100.5);
  });

  it('支持 \\r\\n 换行', () => {
    const text = SAMPLE_POINT_LINE.replace(/\n/g, '\r\n');
    const doc = parsePointLine(text, 'MOD/cross.mod');
    expect(doc.points.length).toBe(4);
  });

  it('支持 BOM 头', () => {
    const text = '\uFEFF' + SAMPLE_POINT_LINE;
    const doc = parsePointLine(text, 'MOD/cross.mod');
    expect(doc.code).toBe('201');
  });
});

// ============================================================================
// §4 parseSectionKvRecord
// ============================================================================

const SAMPLE_BOLT = `Bolt
BoltNum=4
Bolt1=M64,232.000000,2,49.100000,104.860000,2,1,150.000000,20.000000,2160.000000,1,30;210,165.000000,165.000000,0.000000
Bolt2=M64,232.000000,2,49.100000,104.860000,2,1,150.000000,20.000000,2160.000000,1,30;210,165.000000,-165.000000,0.000000
Bolt3=M64,232.000000,2,49.100000,104.860000,2,1,150.000000,20.000000,2160.000000,1,30;210,-165.000000,-165.000000,0.000000
Bolt4=M64,232.000000,2,49.100000,104.860000,2,1,150.000000,20.000000,2160.000000,1,30;210,-165.000000,165.000000,0.000000`;

describe('parseSectionKvRecord', () => {
  it('解析完整样本：BoltNum=4 + 4 个螺栓', () => {
    const doc = parseSectionKvRecord(SAMPLE_BOLT, 'MOD/bolt.mod');
    expect(doc.section).toBe('Bolt');
    expect(doc.boltNum).toBe(4);
    expect(doc.bolts.length).toBe(4);
    const b1 = doc.bolts[0];
    expect(b1.index).toBe(1);
    expect(b1.spec).toBe('M64');
    expect(b1.length).toBe(232.0);
    // restFields：位置 3-12（索引 2-11），共 10 个 token
    expect(b1.restFields.length).toBe(10);
    expect(b1.restFields[0]).toBe('2'); // grade
    expect(b1.restFields[1]).toBe('49.100000'); // d1
    expect(b1.restFields[9]).toBe('30'); // angle
    expect(b1.position).toEqual({
      code: 210,
      x: 165.0,
      y: 165.0,
      z: 0.0,
    });
  });

  it('四象限对称分布', () => {
    const doc = parseSectionKvRecord(SAMPLE_BOLT, 'MOD/bolt.mod');
    expect(doc.bolts[0].position).toEqual({ code: 210, x: 165, y: 165, z: 0 });
    expect(doc.bolts[1].position).toEqual({ code: 210, x: 165, y: -165, z: 0 });
    expect(doc.bolts[2].position).toEqual({ code: 210, x: -165, y: -165, z: 0 });
    expect(doc.bolts[3].position).toEqual({ code: 210, x: -165, y: 165, z: 0 });
  });

  it('BoltNum=8（双拼法兰）', () => {
    const text = `Bolt
BoltNum=8
Bolt1=M48,180.0,2,40,90,2,1,120,15,1500,1,25;210,145,145,0
Bolt2=M48,180.0,2,40,90,2,1,120,15,1500,1,25;210,145,-145,0
Bolt3=M48,180.0,2,40,90,2,1,120,15,1500,1,25;210,-145,-145,0
Bolt4=M48,180.0,2,40,90,2,1,120,15,1500,1,25;210,-145,145,0
Bolt5=M48,180.0,2,40,90,2,1,120,15,1500,1,25;210,145,0,0
Bolt6=M48,180.0,2,40,90,2,1,120,15,1500,1,25;210,0,145,0
Bolt7=M48,180.0,2,40,90,2,1,120,15,1500,1,25;210,-145,0,0
Bolt8=M48,180.0,2,40,90,2,1,120,15,1500,1,25;210,0,-145,0`;
    const doc = parseSectionKvRecord(text, 'MOD/bolt8.mod');
    expect(doc.boltNum).toBe(8);
    expect(doc.bolts.length).toBe(8);
    expect(doc.bolts[0].spec).toBe('M48');
    expect(doc.bolts[7].position).toEqual({ code: 210, x: 0, y: -145, z: 0 });
  });

  it('支持 \\r\\n 换行', () => {
    const text = SAMPLE_BOLT.replace(/\n/g, '\r\n');
    const doc = parseSectionKvRecord(text, 'MOD/bolt.mod');
    expect(doc.bolts.length).toBe(4);
  });

  it('支持 BOM 头', () => {
    const text = '\uFEFF' + SAMPLE_BOLT;
    const doc = parseSectionKvRecord(text, 'MOD/bolt.mod');
    expect(doc.boltNum).toBe(4);
  });
});

// ============================================================================
// §5 parseKeyValue
// ============================================================================

const SAMPLE_TOWER_DEVICE = `type=灌注桩单桩基础
H1=12700.00
H2=0.00
H3=0.00
H4=0.00
d=1600.00
D=1600.00
e1=0.00
e2=0.00`;

const SAMPLE_WIRE = `TYPE=JLB20A-150
SECTIONALAREA=148.07
OUTSIDEDIAMETER=15.75
WIREWEIGHT=989.40
COEFFICIENTOFELASTICITY=147200.00
EXPANSIONCOEFFICIENTOFWIRE=13.00
RATEDSTRENGTH=178570.00`;

describe('parseKeyValue', () => {
  it('Tower_Device 签名解析', () => {
    const doc = parseKeyValue(SAMPLE_TOWER_DEVICE, 'MOD/tower_dev.mod') as TowerDeviceModFile;
    expect(doc.signature).toBe('type,H1,H2,H3,H4,d,e1,e2');
    expect(doc.type).toBe('灌注桩单桩基础');
    expect(doc.H1).toBe(12700.0);
    expect(doc.H2).toBe(0.0);
    expect(doc.H3).toBe(0.0);
    expect(doc.H4).toBe(0.0);
    expect(doc.d).toBe(1600.0);
    expect(doc.D).toBe(1600.0); // 可选字段，但实测全部出现
    expect(doc.e1).toBe(0.0);
    expect(doc.e2).toBe(0.0);
  });

  it('Tower_Device 缺失 D 字段时 D 为 undefined', () => {
    const text = `type=开挖基础
H1=7700
H2=0
H3=0
H4=0
d=1000
e1=0
e2=0`;
    const doc = parseKeyValue(text, 'MOD/no_D.mod') as TowerDeviceModFile;
    expect(doc.D).toBeUndefined();
    expect(doc.d).toBe(1000);
  });

  it('WIRE 签名解析', () => {
    const doc = parseKeyValue(SAMPLE_WIRE, 'MOD/wire.mod') as WireModFile;
    expect(doc.signature).toBe(
      'TYPE,SECTIONALAREA,OUTSIDEDIAMETER,WIREWEIGHT,COEFFICIENTOFELASTICITY,EXPANSIONCOEFFICIENTOFWIRE,RATEDSTRENGTH',
    );
    expect(doc.TYPE).toBe('JLB20A-150');
    expect(doc.SECTIONALAREA).toBe(148.07);
    expect(doc.OUTSIDEDIAMETER).toBe(15.75);
    expect(doc.WIREWEIGHT).toBe(989.40);
    expect(doc.COEFFICIENTOFELASTICITY).toBe(147200.0);
    expect(doc.EXPANSIONCOEFFICIENTOFWIRE).toBe(13.0);
    expect(doc.RATEDSTRENGTH).toBe(178570.0);
  });

  it('未识别签名走 UnknownKvModFile 兜底', () => {
    const text = `FOO=bar
BAZ=123
QUX=hello`;
    const doc = parseKeyValue(text, 'MOD/unknown.mod') as UnknownKvModFile;
    expect(doc.signature).toBe('unknown');
    expect(doc.keySignature).toBe('FOO,BAZ,QUX');
    expect(doc.raw.FOO).toBe('bar');
    expect(doc.raw.BAZ).toBe('123');
    expect(doc.raw.QUX).toBe('hello');
  });

  it('支持 \\r\\n 换行', () => {
    const text = SAMPLE_TOWER_DEVICE.replace(/\n/g, '\r\n');
    const doc = parseKeyValue(text, 'MOD/tower_dev.mod') as TowerDeviceModFile;
    expect(doc.type).toBe('灌注桩单桩基础');
    expect(doc.H1).toBe(12700.0);
  });

  it('支持 BOM 头', () => {
    const text = '\uFEFF' + SAMPLE_WIRE;
    const doc = parseKeyValue(text, 'MOD/wire.mod') as WireModFile;
    expect(doc.TYPE).toBe('JLB20A-150');
  });
});

// ============================================================================
// §6 parseLineMod 主入口
// ============================================================================

describe('parseLineMod', () => {
  it('分发到 text-hnum-comma-record', () => {
    const source = parseLineMod(SAMPLE_HNUM, 'MOD/tower.mod') as LineTextModGeometrySource;
    expect(source.kind).toBe('line-text-mod');
    expect(source.format).toBe('text-hnum-comma-record');
    expect(source.modPath).toBe('MOD/tower.mod');
    const records = source.records as HNumModFile;
    expect(records.hNum).toBe(10);
  });

  it('分发到 text-point-line', () => {
    const source = parseLineMod(SAMPLE_POINT_LINE, 'MOD/cross.mod');
    expect(source.kind).toBe('line-text-mod');
    expect(source.format).toBe('text-point-line');
    const records = source.records as PointLineModFile;
    expect(records.code).toBe('201');
  });

  it('分发到 text-section-kv-record', () => {
    const source = parseLineMod(SAMPLE_BOLT, 'MOD/bolt.mod');
    expect(source.kind).toBe('line-text-mod');
    expect(source.format).toBe('text-section-kv-record');
    const records = source.records as BoltModFile;
    expect(records.boltNum).toBe(4);
  });

  it('分发到 text-key-value (Tower_Device)', () => {
    const source = parseLineMod(SAMPLE_TOWER_DEVICE, 'MOD/tower_dev.mod');
    expect(source.kind).toBe('line-text-mod');
    expect(source.format).toBe('text-key-value');
    const records = source.records as TowerDeviceModFile;
    expect(records.type).toBe('灌注桩单桩基础');
  });

  it('分发到 text-key-value (WIRE)', () => {
    const source = parseLineMod(SAMPLE_WIRE, 'MOD/wire.mod');
    expect(source.format).toBe('text-key-value');
    const records = source.records as WireModFile;
    expect(records.TYPE).toBe('JLB20A-150');
  });

  it('无法识别格式抛错', () => {
    expect(() => parseLineMod('random unknown content', 'MOD/unknown.mod')).toThrow(
      /Unrecognized line MOD format/,
    );
  });

  it('modPath 透传', () => {
    const source = parseLineMod(SAMPLE_POINT_LINE, 'MOD/path/to/cross.mod');
    expect(source.modPath).toBe('MOD/path/to/cross.mod');
  });
});
