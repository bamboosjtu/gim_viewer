import { describe, it, expect } from 'vitest';
import { parseProjectHeader } from '../src/core/header';

function fixture() {
  const bytes = new Uint8Array(784); const put = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  put(0,'GIMPKGT'); put(16,'示例工程.gim'); put(272,'示例设计单位'); put(336,'原始单位'); put(592,'示例导出工具'); put(720,'2026-07-16 15:04'); put(752,'QGDW2'); put(760,'2023');
  return bytes;
}
describe('source header evidence', () => {
  it('decodes UTF-8 and separates design, original unit and export software', () => {
    const header = parseProjectHeader(fixture()); expect(header.layout).toBe('在册分段头部布局');
    expect(header.fields.find(f => f.label === '设计单位')).toMatchObject({value:'示例设计单位', offset:272, encoding:'UTF-8'});
    expect(header.fields.find(f => f.label === '单位（头部原值）')?.value).toBe('原始单位');
    expect(header.fields.find(f => f.label === '导出软件')?.value).toBe('示例导出工具');
    expect(header.fields.some(f => /厂商|业主/.test(f.label))).toBe(false);
  });
  it('decodes a GBK field without changing its byte evidence', () => {
    const bytes = fixture(); bytes.fill(0,272,336); bytes.set([0xb2,0xe2,0xca,0xd4],272);
    expect(parseProjectHeader(bytes).fields.find(f => f.offset === 272)).toMatchObject({value:'测试', length:4, encoding:'GB18030'});
  });
  it('does not infer roles for unknown or conflicting layouts', () => {
    const bytes = fixture(); bytes[752] = 88;
    const header = parseProjectHeader(bytes); expect(header.layout).toContain('未识别');
    expect(header.fields.find(f => f.offset === 272)?.label).toBe('原始头部字段 @272');
    expect(header.fields.some(f => f.label === '设计单位')).toBe(false);
  });
  it('preserves absent fields and rejects wrong magic or oversized input', () => {
    const bytes = fixture(); bytes.fill(0,272,592);
    expect(parseProjectHeader(bytes).fields.some(f => f.offset === 272 || f.offset === 336)).toBe(false);
    expect(() => parseProjectHeader(new Uint8Array(9))).toThrow('不是线路');
    expect(() => parseProjectHeader(new Uint8Array(1024*1024+8))).toThrow('限额');
  });
});
