/** HTML 文本/属性值转义。调用方统一使用这一份实现，避免各 UI 视图自行复制。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 兼容既有调用方的短名称。 */
export const escHtml = escapeHtml;
