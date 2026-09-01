import { describe, expect, it } from 'vitest';
import { parseLineFam } from '../lineFamParser.js';

describe('线路 FAM 缺失英文键兼容', () => {
  it('为中文展示键==值生成稳定保底 prop_key，并保留原始行', () => {
    const [record] = parseLineFam('部件生产厂家==国网金具库, 南京金具库\n');
    expect(record).toMatchObject({
      display_key: '部件生产厂家',
      prop_key: '__display__部件生产厂家',
      prop_value: '国网金具库, 南京金具库',
      raw_line: '部件生产厂家==国网金具库, 南京金具库',
    });
  });

  it('无键异常行也不产生空 prop_key', () => {
    const records = parseLineFam('=value\n=\n');
    expect(records.map((record) => record.prop_key)).toEqual([
      '__line_fam_1',
      '__line_fam_2',
    ]);
  });
});
