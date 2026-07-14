/**
 * 线路 MOD 文本格式族解析器（4 类格式族）。
 *
 * 详见 docs/schema/11-line-mod-grammar.md。
 *
 * 4 类格式族（按 11 号文档附录 A.4.1 分类规则）：
 * - text-hnum-comma-record：杆塔主体分段构件（HNum → H → Body → P/R/G）
 * - text-point-line：经纬度点线表（CODE/POINTNUM/LINENUM + POINTn/LINEn）
 * - text-section-kv-record：螺栓参数表（Bolt/BoltNum/BoltN）
 * - text-key-value：Tower_Device 基础参数 / WIRE 导线参数（按 key 大小写二分）
 *
 * 设计原则：
 * - 强类型优先：11 号文档 §7.2 判定 4 类格式族均可强类型化
 * - 弱 schema 兜底：R 9 token 罕见变体 + 未识别 KV 签名保留原始字符串
 * - 解析失败保留 NaN（与 xmlModParser 一致），不抛错中断
 * - 数值字段缺失或解析失败时：float → NaN, int → NaN
 */

import type {
  BodySection,
  BoltModFile,
  BoltPosition,
  BoltRecord,
  GRecord,
  HLegRecord,
  HNumModFile,
  HRecord,
  HSubLegRecord,
  KeyValueModFile,
  LineModFormat,
  LineTextModGeometrySource,
  PRecord,
  PointLineModFile,
  PointRecord,
  LineRecord,
  RRecord,
  TowerDeviceModFile,
  UnknownKvModFile,
  WireModFile,
} from './ir.js';

// ============================================================================
// §1 分类器 + 主入口
// ============================================================================

/**
 * 按 11 号文档附录 A.4.1 分类 MOD 文本内容。
 *
 * 分类规则（优先级从上到下）：
 * 1. 同时含 `^CODE=` + `^POINTNUM=` + `^LINENUM=` → text-point-line
 * 2. 含 `^HNum,` → text-hnum-comma-record
 * 3. 含 `^Bolt$`（section header）→ text-section-kv-record
 * 4. 全行为 KEY=VALUE 形式 → text-key-value
 * 5. 无法识别 → null（调用方应处理为 NoneGeometrySource）
 *
 * @param text MOD 文件原始文本
 * @returns 格式族标识，无法识别返回 null
 */
export function classifyLineMod(text: string): LineModFormat | null {
  // 去除 BOM + 统一换行
  const normalized = normalizeText(text);
  // 多行模式（m 标志）
  if (
    /^CODE\s*=/m.test(normalized) &&
    /^POINTNUM\s*=/m.test(normalized) &&
    /^LINENUM\s*=/m.test(normalized)
  ) {
    return 'text-point-line';
  }
  if (/^HNum\s*,/m.test(normalized)) {
    return 'text-hnum-comma-record';
  }
  // section header：行首为 Bolt（独立行，非 BoltN=...）
  if (/^Bolt\s*$/m.test(normalized)) {
    return 'text-section-kv-record';
  }
  // KEY=VALUE 形式：至少有一行匹配 KEY=VALUE
  if (/^[A-Za-z][A-Za-z0-9_]*\s*=/m.test(normalized)) {
    return 'text-key-value';
  }
  return null;
}

/**
 * 解析线路 MOD 文本为 LineTextModGeometrySource。
 *
 * 内部先调用 classifyLineMod 分发到对应解析函数。
 * 无法识别格式时抛错（调用方应处理为 NoneGeometrySource）。
 *
 * @param text MOD 文件原始文本
 * @param modPath MOD 文件路径（如 "MOD/abc.mod"）
 * @throws 当格式无法识别时抛错
 */
export function parseLineMod(text: string, modPath: string): LineTextModGeometrySource {
  const format = classifyLineMod(text);
  if (format === null) {
    throw new Error(`Unrecognized line MOD format in ${modPath}`);
  }
  let records: LineTextModGeometrySource['records'];
  switch (format) {
    case 'text-hnum-comma-record':
      records = parseHNumCommaRecord(text, modPath);
      break;
    case 'text-point-line':
      records = parsePointLine(text, modPath);
      break;
    case 'text-section-kv-record':
      records = parseSectionKvRecord(text, modPath);
      break;
    case 'text-key-value':
      records = parseKeyValue(text, modPath);
      break;
  }
  return { kind: 'line-text-mod', format, modPath, records };
}

// ============================================================================
// §2 TEXT_HNUM_COMMA_RECORD 解析
// ============================================================================

/** H 记录正则：H,<height>,<body>,<leg> */
const RE_H_RECORD = /^H\s*,\s*(-?[\d.]+)\s*,\s*(Body\d+)\s*,\s*(Leg\d+)\s*$/;
/** HNum 行正则：HNum,<n> */
const RE_HNUM = /^HNum\s*,\s*(\d+)\s*$/;
/** BodyN 独立行正则：Body1 / Body2 ... */
const RE_BODY_HEADER = /^(Body\d+)$/;
/** HBodyN 行正则：HBody1,26720.401 */
const RE_HBODY = /^HBody(\d+)\s*,\s*(-?[\d.]+)\s*$/;
/** P 记录正则：P,<id>,<X>,<Y>,<Z> */
const RE_P_RECORD = /^P\s*,\s*(\d+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/;
/** G 记录正则：G,<type>,<name>,<X>,<Y>,<Z> */
const RE_G_RECORD = /^G\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/;
/** HSubLegN 行正则：HSubLeg1,-3000 */
const RE_HSUBLEG = /^HSubLeg(\d+)\s*,\s*(-?[\d.]+)\s*$/;
/** HLegN 行正则：HLeg1,0,7997.065 */
const RE_HLEG = /^HLeg(\d+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/;

/**
 * 解析 TEXT_HNUM_COMMA_RECORD 文本为 HNumModFile。
 *
 * 状态机：
 * - 扫描行，按行首特征分发到 HNum/H/Body/HBody/P/R/G/HSubLeg/HLeg 处理分支
 * - Body 段靠 BodyN 独立行界定边界：遇到 BodyN 时 push 上一个 Body 段，开新段
 * - 文件末尾 push 最后一个 Body 段
 *
 * @param text MOD 文件原始文本
 * @param modPath MOD 文件路径，仅用于错误诊断
 */
export function parseHNumCommaRecord(text: string, modPath: string): HNumModFile {
  const lines = splitLines(text);
  let hNum = 0;
  const hRecords: HRecord[] = [];
  const bodySections: BodySection[] = [];
  const hSubLegs: HSubLegRecord[] = [];
  const hLegs: HLegRecord[] = [];
  let currentBody: BodySection | null = null;

  /** push 当前 Body 段（如有）到 bodySections，并清空 currentBody */
  const flushCurrentBody = (): void => {
    if (currentBody) {
      bodySections.push(currentBody);
      currentBody = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    // HNum,10
    let m = RE_HNUM.exec(line);
    if (m) {
      hNum = parseInt(m[1], 10);
      continue;
    }
    // H,27000,Body1,Leg1
    m = RE_H_RECORD.exec(line);
    if (m) {
      hRecords.push({
        height: parseFloat(m[1]),
        body: m[2],
        leg: m[3],
      });
      continue;
    }
    // Body1（独立行，开启新 Body 段）
    m = RE_BODY_HEADER.exec(line);
    if (m) {
      flushCurrentBody();
      currentBody = {
        name: m[1],
        points: [],
        rods: [],
        groundPoints: [],
      };
      continue;
    }
    // HBody1,26720.401
    m = RE_HBODY.exec(line);
    if (m) {
      // 若未开启 Body 段，忽略（不应发生，但兜底）
      if (currentBody && currentBody.name === `Body${m[1]}`) {
        currentBody.hBody = parseFloat(m[2]);
      }
      continue;
    }
    // P,1,X,Y,Z
    m = RE_P_RECORD.exec(line);
    if (m) {
      const p: PRecord = {
        id: parseInt(m[1], 10),
        x: parseFloat(m[2]),
        y: parseFloat(m[3]),
        z: parseFloat(m[4]),
      };
      // 若未开启 Body 段，创建匿名 Body 段兜底
      if (!currentBody) {
        currentBody = { name: 'Body0', points: [], rods: [], groundPoints: [] };
      }
      currentBody.points.push(p);
      continue;
    }
    // R,...
    if (line.startsWith('R,')) {
      const r = parseRRecord(line);
      if (r) {
        if (!currentBody) {
          currentBody = { name: 'Body0', points: [], rods: [], groundPoints: [] };
        }
        currentBody.rods.push(r);
      }
      continue;
    }
    // G,type,name,X,Y,Z
    m = RE_G_RECORD.exec(line);
    if (m) {
      const g: GRecord = {
        type: m[1],
        name: m[2],
        x: parseFloat(m[3]),
        y: parseFloat(m[4]),
        z: parseFloat(m[5]),
      };
      if (!currentBody) {
        currentBody = { name: 'Body0', points: [], rods: [], groundPoints: [] };
      }
      currentBody.groundPoints.push(g);
      continue;
    }
    // HSubLegN,offset
    m = RE_HSUBLEG.exec(line);
    if (m) {
      hSubLegs.push({
        index: parseInt(m[1], 10),
        offset: parseFloat(m[2]),
      });
      continue;
    }
    // HLegN,X,Y
    m = RE_HLEG.exec(line);
    if (m) {
      hLegs.push({
        index: parseInt(m[1], 10),
        x: parseFloat(m[2]),
        y: parseFloat(m[3]),
      });
      continue;
    }
    // 其他行：忽略（保留扩展空间）
  }
  flushCurrentBody();

  if (hNum === 0 && hRecords.length === 0 && bodySections.length === 0) {
    throw new Error(`Empty HNum MOD file: ${modPath}`);
  }

  return { hNum, hRecords, bodySections, hSubLegs, hLegs };
}

/**
 * 解析 R 记录为三变体联合类型。
 *
 * 11 号文档 §2.5 的 "token 数" 包含 R 前缀本身。
 * 去掉 "R," 后的 token 数：
 * - 10（对应含 R 的 11 token）→ angle（角钢，含双方向单位向量）
 * - 4（对应含 R 的 5 token）→ tube（钢管，规格前缀 `φ`）
 * - 其他 → unknown（保留原始记录文本，覆盖 9 token 罕见变体）
 */
function parseRRecord(line: string): RRecord | null {
  // 去掉开头的 "R,"
  const body = line.substring(2);
  const tokens = body.split(',').map((t) => t.trim());
  if (tokens.length === 10) {
    // 角钢：id1,id2,spec,material,dx,dy,dz,dx2,dy2,dz2
    return {
      kind: 'angle',
      id1: parseInt(tokens[0], 10),
      id2: parseInt(tokens[1], 10),
      spec: tokens[2],
      material: tokens[3],
      dir1: [parseFloat(tokens[4]), parseFloat(tokens[5]), parseFloat(tokens[6])],
      dir2: [parseFloat(tokens[7]), parseFloat(tokens[8]), parseFloat(tokens[9])],
    };
  }
  if (tokens.length === 4) {
    // 钢管：id1,id2,spec,material
    return {
      kind: 'tube',
      id1: parseInt(tokens[0], 10),
      id2: parseInt(tokens[1], 10),
      spec: tokens[2],
      material: tokens[3],
    };
  }
  // 9 token 罕见变体（去掉 R 后 8 token）或其他：保留原始文本
  return { kind: 'unknown', raw: line };
}

// ============================================================================
// §3 TEXT_POINT_LINE 解析
// ============================================================================

/** CODE 行正则：CODE=201 */
const RE_CODE = /^CODE\s*=\s*(.*)$/;
/** POINTNUM 行正则 */
const RE_POINTNUM = /^POINTNUM\s*=\s*(\d+)\s*$/;
/** LINENUM 行正则 */
const RE_LINENUM = /^LINENUM\s*=\s*(\d+)\s*$/;
/** POINTn 行正则：POINT1=id,lat,lon,alt,type */
const RE_POINT = /^POINT(\d+)\s*=\s*(\d+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(\S+)\s*$/;
/** LINEn 行正则：LINE1=fromId,toId */
const RE_LINE = /^LINE(\d+)\s*=\s*(\d+)\s*,\s*(\d+)\s*$/;

/**
 * 解析 TEXT_POINT_LINE 文本为 PointLineModFile。
 *
 * POINT 恒为 5 token (id,lat,lon,alt,type)，LINE 恒为 2 token (fromId,toId)。
 * 格式 100% 稳定（11 号文档 §3.3.1 / §3.4.1）。
 */
export function parsePointLine(text: string, _modPath: string): PointLineModFile {
  const lines = splitLines(text);
  let code = '';
  let pointNum = 0;
  let lineNum = 0;
  const points: PointRecord[] = [];
  const lines_: LineRecord[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    let m = RE_CODE.exec(line);
    if (m) {
      code = m[1].trim();
      continue;
    }
    m = RE_POINTNUM.exec(line);
    if (m) {
      pointNum = parseInt(m[1], 10);
      continue;
    }
    m = RE_LINENUM.exec(line);
    if (m) {
      lineNum = parseInt(m[1], 10);
      continue;
    }
    m = RE_POINT.exec(line);
    if (m) {
      points.push({
        id: parseInt(m[2], 10),
        lat: parseFloat(m[3]),
        lon: parseFloat(m[4]),
        alt: parseFloat(m[5]),
        type: m[6],
      });
      continue;
    }
    m = RE_LINE.exec(line);
    if (m) {
      lines_.push({
        fromId: parseInt(m[2], 10),
        toId: parseInt(m[3], 10),
      });
      continue;
    }
    // 其他行：忽略
  }

  return { code, pointNum, lineNum, points, lines: lines_ };
}

// ============================================================================
// §4 TEXT_SECTION_KV_RECORD 解析
// ============================================================================

/** BoltNum 行正则 */
const RE_BOLTNUM = /^BoltNum\s*=\s*(\d+)\s*$/;
/** BoltN 行正则（前缀，值部分按分号拆分） */
const RE_BOLT_N = /^Bolt(\d+)\s*=\s*(.*)$/;

/**
 * 解析 TEXT_SECTION_KV_RECORD 文本为 BoltModFile。
 *
 * BoltN 记录结构：`BoltN=<seg1>;<seg2>`
 * - seg1：12 个逗号 token（spec/length + 10 个 restFields）
 * - seg2：4 个逗号 token（code/x/y/z）
 *
 * 11 号文档 §4.3.2 实测：12 token + 分号 + 4 token = 16 总 token。
 * （文档表格中"15 token"是早期推测，§4.3.2 已修正）
 */
export function parseSectionKvRecord(text: string, modPath: string): BoltModFile {
  const lines = splitLines(text);
  let boltNum = 0;
  const bolts: BoltRecord[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    // 跳过 section header 行（"Bolt"）
    if (line === 'Bolt') continue;

    let m = RE_BOLTNUM.exec(line);
    if (m) {
      boltNum = parseInt(m[1], 10);
      continue;
    }

    m = RE_BOLT_N.exec(line);
    if (m) {
      const index = parseInt(m[1], 10);
      const value = m[2];
      const parsed = parseBoltValue(value, modPath, index);
      bolts.push({ index, ...parsed });
      continue;
    }
    // 其他行：忽略
  }

  return { section: 'Bolt', boltNum, bolts };
}

/**
 * 解析 BoltN 的值部分为 spec/length/restFields/position。
 *
 * 值结构：`spec,length,grade,d1,d2,type,flag1,d3,d4,d5,flag2,angle;code,x,y,z`
 * - seg1（;前）：12 token
 * - seg2（;后）：4 token
 */
function parseBoltValue(
  value: string,
  modPath: string,
  index: number,
): { spec: string; length: number; restFields: string[]; position: BoltPosition } {
  const semiIdx = value.indexOf(';');
  let seg1: string;
  let seg2: string;
  if (semiIdx < 0) {
    // 无分号：异常格式，但兜底处理（seg2 为空）
    seg1 = value;
    seg2 = '';
  } else {
    seg1 = value.substring(0, semiIdx);
    seg2 = value.substring(semiIdx + 1);
  }
  const seg1Tokens = seg1.split(',').map((t) => t.trim());
  const seg2Tokens = seg2.split(',').map((t) => t.trim());

  if (seg1Tokens.length < 2) {
    throw new Error(`Invalid Bolt${index} seg1 in ${modPath}: ${value}`);
  }
  const spec = seg1Tokens[0];
  const length = parseFloat(seg1Tokens[1]);
  // restFields：位置 3-12（索引 2-11），共 10 个 token
  const restFields = seg1Tokens.slice(2, 12);

  if (seg2Tokens.length < 4) {
    throw new Error(`Invalid Bolt${index} seg2 in ${modPath}: ${value}`);
  }
  const position: BoltPosition = {
    code: parseInt(seg2Tokens[0], 10),
    x: parseFloat(seg2Tokens[1]),
    y: parseFloat(seg2Tokens[2]),
    z: parseFloat(seg2Tokens[3]),
  };

  return { spec, length, restFields, position };
}

// ============================================================================
// §5 TEXT_KEY_VALUE 解析
// ============================================================================

/** KV 行正则：KEY=VALUE */
const RE_KV = /^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Tower_Device 签名（key 集合，按首次出现顺序） */
const TOWER_DEVICE_SIGNATURE = 'type,H1,H2,H3,H4,d,e1,e2';
/** WIRE 签名 */
const WIRE_SIGNATURE =
  'TYPE,SECTIONALAREA,OUTSIDEDIAMETER,WIREWEIGHT,COEFFICIENTOFELASTICITY,EXPANSIONCOEFFICIENTOFWIRE,RATEDSTRENGTH';

/**
 * 解析 TEXT_KEY_VALUE 文本为 KeyValueModFile。
 *
 * 签名判别（11 号文档 §5.4）：
 * - key 集合包含 "type"（小写）→ Tower_Device
 * - key 集合包含 "TYPE"（大写）→ WIRE
 * - 其他 → UnknownKvModFile（弱 schema 兜底）
 */
export function parseKeyValue(text: string, _modPath: string): KeyValueModFile {
  const lines = splitLines(text);
  /** 按首次出现顺序记录 key */
  const orderedKeys: string[] = [];
  const kv: Record<string, string> = {};
  /** key 集合（用于签名判别） */
  const keySet = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    const m = RE_KV.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (!keySet.has(key)) {
      keySet.add(key);
      orderedKeys.push(key);
    }
    kv[key] = value;
  }

  const signature = orderedKeys.join(',');

  // 签名 1：Tower_Device（全小写 key）
  if (keySet.has('type') && keySet.has('H1') && keySet.has('d')) {
    return parseTowerDevice(kv);
  }
  // 签名 2：WIRE（全大写 key）
  if (keySet.has('TYPE') && keySet.has('SECTIONALAREA')) {
    return parseWire(kv);
  }
  // 未识别签名：弱 schema 兜底
  const unknown: UnknownKvModFile = {
    signature: 'unknown',
    keySignature: signature,
    raw: kv,
  };
  return unknown;
}

/** 解析 Tower_Device 基础参数 */
function parseTowerDevice(kv: Record<string, string>): TowerDeviceModFile {
  return {
    signature: TOWER_DEVICE_SIGNATURE,
    type: kv['type'] ?? '',
    H1: parseFloat(kv['H1'] ?? ''),
    H2: parseFloat(kv['H2'] ?? ''),
    H3: parseFloat(kv['H3'] ?? ''),
    H4: parseFloat(kv['H4'] ?? ''),
    d: parseFloat(kv['d'] ?? ''),
    D: kv['D'] !== undefined ? parseFloat(kv['D']) : undefined,
    e1: parseFloat(kv['e1'] ?? ''),
    e2: parseFloat(kv['e2'] ?? ''),
  };
}

/** 解析 WIRE 导线参数 */
function parseWire(kv: Record<string, string>): WireModFile {
  return {
    signature: WIRE_SIGNATURE,
    TYPE: kv['TYPE'] ?? '',
    SECTIONALAREA: parseFloat(kv['SECTIONALAREA'] ?? ''),
    OUTSIDEDIAMETER: parseFloat(kv['OUTSIDEDIAMETER'] ?? ''),
    WIREWEIGHT: parseFloat(kv['WIREWEIGHT'] ?? ''),
    COEFFICIENTOFELASTICITY: parseFloat(kv['COEFFICIENTOFELASTICITY'] ?? ''),
    EXPANSIONCOEFFICIENTOFWIRE: parseFloat(kv['EXPANSIONCOEFFICIENTOFWIRE'] ?? ''),
    RATEDSTRENGTH: parseFloat(kv['RATEDSTRENGTH'] ?? ''),
  };
}

// ============================================================================
// §6 辅助函数
// ============================================================================

/** 去除 BOM + 统一换行符为 \n */
function normalizeText(text: string): string {
  let t = text;
  // 去除 UTF-8 BOM
  if (t.charCodeAt(0) === 0xFEFF) {
    t = t.substring(1);
  }
  // 统一 \r\n / \r → \n
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return t;
}

/** 按行分割文本（去除 BOM + 统一换行） */
function splitLines(text: string): string[] {
  return normalizeText(text).split('\n');
}
