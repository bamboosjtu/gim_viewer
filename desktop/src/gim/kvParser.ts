/**
 * GIM 文本文件共用的 KEY=VALUE 解析器。
 *
 * CBM、DEV、PHM 以及部分线路辅助文件都使用“按首个等号拆分”的基础
 * 语法。更高层的 FAM/线路 MOD parser 仍保留自己的 grammar；这里只负责
 * 不带 section 和 block 语义的普通键值行。
 */
export function parseKeyValue(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '');
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    result[key] = line.slice(idx + 1).trim();
  }
  return result;
}
