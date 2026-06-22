/**
 * shared/csv 工具单测（dev-log「无导出」项）。
 */

import { describe, expect, it } from 'vitest';
import { buildCsv } from '../csv.js';

describe('buildCsv', () => {
  it('普通行以逗号拼接、CRLF 分行', () => {
    const csv = buildCsv([['a', 'b'], ['1', '2']]);
    expect(csv).toBe('\uFEFFa,b\r\n1,2');
  });

  it('含逗号/引号/换行的单元格被双引号包裹并转义', () => {
    const csv = buildCsv([['plain', 'with,comma', 'with"quote', 'line\nbreak']]);
    expect(csv).toBe('\uFEFFplain,"with,comma","with""quote","line\nbreak"');
  });

  it('带 UTF-8 BOM 前缀', () => {
    expect(buildCsv([['x']]).charCodeAt(0)).toBe(0xfeff);
  });
});
