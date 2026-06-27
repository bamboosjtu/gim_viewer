/**
 * M4-B3A：悬链线参数审计导出服务（纯内存、只读）。
 *
 * 把 M4-B3 的审计报告包装成可复制、可保存、可人工核验的导出 payload：
 * - JSON：完整 LineCatenaryParamAuditReport + 项目摘要 + 生成时间
 * - Markdown：面向人工核验的精简摘要
 *
 * 边界（强制）：
 * - 复用 buildLineCatenaryParamAuditReport()，不重复实现审计逻辑
 * - 只读 graph / mapData，不读 DB、不改 schema
 * - 不输出完整 graph、不输出完整 mapData
 * - 样本仍受 MAX_CATENARY_SAMPLES 限制（在 lineGeometryAuditService 内部）
 * - 不把字段含义写死为确定结论（措辞保持"疑似 / 候选 / 待确认"）
 */

import { buildLineCatenaryParamAuditReport } from './lineGeometryAuditService.js';
import type { LineCatenaryParamAuditReport } from './lineGeometryAuditService.js';
import { buildLineSpanGroupingAuditReport } from './lineSpanGroupingAuditService.js';
import type { LineSpanGroupingAuditReport } from './lineSpanGroupingAuditService.js';
import type { GimGraph } from '../gim/gimGraphTypes.js';
import type { LineMapData } from '../gim/lineMapData.js';

/** 导出 payload（JSON 复制内容） */
export interface LineCatenaryAuditExportPayload {
  /** 生成时间（ISO 8601 字符串） */
  generatedAt: string;
  /** 解析器版本（可选，便于核验报告对应的 schema 版本） */
  parserVersion?: string;
  /** 项目摘要（不含敏感路径） */
  projectSummary: {
    /** 工程类型（substation / transmission_line / hybrid / unknown） */
    projectType?: string;
    /** 总节点数 */
    totalNodes?: number;
    /** WIRE 节点数 */
    wireCount: number;
    /** 塔位数（来源于 mapData.towers） */
    towerCount?: number;
    /** 跨越点数（来源于 mapData.crosses） */
    crossCount?: number;
  };
  /** 完整审计报告（含样本，受 MAX_CATENARY_SAMPLES 限制） */
  report: LineCatenaryParamAuditReport;
  /**
   * M4-B3B：档距聚合审计报告（按 BLHA 端点聚合，分析"一档多线"结构 + MATRIX0 平移分量）。
   * 向后兼容：旧 payload 无此字段，调用方需判空。
   */
  spanGroupingReport?: LineSpanGroupingAuditReport;
}

/**
 * 构建 M4-B3A 悬链线参数审计导出 payload。
 *
 * @param args.graph 已构建的线路工程图
 * @param args.mapData 已提取的地图数据
 * @param args.parserVersion 可选，当前 PARSER_VERSION
 */
export function buildLineCatenaryAuditExportPayload(args: {
  graph: unknown;
  mapData: unknown;
  parserVersion?: string;
}): LineCatenaryAuditExportPayload {
  const graph = args.graph as GimGraph | null;
  const mapData = args.mapData as LineMapData | null;

  // 1. 构建审计报告
  const report = buildLineCatenaryParamAuditReport({
    graph: args.graph,
    mapData: args.mapData,
  });

  // 2. 构建项目摘要
  let totalNodes: number | undefined;
  if (graph && graph.nodesByPath) {
    totalNodes = graph.nodesByPath.size;
  }

  let towerCount: number | undefined;
  if (mapData && Array.isArray(mapData.towers)) {
    towerCount = mapData.towers.length;
  }

  let crossCount: number | undefined;
  if (mapData && Array.isArray(mapData.crosses)) {
    crossCount = mapData.crosses.length;
  }

  // 3. 组装 payload
  // M4-B3B：构建档距聚合报告（按 BLHA 端点聚合，分析"一档多线"结构 + MATRIX0 平移分量）
  const spanGroupingReport = buildLineSpanGroupingAuditReport({
    graph: args.graph,
    mapData: args.mapData,
  });

  return {
    generatedAt: new Date().toISOString(),
    parserVersion: args.parserVersion,
    projectSummary: {
      projectType: graph?.projectType,
      totalNodes,
      wireCount: report.wireCount,
      towerCount,
      crossCount,
    },
    report,
    spanGroupingReport,
  };
}

/**
 * 将 payload 格式化为面向人工核验的 Markdown 摘要。
 *
 * 重点展示：
 * - 项目摘要（wireCount / towerCount）
 * - 各候选字段覆盖率
 * - KVALUE / SPLIT 样本前 5 条
 * - MATRIX0 格式样本前 5 条
 * - BLHA 高程样本前 5 条
 * - 语义假设 / 阻塞问题 / 建议
 *
 * 不输出完整样本（避免摘要过长），完整样本见 JSON payload。
 */
export function formatLineCatenaryAuditMarkdown(payload: LineCatenaryAuditExportPayload): string {
  const lines: string[] = [];
  const ps = payload.projectSummary;
  const r = payload.report;

  // 标题
  lines.push(`# 悬链线参数审计摘要`);
  lines.push('');
  lines.push(`> 生成时间：${payload.generatedAt}`);
  if (payload.parserVersion) {
    lines.push(`> 解析器版本：${payload.parserVersion}`);
  }
  lines.push(`> 工程类型：${ps.projectType || '—'}`);
  lines.push('');

  // 1. 项目摘要
  lines.push('## 1. 项目摘要');
  lines.push('');
  lines.push(`- 总节点数：${ps.totalNodes ?? '—'}`);
  lines.push(`- WIRE 节点数：${ps.wireCount}`);
  lines.push(`- 塔位数：${ps.towerCount ?? '—'}`);
  lines.push(`- 跨越点数：${ps.crossCount ?? '—'}`);
  lines.push('');

  // 2. 覆盖率
  lines.push('## 2. 候选字段覆盖率');
  lines.push('');
  lines.push('| 字段 | 出现次数 | 覆盖率 |');
  lines.push('|---|---|---|');
  for (const [field, stat] of Object.entries(r.coverage)) {
    const pct = (stat.ratio * 100).toFixed(1) + '%';
    lines.push(`| ${field} | ${stat.count} | ${pct} |`);
  }
  lines.push('');

  // 3. KVALUE 样本（前 5 条）
  lines.push('## 3. KVALUE 样本（前 5 条）');
  lines.push('');
  if (r.kValueSamples.length === 0) {
    lines.push('无 KVALUE 样本。');
  } else {
    lines.push('| 路径 | 导线类型 | KVALUE | 数值 |');
    lines.push('|---|---|---|---|');
    for (const s of r.kValueSamples.slice(0, 5)) {
      const numStr = s.numericValue !== null ? String(s.numericValue) : '—';
      lines.push(`| ${shortPath(s.path)} | ${s.wireType} | ${s.kValue || '—'} | ${numStr} |`);
    }
  }
  lines.push('');

  // 4. SPLIT 样本（前 5 条）
  lines.push('## 4. SPLIT 样本（前 5 条）');
  lines.push('');
  if (r.splitSamples.length === 0) {
    lines.push('无 SPLIT 样本。');
  } else {
    lines.push('| 路径 | SPLIT | 数值 | 是否正整数 |');
    lines.push('|---|---|---|---|');
    for (const s of r.splitSamples.slice(0, 5)) {
      const numStr = s.numericValue !== null ? String(s.numericValue) : '—';
      lines.push(`| ${shortPath(s.path)} | ${s.split || '—'} | ${numStr} | ${s.isInteger ? '是' : '否'} |`);
    }
  }
  lines.push('');

  // 5. MATRIX0 格式样本（前 5 条）
  lines.push('## 5. MATRIX0 格式样本（前 5 条）');
  lines.push('');
  if (r.matrix0FormatSamples.length === 0) {
    lines.push('无 MATRIX0 样本。');
  } else {
    lines.push('| 路径 | P0.MATRIX0 | P1.MATRIX0 | 元素数 | 推断格式 |');
    lines.push('|---|---|---|---|---|');
    for (const s of r.matrix0FormatSamples.slice(0, 5)) {
      const p0 = truncate(s.point0Matrix0, 30);
      const p1 = truncate(s.point1Matrix0, 30);
      const lenStr = s.parsedLength !== null ? String(s.parsedLength) : '—';
      lines.push(`| ${shortPath(s.path)} | ${p0} | ${p1} | ${lenStr} | ${s.likelyFormat} |`);
    }
  }
  lines.push('');

  // 6. BLHA 高程样本（前 5 条）
  lines.push('## 6. BLHA 高程样本（前 5 条）');
  lines.push('');
  if (r.blhaElevationSamples.length === 0) {
    lines.push('无 BLHA 高程样本。');
  } else {
    lines.push('| 路径 | 起点 P0 高程 | 终点 P1 高程 | 高差（米） |');
    lines.push('|---|---|---|---|');
    for (const s of r.blhaElevationSamples.slice(0, 5)) {
      const p0e = s.point0Elevation !== null ? s.point0Elevation.toFixed(2) : '—';
      const p1e = s.point1Elevation !== null ? s.point1Elevation.toFixed(2) : '—';
      const delta = s.elevationDelta !== null ? s.elevationDelta.toFixed(2) : '—';
      lines.push(`| ${shortPath(s.path)} | ${p0e} | ${p1e} | ${delta} |`);
    }
  }
  lines.push('');

  // 7. 语义假设
  lines.push('## 7. 语义假设（疑似 / 候选 / 待确认）');
  lines.push('');
  if (r.semanticHypotheses.length === 0) {
    lines.push('无假设。');
  } else {
    for (const h of r.semanticHypotheses) {
      lines.push(`- ${h}`);
    }
  }
  lines.push('');

  // 8. 阻塞问题
  lines.push('## 8. 阻塞问题');
  lines.push('');
  if (r.blockingQuestions.length === 0) {
    lines.push('无阻塞问题。');
  } else {
    for (const q of r.blockingQuestions) {
      lines.push(`- ${q}`);
    }
  }
  lines.push('');

  // 9. M4-B4 建议
  lines.push('## 9. M4-B4 建议');
  lines.push('');
  if (r.recommendations.length === 0) {
    lines.push('无建议。');
  } else {
    for (const rec of r.recommendations) {
      lines.push(`- ${rec}`);
    }
  }
  lines.push('');

  // 10/11. M4-B3B 档距聚合摘要 + MATRIX0 平移样本
  if (payload.spanGroupingReport) {
    appendSpanGroupingMarkdown(lines, payload.spanGroupingReport);
  }

  // 尾注
  lines.push('---');
  lines.push('');
  lines.push('> 完整样本（每类最多 20 条）见 JSON payload。');
  lines.push('> 字段含义全部为"疑似 / 候选 / 待确认"，需用户对照样本工程核验后才能进入 M4-B4。');

  return lines.join('\n');
}

/**
 * M4-B3B：将档距聚合报告追加到 Markdown 行数组。
 *
 * 新增章节：
 * - §10 档距聚合摘要（唯一档距数 / min/max/avg / Top 5）
 * - §11 MATRIX0 平移样本（每档 zRange 表）
 */
function appendSpanGroupingMarkdown(
  lines: string[],
  sg: LineSpanGroupingAuditReport,
): void {
  // §10 档距聚合摘要
  lines.push('## 10. 档距聚合摘要（M4-B3B）');
  lines.push('');
  lines.push(`- WIRE 总数：${sg.wireCount}`);
  lines.push(`- 唯一档距数：${sg.spanGroupCount}`);
  const stats = sg.spanGroupSizeStats;
  lines.push(`- 每档 WIRE 数：min=${stats.min}, max=${stats.max}, avg=${stats.avg.toFixed(2)}`);
  if (stats.topSizes.length > 0) {
    lines.push('- Top 5 档距（按 WIRE 数）：');
    for (const t of stats.topSizes) {
      lines.push(`  - ${shortPath(t.spanKey)}：${t.wireCount} 条`);
    }
  }
  lines.push('');

  // §11 MATRIX0 平移样本
  lines.push('## 11. MATRIX0 平移样本（M4-B3B，前 5 档距）');
  lines.push('');
  if (sg.spanGroupSamples.length === 0) {
    lines.push('无档距样本。');
  } else {
    lines.push('| 档距 | WIRE 数 | wireTypes | SPLIT | P0 zRange | P1 zRange | KVALUE 0/非0 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const s of sg.spanGroupSamples.slice(0, 5)) {
      const spanLabel = shortSpanKey(s.spanKey);
      const wireTypes = Object.entries(s.wireTypeCounts)
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
      const splitStr = Object.entries(s.splitCounts)
        .map(([k, v]) => `${k}:${v}`)
        .join(',');
      const p0z = formatRange(s.point0TranslationStats.zRange);
      const p1z = formatRange(s.point1TranslationStats.zRange);
      const kStr = `${s.kValueStats.zeroCount}/${s.kValueStats.nonZeroCount}`;
      lines.push(`| ${spanLabel} | ${s.wireCount} | ${wireTypes} | ${splitStr} | ${p0z} | ${p1z} | ${kStr} |`);
    }
  }
  lines.push('');

  // 观察 / 阻塞 / 建议
  if (sg.observations.length > 0) {
    lines.push('### 11.1 档距聚合观察');
    lines.push('');
    for (const o of sg.observations) {
      lines.push(`- ${o}`);
    }
    lines.push('');
  }
  if (sg.blockingQuestions.length > 0) {
    lines.push('### 11.2 阻塞问题');
    lines.push('');
    for (const q of sg.blockingQuestions) {
      lines.push(`- ${q}`);
    }
    lines.push('');
  }
  if (sg.recommendations.length > 0) {
    lines.push('### 11.3 M4-B4 决策建议');
    lines.push('');
    for (const rec of sg.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push('');
  }
}

/** 格式化 [min, max] 范围为字符串 */
function formatRange(range: [number, number] | null): string {
  if (!range) return '—';
  return `[${range[0].toFixed(2)}, ${range[1].toFixed(2)}]`;
}

/** 档距键截断：保留 BLHA 末段，避免表格过宽 */
function shortSpanKey(spanKey: string): string {
  if (spanKey === 'missing-endpoint') return 'missing-endpoint';
  // BLHA 通常为 "lat,lng,h,azimuth"，取末两段
  const parts = spanKey.split(' -> ');
  if (parts.length !== 2) return spanKey;
  const short0 = shortBlha(parts[0]);
  const short1 = shortBlha(parts[1]);
  return `${short0} -> ${short1}`;
}

/** BLHA 截断：仅保留前两段（lat,lng） */
function shortBlha(blha: string): string {
  if (!blha) return '—';
  const parts = blha.split(',');
  if (parts.length < 2) return blha;
  return `${parts[0]},${parts[1]}`;
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/** 路径截断：保留末尾两段，避免 Markdown 表格过宽 */
function shortPath(path: string): string {
  if (!path) return '—';
  const parts = path.split('/');
  if (parts.length <= 2) return path;
  return '.../' + parts.slice(-2).join('/');
}

/** 字符串截断：超长加省略号 */
function truncate(value: string | null, maxLen: number): string {
  if (!value) return '—';
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + '...';
}
