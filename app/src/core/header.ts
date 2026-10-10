export interface HeaderField { label: string; value: string; offset: number; length: number; encoding: string }
export interface ProjectHeader { magic: string; layout: string; fields: HeaderField[] }
function text(bytes: Uint8Array): { value: string; encoding: string } {
  try { return { value: new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(), encoding: 'UTF-8' }; }
  catch { try { return { value: new TextDecoder('gb18030', { fatal: true }).decode(bytes).trim(), encoding: 'GB18030' }; } catch { return { value: '', encoding: '未识别' }; } }
}
/** Layout recognition describes observed bytes, never an exporter/vendor branch. */
export function parseProjectHeader(input: number[] | Uint8Array): ProjectHeader {
  const bytes = new Uint8Array(input);
  if (bytes.length > 1024 * 1024 + 7) throw new Error('头部超过读取限额');
  const magic = new TextDecoder().decode(bytes.subarray(0, 7));
  if (magic !== 'GIMPKGT') throw new Error('不是线路 GIM 头部');
  const slot = (start: number, end: number) => {
    const part = bytes.subarray(start, end), zero = part.indexOf(0);
    // Require NUL termination and padding to avoid labelling unrelated header bytes.
    if (zero < 0) return start === 720 && end === 736 ? { ...text(part), offset: start, length: part.length } : undefined;
    if (part.subarray(zero).some(v => v !== 0)) return undefined;
    return { ...text(part.subarray(0, zero)), offset: start, length: zero };
  };
  const slots = [[16,272,'工程名称'],[272,336,'设计单位'],[336,592,'单位（头部原值）'],[592,720,'导出软件'],[720,736,'导出时间'],[752,760,'标准标识'],[760,768,'标准版本']] as const;
  const values = slots.map(([a,b,label]) => ({ label, ...slot(a,b) }));
  const known = bytes.length === 784 && bytes.subarray(7,16).every(v => v === 0)
    && values.every(v => v.offset !== undefined) && values[5].value === 'QGDW2'
    && /^\d{4}$/.test(values[6].value ?? '') && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(values[4].value ?? '');
  if (known) return { magic, layout: '在册分段头部布局', fields: values.filter(v => v.value).map(v => v as HeaderField) };
  // Unknown layouts retain printable NUL-delimited evidence without inventing roles.
  const fields: HeaderField[] = []; let start = 7;
  while (start < bytes.length) {
    if (bytes[start] === 0) { start++; continue; }
    let end = start; while (end < bytes.length && bytes[end] !== 0) end++;
    const decoded = text(bytes.subarray(start, end));
    if (decoded.value && !/[\u0000-\u001f\u007f]/.test(decoded.value)) fields.push({ label: `原始头部字段 @${start}`, ...decoded, offset: start, length: end-start });
    start = end+1;
  }
  return { magic, layout: '未识别布局，保留原值', fields };
}
