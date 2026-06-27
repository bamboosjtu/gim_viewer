/**
 * M4-B3：悬链线参数语义验证审计服务（只读、纯内存）。
 *
 * 用于审计当前线路工程的悬链线候选字段覆盖度与样本分布，
 * 输出结构化报告供 Ctrl+Shift+C 审计导出或后续 UI 调用。
 *
 * 边界（强制）：
 * - 只读现有内存数据（graph / mapData），不读 DB、不读 GIM 文件
 * - 不影响渲染、不修改 state、不修改 SQLite
 * - 样本数量限制（每类最多 MAX_CATENARY_SAMPLES 条），避免报告体积爆炸
 * - 入参使用 unknown 类型，由本服务内部进行类型收窄，调用方无需强转
 * - 字段含义全部以"疑似 / 候选 / 待确认"措辞，不写成结论
 */
import type { GimGraph, GimGraphNode } from '../gim/gimGraphTypes.js';
import type { LineMapData } from '../gim/lineMapData.js';

/** 悬链线参数审计样本上限（高于通用 MAX_SAMPLES，便于格式判断） */
const MAX_CATENARY_SAMPLES = 20;

/** 悬链线候选字段全覆盖清单（用于覆盖率统计） */
const CATENARY_CANDIDATE_FIELDS = [
  'KVALUE',
  'SPLIT',
  'POINT0.BLHA',
  'POINT1.BLHA',
  'POINT0.MATRIX0',
  'POINT1.MATRIX0',
  'ISJUMPER',
  'MATERIALSHEET',
  'TRANSFORMMATRIX',
  'BACKSTRING',
  'FRONTSTRING',
];

/** 悬链线参数审计报告 */
export interface LineCatenaryParamAuditReport {
  /** WIRE 节点总数（覆盖率分母） */
  wireCount: number;
  /** 各候选字段的覆盖率统计 */
  coverage: Record<string, {
    /** 出现次数 */
    count: number;
    /** 占 wireCount 比例（0~1） */
    ratio: number;
    /** 样本值（最多 MAX_CATENARY_SAMPLES 条） */
    sampleValues: string[];
  }>;
  /** MATRIX0 格式样本（POINT0.MATRIX0 / POINT1.MATRIX0 各取部分样本） */
  matrix0FormatSamples: Matrix0FormatSample[];
  /** KVALUE 数字分布样本 */
  kValueSamples: KValueSample[];
  /** SPLIT 整数分布样本 */
  splitSamples: SplitSample[];
  /** BLHA 高程样本（起终点高程及高差） */
  blhaElevationSamples: BlhaElevationSample[];
  /** 语义假设（疑似 / 候选 / 待确认，禁止写成结论） */
  semanticHypotheses: string[];
  /** 阻塞问题（需人工或样本核验才能推进 M4-B4） */
  blockingQuestions: string[];
  /** M4-B4 决策建议 */
  recommendations: string[];
}

/** MATRIX0 格式样本 */
export interface Matrix0FormatSample {
  path: string;
  point0Matrix0: string | null;
  point1Matrix0: string | null;
  /** 逗号分隔后的元素数量（用于推断矩阵维度） */
  parsedLength: number | null;
  /** 推断的格式（'4x4-matrix' / '3x4-matrix' / 'triplet' / 'scalar' / 'unknown'） */
  likelyFormat: string;
}

/** KVALUE 样本 */
export interface KValueSample {
  path: string;
  wireType: string;
  kValue: string | null;
  /** 尝试 parseFloat 的结果，失败为 null */
  numericValue: number | null;
}

/** SPLIT 样本 */
export interface SplitSample {
  path: string;
  split: string | null;
  /** 尝试 parseInt 的结果，失败为 null */
  numericValue: number | null;
  /** 是否为整数 */
  isInteger: boolean;
}

/** BLHA 高程样本 */
export interface BlhaElevationSample {
  path: string;
  /** POINT0.BLHA 解析出的高程（第 3 段） */
  point0Elevation: number | null;
  /** POINT1.BLHA 解析出的高程 */
  point1Elevation: number | null;
  /** 高差（米）：point1 - point0，两端缺失为 null */
  elevationDelta: number | null;
}

/**
 * 构建 M4-B3 悬链线参数语义验证报告。
 *
 * 只读内存数据，不读 DB、不改 schema、不影响渲染。
 * 字段含义全部以"疑似 / 候选 / 待确认"措辞，不写成结论。
 *
 * @param args.graph 已构建的线路工程图
 * @param args.mapData extractLineMapData 输出（用于 wireType 反查）
 */
export function buildLineCatenaryParamAuditReport(args: {
  graph: unknown;
  mapData: unknown;
}): LineCatenaryParamAuditReport {
  const graph = args.graph as GimGraph | null;
  const mapData = args.mapData as LineMapData | null;

  // 兜底：graph 缺失时返回空报告
  if (!graph || !graph.nodesByPath) {
    return emptyCatenaryReport();
  }

  // 1. 收集 WIRE 节点（用于统计与采样）
  const wireNodes: GimGraphNode[] = [];
  for (const node of graph.nodesByPath.values()) {
    if (node.entityName === 'WIRE') wireNodes.push(node);
  }
  const wireCount = wireNodes.length;

  // 2. 覆盖率统计
  const coverage: LineCatenaryParamAuditReport['coverage'] = {};
  for (const field of CATENARY_CANDIDATE_FIELDS) {
    coverage[field] = { count: 0, ratio: 0, sampleValues: [] };
  }

  // 3. 采样桶
  const matrix0Samples: Matrix0FormatSample[] = [];
  const kValueSamples: KValueSample[] = [];
  const splitSamples: SplitSample[] = [];
  const blhaSamples: BlhaElevationSample[] = [];

  // 4. 构建 path → wireType 反查（来自 mapData.wires.nodeRef）
  const wireTypeByPath = new Map<string, string>();
  if (mapData && Array.isArray(mapData.wires)) {
    for (const w of mapData.wires) {
      if (w.nodeRef?.path) wireTypeByPath.set(w.nodeRef.path, w.wireType || 'UNKNOWN');
    }
  }

  // 5. 遍历采样
  for (const node of wireNodes) {
    const raw = node.rawProps;

    // 覆盖率 + 样本值
    for (const field of CATENARY_CANDIDATE_FIELDS) {
      const val = raw[field];
      if (val !== undefined && val !== null && val !== '') {
        const c = coverage[field];
        c.count++;
        if (c.sampleValues.length < MAX_CATENARY_SAMPLES && val.length < 200) {
          c.sampleValues.push(val);
        }
      }
    }

    // MATRIX0 格式样本（POINT0.MATRIX0 优先）
    const p0m0 = raw['POINT0.MATRIX0'] || null;
    const p1m0 = raw['POINT1.MATRIX0'] || null;
    if ((p0m0 || p1m0) && matrix0Samples.length < MAX_CATENARY_SAMPLES) {
      matrix0Samples.push({
        path: node.path,
        point0Matrix0: p0m0,
        point1Matrix0: p1m0,
        parsedLength: guessMatrix0Length(p0m0 || p1m0),
        likelyFormat: guessMatrix0Format(p0m0 || p1m0),
      });
    }

    // KVALUE 样本
    const kValue = raw['KVALUE'] || null;
    if (kValue && kValueSamples.length < MAX_CATENARY_SAMPLES) {
      kValueSamples.push({
        path: node.path,
        wireType: wireTypeByPath.get(node.path) || 'UNKNOWN',
        kValue,
        numericValue: tryParseFloat(kValue),
      });
    }

    // SPLIT 样本
    const split = raw['SPLIT'] || null;
    if (split && splitSamples.length < MAX_CATENARY_SAMPLES) {
      const num = tryParseInt(split);
      splitSamples.push({
        path: node.path,
        split,
        numericValue: num,
        isInteger: num !== null && Number.isInteger(num) && num > 0,
      });
    }

    // BLHA 高程样本
    const p0Blha = raw['POINT0.BLHA'] || null;
    const p1Blha = raw['POINT1.BLHA'] || null;
    if ((p0Blha || p1Blha) && blhaSamples.length < MAX_CATENARY_SAMPLES) {
      const p0e = parseBlhaElevation(p0Blha);
      const p1e = parseBlhaElevation(p1Blha);
      blhaSamples.push({
        path: node.path,
        point0Elevation: p0e,
        point1Elevation: p1e,
        elevationDelta: (p0e !== null && p1e !== null) ? (p1e - p0e) : null,
      });
    }
  }

  // 6. 计算覆盖率 ratio
  for (const field of CATENARY_CANDIDATE_FIELDS) {
    const c = coverage[field];
    c.ratio = wireCount > 0 ? c.count / wireCount : 0;
  }

  // 7. 生成语义假设、阻塞问题、建议
  const semanticHypotheses = buildSemanticHypotheses(coverage, wireCount);
  const blockingQuestions = buildBlockingQuestions(coverage, wireCount);
  const recommendations = buildCatenaryRecommendations(coverage, wireCount);

  return {
    wireCount,
    coverage,
    matrix0FormatSamples: matrix0Samples,
    kValueSamples,
    splitSamples,
    blhaElevationSamples: blhaSamples,
    semanticHypotheses,
    blockingQuestions,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

function emptyCatenaryReport(): LineCatenaryParamAuditReport {
  return {
    wireCount: 0,
    coverage: {},
    matrix0FormatSamples: [],
    kValueSamples: [],
    splitSamples: [],
    blhaElevationSamples: [],
    semanticHypotheses: ['线路工程图为空，无法做悬链线参数验证'],
    blockingQuestions: [],
    recommendations: ['需先打开线路 GIM 才能采集悬链线参数样本'],
  };
}

/** 尝试 parseFloat，失败返回 null */
function tryParseFloat(value: string): number | null {
  const n = parseFloat(value.trim());
  return Number.isFinite(n) ? n : null;
}

/** 尝试 parseInt（10 进制），失败返回 null */
function tryParseInt(value: string): number | null {
  const n = parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析 BLHA 第 3 段（高程，米）。
 * BLHA 格式：纬度,经度,高程,方位角（lat,lng,h,azimuth）
 * 失败返回 null。
 */
function parseBlhaElevation(blha: string | null): number | null {
  if (!blha) return null;
  const parts = blha.split(',');
  if (parts.length < 3) return null;
  const h = parseFloat(parts[2].trim());
  return Number.isFinite(h) ? h : null;
}

/**
 * 推断 MATRIX0 字符串中逗号分隔的元素数量。
 * 用于判断是 4x4 矩阵（16）、3x4 矩阵（12）、三元组（3）、标量（1）还是其他。
 */
function guessMatrix0Length(value: string | null): number | null {
  if (!value) return null;
  // 可能是逗号或空格分隔
  const commaCount = (value.match(/,/g) || []).length;
  if (commaCount > 0) {
    return commaCount + 1;
  }
  const spaceCount = (value.match(/\s+/g) || []).length;
  if (spaceCount > 0) {
    return spaceCount + 1;
  }
  // 单个数字
  const n = parseFloat(value.trim());
  return Number.isFinite(n) ? 1 : null;
}

/** 推断 MATRIX0 的可能格式 */
function guessMatrix0Format(value: string | null): string {
  const len = guessMatrix0Length(value);
  if (len === null) return 'unknown';
  if (len === 16) return '4x4-matrix';
  if (len === 12) return '3x4-matrix';
  if (len === 9) return '3x3-matrix';
  if (len === 4) return 'quaternion';
  if (len === 3) return 'triplet';
  if (len === 1) return 'scalar';
  if (len === 6) return '6-tuple';
  return `unknown(${len})`;
}

/** 生成语义假设（疑似 / 候选，不写结论） */
function buildSemanticHypotheses(
  coverage: LineCatenaryParamAuditReport['coverage'],
  wireCount: number,
): string[] {
  const hyp: string[] = [];
  if (wireCount === 0) return hyp;

  const kvalueCov = coverage['KVALUE'];
  if (kvalueCov && kvalueCov.count > 0) {
    hyp.push(`KVALUE 疑似张力 / 弧垂相关参数（覆盖率 ${(kvalueCov.ratio * 100).toFixed(1)}%），但物理含义待 M4-B3 样本核验`);
  } else {
    hyp.push('KVALUE 缺失，疑似为可选字段或来自父 F4(WIRE)');
  }

  const splitCov = coverage['SPLIT'];
  if (splitCov && splitCov.count > 0) {
    hyp.push(`SPLIT 疑似分裂导线数（覆盖率 ${(splitCov.ratio * 100).toFixed(1)}%），需验证是否为正整数`);
  }

  const p0m0Cov = coverage['POINT0.MATRIX0'];
  const p1m0Cov = coverage['POINT1.MATRIX0'];
  if ((p0m0Cov && p0m0Cov.count > 0) || (p1m0Cov && p1m0Cov.count > 0)) {
    hyp.push('POINT0/1.MATRIX0 疑似挂点或端点局部变换参数（坐标系与单位待确认）');
  }

  const p0BlhaCov = coverage['POINT0.BLHA'];
  if (p0BlhaCov && p0BlhaCov.count > 0) {
    hyp.push('POINT0.BLHA 第 3 段可作为高程候选（与 POINT1.BLHA 高差参与弧垂计算）');
  }

  const isJumperCov = coverage['ISJUMPER'];
  if (isJumperCov && isJumperCov.count > 0) {
    hyp.push(`ISJUMPER 疑似跳线标识（覆盖率 ${(isJumperCov.ratio * 100).toFixed(1)}%），跳线可能不需要悬链线计算`);
  }

  const matSheetCov = coverage['MATERIALSHEET'];
  if (matSheetCov && matSheetCov.count > 0) {
    hyp.push(`MATERIALSHEET 疑似导线材料表（覆盖率 ${(matSheetCov.ratio * 100).toFixed(1)}%），可能参与弧垂计算（线规/截面积）`);
  }

  const transformCov = coverage['TRANSFORMMATRIX'];
  if (transformCov && transformCov.count > 0) {
    hyp.push(`TRANSFORMMATRIX 疑似节点整体变换矩阵（覆盖率 ${(transformCov.ratio * 100).toFixed(1)}%），与 POINT0/1.MATRIX0 关系待确认`);
  }

  return hyp;
}

/** 生成阻塞问题（需人工或样本核验才能推进 M4-B4） */
function buildBlockingQuestions(
  coverage: LineCatenaryParamAuditReport['coverage'],
  wireCount: number,
): string[] {
  const qs: string[] = [];
  if (wireCount === 0) {
    qs.push('未发现 WIRE 节点，无法采集悬链线参数样本');
    return qs;
  }

  const kvalueCov = coverage['KVALUE'];
  if (!kvalueCov || kvalueCov.count === 0) {
    qs.push('KVALUE 在所有 WIRE 节点中缺失，是否来自父 F4(WIRE) 或 FAM 文件？');
  } else {
    qs.push('KVALUE 物理含义未确认（张力系数？弧垂参数？应力？是否单位无关？）');
  }

  const p0m0Cov = coverage['POINT0.MATRIX0'];
  if (!p0m0Cov || p0m0Cov.count === 0) {
    qs.push('POINT0.MATRIX0 缺失，悬链线挂点高程是否可仅依赖 BLHA 第 3 段？');
  } else {
    qs.push('POINT0/1.MATRIX0 坐标系与单位未确认（局部坐标？世界坐标？米？毫米？）');
  }

  const matSheetCov = coverage['MATERIALSHEET'];
  if (matSheetCov && matSheetCov.count > 0) {
    qs.push('是否需要 MATERIALSHEET 参与弧垂计算（导线截面/单位长度重量/张力等级）？');
  }

  qs.push('GIM 标准文档是否有 KVALUE/SPLIT/MATRIX0 的明确字段定义？');

  return qs;
}

/** 生成 M4-B4 决策建议 */
function buildCatenaryRecommendations(
  coverage: LineCatenaryParamAuditReport['coverage'],
  wireCount: number,
): string[] {
  const recs: string[] = [];
  if (wireCount === 0) {
    recs.push('无 WIRE 节点，无需进入 M4-B4');
    return recs;
  }

  const kvalueCov = coverage['KVALUE'];
  const p0BlhaCov = coverage['POINT0.BLHA'];
  const p1BlhaCov = coverage['POINT1.BLHA'];

  // 数据齐备性评估
  const kvalueReady = !!(kvalueCov && kvalueCov.count > 0);
  const blhaReady = !!(p0BlhaCov && p0BlhaCov.count > 0 && p1BlhaCov && p1BlhaCov.count > 0);

  if (kvalueReady && blhaReady) {
    recs.push('M4-B4 可先做"示意悬链线"：基于 KVALUE + BLHA 高程差，假设公式 f(x) = k * x * (L - x)（抛物线近似）');
    recs.push('M4-B4 不建议直接做"工程语义悬链线"：KVALUE 物理含义未确认，可能产生误导');
  } else {
    recs.push('M4-B4 数据齐备性不足：' + (!kvalueReady ? 'KVALUE 缺失 ' : '') + (!blhaReady ? 'BLHA 端点缺失' : ''));
  }

  recs.push('是否需要更多样本：当前每类最多 20 条样本，若 GIM 标准文档无字段定义，需收集 2-3 个不同电压等级 / 不同塔型的样本工程');
  recs.push('是否需要用户人工确认字段含义：建议在 M4-B3 报告输出后由用户对照样本工程确认');
  recs.push('是否继续保持直线段作为默认：建议是，悬链线作为可选增强（feature flag 控制）');

  return recs;
}
