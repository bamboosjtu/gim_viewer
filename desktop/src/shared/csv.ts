/**
 * 通用 CSV 构建与浏览器端文件下载工具（dev-log「无导出」项）。
 */

/** CSV 单元格转义：含逗号/引号/换行时用双引号包裹并翻倍内部引号 */
function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * 构建 CSV 文本。
 *
 * @param rows 行数组，首行通常为表头
 * @returns 以 \r\n 分行、带 UTF-8 BOM 的 CSV 字符串
 *          （BOM 保证 Excel 直接打开中文不乱码）
 */
export function buildCsv(rows: string[][]): string {
  const body = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  return `\uFEFF${body}`;
}

/**
 * 触发浏览器端文本文件下载（Tauri WebView2 与浏览器均支持 a[download]）。
 */
export function downloadTextFile(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    triggerDownload(filename, url);
  } finally {
    // 延迟释放，避免部分 WebView 立即 revoke 导致下载中断
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

/** 触发 data/blob URL 下载 */
export function triggerDownload(filename: string, href: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
