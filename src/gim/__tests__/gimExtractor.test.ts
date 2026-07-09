import { describe, expect, it } from 'vitest';
import {
  extractGimHeader,
  findArchiveOffset,
  getProjectTypeName,
  hasGimPackageHeader,
} from '../gimExtractor.js';

// ===== 测试用字节构造工具 =====

const GIMPKG = 'GIMPKG';
const SEVEN_ZIP_SIG = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
const ZIP_SIG = [0x50, 0x4b, 0x03, 0x04];

function strToBytes(s: string): number[] {
  return Array.from(s).map((c) => c.charCodeAt(0));
}

/** 构造一个最小化的 GIM 头部 buffer：魔数 + 字段 + 零填充 + 压缩签名 */
function buildGimBuffer(opts: {
  magicSuffix?: number; // GIMPKGS=0x53, GIMPKGT=0x54
  projectId?: string;
  projectName?: string;
  archiveSig?: number[]; // 7z 或 ZIP 签名
  zeroPadCount?: number; // 字段与签名之间的零填充数
}): ArrayBuffer {
  const { magicSuffix, projectId, projectName, archiveSig, zeroPadCount = 8 } = opts;
  const bytes: number[] = [];
  // 魔数
  for (const c of GIMPKG) bytes.push(c.charCodeAt(0));
  if (magicSuffix !== undefined) bytes.push(magicSuffix);
  // 头部字段（\0 分隔）
  if (projectId !== undefined) {
    for (const c of projectId) bytes.push(c.charCodeAt(0));
    bytes.push(0);
  }
  if (projectName !== undefined) {
    for (const c of projectName) bytes.push(c.charCodeAt(0));
    bytes.push(0);
  }
  // 零填充（>= 4 触发 extractGimHeader 的"零填充开始"判定）
  for (let i = 0; i < zeroPadCount; i++) bytes.push(0);
  // 压缩签名
  if (archiveSig) bytes.push(...archiveSig);
  // 尾部追加一些字节确保长度足够
  for (let i = 0; i < 16; i++) bytes.push(0);
  return new Uint8Array(bytes).buffer;
}

// ===== hasGimPackageHeader =====

describe('hasGimPackageHeader', () => {
  it('识别 GIMPKGS 头部', () => {
    const v = new Uint8Array(strToBytes('GIMPKGS'));
    expect(hasGimPackageHeader(v)).toBe(true);
  });

  it('识别 GIMPKGT 头部', () => {
    const v = new Uint8Array(strToBytes('GIMPKGT'));
    expect(hasGimPackageHeader(v)).toBe(true);
  });

  it('识别基础 GIMPKG 头部（无后缀）', () => {
    const v = new Uint8Array(strToBytes('GIMPKG'));
    expect(hasGimPackageHeader(v)).toBe(true);
  });

  it('拒绝非 GIMPKG 文件', () => {
    const v = new Uint8Array(strToBytes('7zBCAFabcdef'));
    expect(hasGimPackageHeader(v)).toBe(false);
  });

  it('长度不足时返回 false', () => {
    expect(hasGimPackageHeader(new Uint8Array(0))).toBe(false);
    expect(hasGimPackageHeader(new Uint8Array([0x47, 0x49, 0x4d]))).toBe(false); // "GIM"
  });

  it('仅前缀匹配即可（不检查后续字节）', () => {
    const v = new Uint8Array(strToBytes('GIMPKGXYZgarbage'));
    expect(hasGimPackageHeader(v)).toBe(true);
  });
});

// ===== findArchiveOffset =====

describe('findArchiveOffset', () => {
  it('定位 7z 签名偏移', () => {
    const buf = buildGimBuffer({
      magicSuffix: 0x53,
      archiveSig: SEVEN_ZIP_SIG,
      zeroPadCount: 8,
    });
    const offset = findArchiveOffset(buf);
    // 偏移 = 7(魔数) + 8(零填充) = 15
    expect(offset).toBe(15);
  });

  it('定位 ZIP 签名偏移', () => {
    const buf = buildGimBuffer({
      magicSuffix: 0x54,
      archiveSig: ZIP_SIG,
      zeroPadCount: 8,
    });
    const offset = findArchiveOffset(buf);
    expect(offset).toBe(15);
  });

  it('非 GIM 文件返回 0', () => {
    const buf = new ArrayBuffer(64);
    expect(findArchiveOffset(buf)).toBe(0);
  });

  it('buffer 长度不足 8 返回 0', () => {
    expect(findArchiveOffset(new ArrayBuffer(4))).toBe(0);
  });

  it('无压缩签名时返回 0', () => {
    const buf = buildGimBuffer({
      magicSuffix: 0x53,
      archiveSig: undefined,
      zeroPadCount: 8,
    });
    expect(findArchiveOffset(buf)).toBe(0);
  });

  it('魔数后立即接签名也能定位', () => {
    const bytes: number[] = [];
    for (const c of 'GIMPKGS') bytes.push(c.charCodeAt(0));
    bytes.push(...SEVEN_ZIP_SIG);
    for (let i = 0; i < 8; i++) bytes.push(0);
    const buf = new Uint8Array(bytes).buffer;
    expect(findArchiveOffset(buf)).toBe(7);
  });
});

// ===== extractGimHeader =====

describe('extractGimHeader', () => {
  it('解析 GIMPKGS（变电）头部 + 字段', () => {
    const buf = buildGimBuffer({
      magicSuffix: 0x53,
      projectId: 'PROJ-001',
      projectName: 'DemoSubstation',
      archiveSig: SEVEN_ZIP_SIG,
    });
    const info = extractGimHeader(buf);
    expect(info).not.toBeNull();
    expect(info!.magic).toBe('GIMPKGS');
    expect(info!.projectId).toBe('PROJ-001');
    expect(info!.projectName).toBe('DemoSubstation');
    expect(info!.archiveOffset).toBeGreaterThan(GIMPKG.length);
  });

  it('解析 GIMPKGT（线路）头部', () => {
    const buf = buildGimBuffer({
      magicSuffix: 0x54,
      projectId: 'LINE-2024',
      projectName: 'TestLine',
      archiveSig: ZIP_SIG,
    });
    const info = extractGimHeader(buf);
    expect(info).not.toBeNull();
    expect(info!.magic).toBe('GIMPKGT');
    expect(info!.projectId).toBe('LINE-2024');
    expect(info!.projectName).toBe('TestLine');
  });

  it('基础 GIMPKG（无后缀）解析为 6 字节魔数', () => {
    const buf = buildGimBuffer({
      magicSuffix: undefined,
      projectId: 'X',
      archiveSig: SEVEN_ZIP_SIG,
    });
    const info = extractGimHeader(buf);
    expect(info).not.toBeNull();
    expect(info!.magic).toBe('GIMPKG');
  });

  it('字段缺失时返回 undefined', () => {
    const buf = buildGimBuffer({
      magicSuffix: 0x53,
      projectId: undefined,
      projectName: undefined,
      archiveSig: SEVEN_ZIP_SIG,
      zeroPadCount: 16,
    });
    const info = extractGimHeader(buf);
    expect(info).not.toBeNull();
    expect(info!.magic).toBe('GIMPKGS');
    expect(info!.projectId).toBeUndefined();
    expect(info!.projectName).toBeUndefined();
  });

  it('非 GIM 文件返回 null', () => {
    const buf = new Uint8Array(strToBytes('NOT_A_GIM_FILE_padding_pad')).buffer;
    expect(extractGimHeader(buf)).toBeNull();
  });

  it('buffer 长度不足返回 null', () => {
    expect(extractGimHeader(new ArrayBuffer(4))).toBeNull();
  });

  it('无压缩签名返回 null（offset <= magicLen）', () => {
    const buf = buildGimBuffer({
      magicSuffix: 0x53,
      archiveSig: undefined,
      zeroPadCount: 32,
    });
    expect(extractGimHeader(buf)).toBeNull();
  });

  it('archiveOffset 与 findArchiveOffset 一致', () => {
    const buf = buildGimBuffer({
      magicSuffix: 0x53,
      projectId: 'P',
      archiveSig: SEVEN_ZIP_SIG,
      zeroPadCount: 12,
    });
    const info = extractGimHeader(buf);
    const directOffset = findArchiveOffset(buf);
    expect(info!.archiveOffset).toBe(directOffset);
  });

  it('连续 4+ 个 \\0 视为零填充，后续字段不再解析', () => {
    // projectId \0 \0\0\0\0 projectName 应在 projectId 后停止
    const bytes: number[] = [];
    for (const c of 'GIMPKGS') bytes.push(c.charCodeAt(0));
    for (const c of 'PROJ-A') bytes.push(c.charCodeAt(0));
    bytes.push(0);
    // 5 个连续零 → 触发零填充判定
    for (let i = 0; i < 5; i++) bytes.push(0);
    // 这部分应被忽略
    for (const c of 'IGNORED') bytes.push(c.charCodeAt(0));
    bytes.push(0);
    // 压缩签名
    bytes.push(...SEVEN_ZIP_SIG);
    for (let i = 0; i < 8; i++) bytes.push(0);
    const buf = new Uint8Array(bytes).buffer;
    const info = extractGimHeader(buf);
    expect(info).not.toBeNull();
    expect(info!.projectId).toBe('PROJ-A');
    // projectName 因零填充判定而未解析
    expect(info!.projectName).toBeUndefined();
  });

  it('UTF-8 多字节字段（中文项目名）能正确解码', () => {
    const encoder = new TextEncoder();
    const bytes: number[] = [];
    for (const c of 'GIMPKGS') bytes.push(c.charCodeAt(0));
    // projectId
    bytes.push(...encoder.encode('P001'));
    bytes.push(0);
    // projectName (中文)
    bytes.push(...encoder.encode('测试变电站'));
    bytes.push(0);
    // 零填充
    for (let i = 0; i < 8; i++) bytes.push(0);
    bytes.push(...SEVEN_ZIP_SIG);
    for (let i = 0; i < 8; i++) bytes.push(0);
    const buf = new Uint8Array(bytes).buffer;
    const info = extractGimHeader(buf);
    expect(info!.projectId).toBe('P001');
    expect(info!.projectName).toBe('测试变电站');
  });
});

// ===== getProjectTypeName =====

describe('getProjectTypeName', () => {
  it('GIMPKGS → 变电工程', () => {
    expect(getProjectTypeName('GIMPKGS')).toBe('变电工程');
  });

  it('GIMPKGT → 线路工程', () => {
    expect(getProjectTypeName('GIMPKGT')).toBe('线路工程');
  });

  it('其他 GIMPKG 变体 → 建筑工程', () => {
    expect(getProjectTypeName('GIMPKGB')).toBe('建筑工程');
    expect(getProjectTypeName('GIMPKG')).toBe('建筑工程');
    expect(getProjectTypeName('GIMPKGXYZ')).toBe('建筑工程');
  });

  it('完全无效的魔数 → 回退变电工程', () => {
    expect(getProjectTypeName('')).toBe('变电工程');
    expect(getProjectTypeName('UNKNOWN')).toBe('变电工程');
    expect(getProjectTypeName('7zBCAF')).toBe('变电工程');
  });
});
