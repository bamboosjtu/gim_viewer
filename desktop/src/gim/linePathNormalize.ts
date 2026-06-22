/**
 * 线路工程 GIM 内部路径归一化（v5）。
 *
 * GIM 解压后的文件路径存在多种写法（`\` / `/` 混用、空段、大小写目录），
 * 直接用原始字符串做匹配会漏命中。这里提供统一归一化函数，供：
 * - line_cbm_ref.normalized_ref_value 写入
 * - line_fam_property / line_dev_property 的 normalized_path 写入
 * - 缓存命中后通过 normalized_path 匹配 currentFiles 中的属性文件
 *
 * 归一化规则：
 * 1. `\` 转 `/`
 * 2. 去掉空 segment（连续分隔符、首尾分隔符）
 * 3. 不强制改变大小写（GIM 内部目录可能是 Cbm/Dev/Fam 或 CBM/DEV/FAM，保留原样）
 *    匹配时另用 getFileNameLower 做文件名小写匹配兜底
 *
 * 保留原始 source_path 用于 UI 展示（display），归一化值仅用于索引/匹配。
 */

/**
 * 归一化 GIM 内部路径。
 *
 * @param path 原始路径（如 `Cbm\sub\x.fam` 或 `//Cbm//x.fam`）
 * @returns 归一化路径（如 `Cbm/sub/x.fam`），空输入返回空字符串
 */
export function normalizeGimPath(path: string): string {
  if (!path) return '';
  // 1. 反斜杠统一为正斜杠
  let p = path.replace(/\\/g, '/');
  // 2. 去掉空 segment：连续斜杠合并、去除首尾斜杠
  //    注意：不拆分后再 join，因为目录/文件名本身不应含斜杠
  p = p
    .split('/')
    .filter((seg) => seg.length > 0)
    .join('/');
  return p;
}

/**
 * 获取路径的文件名小写（用于诊断和匹配兜底）。
 *
 * 例如 `Cbm/sub/X.FAM` → `x.fam`，`Dev/device.dev` → `device.dev`。
 * 仅取最后一段并转小写，不处理目录部分。
 *
 * @param path 原始路径或归一化路径均可
 * @returns 文件名小写，空输入返回空字符串
 */
export function getFileNameLower(path: string): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  const lastSeg = normalized.split('/').filter((seg) => seg.length > 0).pop();
  return lastSeg ? lastSeg.toLowerCase() : '';
}
