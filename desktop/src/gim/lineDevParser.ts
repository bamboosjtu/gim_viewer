/**
 * 线路工程 DEV 文件解析器（v5）。
 *
 * DEV 文件为普通 `KEY=VALUE` 键值对格式（无中文展示键、无三段式）。
 * 解析规则：
 * - 每行按第一个 `=` 拆分：左侧 prop_key，右侧 prop_value（值不再二次拆分）
 * - 清理 BOM、空行、不可见控制字符
 * - 异常行不阻断整体解析
 *
 * sort_order / source_path / normalized_path / file_name_lower 由调用方
 * (lineAttrPersistenceService) 按文件和行序赋值，parser 只负责单行结构。
 */

/** BOM 字符（U+FEFF） */
const BOM_RE = /\uFEFF/g;
/** 去除不可见控制字符 */
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** 单条线路 DEV 属性解析结果 */
export interface LineDevProperty {
  /** 属性键 */
  prop_key: string;
  /** 属性值（按第一个 = 拆分，值中可能含 = 但不再拆分） */
  prop_value: string | null;
  /** 原始行文本（清理后），用于调试 */
  raw_line: string | null;
}

/**
 * 解析线路 DEV 文件文本。
 *
 * @param text DEV 文件全文
 * @returns 解析得到的属性数组（已跳过空行），按行序排列
 */
export function parseLineDev(text: string): LineDevProperty[] {
  const result: LineDevProperty[] = [];
  if (!text) return result;

  const cleaned = text.replace(BOM_RE, '');

  for (const raw of cleaned.split(/\r?\n/)) {
    const line = raw.replace(CTRL_RE, '').trim();
    if (!line) continue;

    // 按第一个 `=` 拆分（值中可能含 =，但 DEV 不做二次拆分）
    const idx = line.indexOf('=');
    if (idx > 0) {
      const prop_key = line.slice(0, idx).trim();
      const prop_value = line.slice(idx + 1).trim();
      result.push({
        prop_key,
        prop_value: prop_value || null,
        raw_line: line,
      });
    } else {
      // 异常行：无 = ，不阻断
      result.push({
        prop_key: line,
        prop_value: null,
        raw_line: line,
      });
    }
  }

  return result;
}
