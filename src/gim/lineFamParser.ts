/**
 * 线路工程 FAM 文件解析器（v5）。
 *
 * 线路 FAM 行格式与变电 FAM 不同，为扁平 `中文展示键=ENGLISH_KEY=值` 三段式，
 * 且值本身可能含 `=`（如坐标串、带等号的表达式），因此不能用简单 split。
 *
 * 解析规则：
 * - 行含两个及以上 `=`（split 后 ≥3 段）：
 *   - display_key = 第 1 段（中文展示键）
 *   - prop_key    = 第 2 段（英文键）
 *   - prop_value  = 第 3 段及以后用 `=` 重新拼回（保留值中的等号）
 * - 行只含一个 `=`（split 后 2 段）：
 *   - prop_key    = 第 1 段
 *   - prop_value  = 第 2 段
 *   - display_key = null
 * - 清理 BOM、空行、不可见控制字符
 * - 异常行不阻断整体解析，保留 warning 计数
 *
 * sort_order / source_path / normalized_path / file_name_lower 由调用方
 * (lineAttrPersistenceService) 按文件和行序赋值，parser 只负责单行结构。
 */

/** BOM 字符（U+FEFF）及常见不可见控制字符正则 */
const BOM_RE = /\uFEFF/g;
/** 去除行首尾不可见控制字符（保留可见内容和普通空格） */
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** 单条线路 FAM 属性解析结果 */
export interface LineFamProperty {
  /** 中文展示键（三段式行首段），单段式行无此值 */
  display_key: string | null;
  /** 属性键（三段式为英文键，单段式为第一段） */
  prop_key: string;
  /** 属性值（可能含 =） */
  prop_value: string | null;
  /** 原始行文本（清理后），用于调试 */
  raw_line: string | null;
}

/** FAM 解析统计（异常行计数，供调用方记录 warning） */
export interface LineFamParseStats {
  total: number;
  warnings: number;
}

/**
 * 解析线路 FAM 文件文本。
 *
 * @param text FAM 文件全文
 * @returns 解析得到的属性数组（已跳过空行），按行序排列
 */
export function parseLineFam(text: string): LineFamProperty[] {
  const result: LineFamProperty[] = [];
  if (!text) return result;

  // 清理 BOM（全文）
  const cleaned = text.replace(BOM_RE, '');

  for (const raw of cleaned.split(/\r?\n/)) {
    // 清理不可见控制字符，保留可见内容
    const line = raw.replace(CTRL_RE, '').trim();
    if (!line) continue;

    // 按 `=` 分段（不限制段数，第三段及以后重新拼回）
    const parts = line.split('=');
    if (parts.length >= 3) {
      // 三段式：中文展示键=ENGLISH_KEY=值（值可能含 =）
      const display_key = parts[0].trim();
      const prop_key = parts[1].trim();
      const prop_value = parts.slice(2).join('=').trim();
      result.push({
        display_key: display_key || null,
        prop_key,
        prop_value: prop_value || null,
        raw_line: line,
      });
    } else if (parts.length === 2) {
      // 单段式：KEY=VALUE
      const prop_key = parts[0].trim();
      const prop_value = parts[1].trim();
      result.push({
        display_key: null,
        prop_key,
        prop_value: prop_value || null,
        raw_line: line,
      });
    } else {
      // 异常行：无 `=` 或只有 `=`，不阻断，保留 raw_line 用于排查
      result.push({
        display_key: null,
        prop_key: line,
        prop_value: null,
        raw_line: line,
      });
    }
  }

  return result;
}
