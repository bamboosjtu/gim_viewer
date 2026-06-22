import { describe, expect, it } from 'vitest';
import { parseSch, discoverStdSldFromSCH } from '../schParser.js';

function textFile(text: string, name: string): File {
  return new File([text], name, { type: 'text/plain' });
}

describe('parseSch', () => {
  it('解析 demo-substation 标准格式（2 条目：STD + SLD）', () => {
    const text = `SCH.NUM=2
SCH0=zjx.std
SCH1=zjx.sld`;
    const entries = parseSch(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      index: 0,
      filename: 'zjx.std',
      path: 'CBM/zjx.std',
      type: 'std',
      name: 'zjx',
    });
    expect(entries[1]).toEqual({
      index: 1,
      filename: 'zjx.sld',
      path: 'CBM/zjx.sld',
      type: 'sld',
      name: 'zjx',
    });
  });

  it('单条目 SCH（仅 STD）', () => {
    const entries = parseSch('SCH.NUM=1\nSCH0=topo.std');
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('std');
    expect(entries[0].filename).toBe('topo.std');
  });

  it('SCH.NUM=0 返回空数组', () => {
    expect(parseSch('SCH.NUM=0')).toEqual([]);
  });

  it('SCH.NUM 缺失返回空数组', () => {
    expect(parseSch('OTHERKEY=val')).toEqual([]);
  });

  it('SCH.NUM 非数字返回空数组', () => {
    expect(parseSch('SCH.NUM=abc')).toEqual([]);
  });

  it('SCHi 条目数与 SCH.NUM 不一致时按实际存在的返回', () => {
    // NUM=3 但只有 2 个 SCHi，应只返回 2 个
    const entries = parseSch('SCH.NUM=3\nSCH0=a.std\nSCH1=b.sld');
    expect(entries).toHaveLength(2);
    expect(entries[0].filename).toBe('a.std');
    expect(entries[1].filename).toBe('b.sld');
  });

  it('未知后缀标记为 unknown', () => {
    const entries = parseSch('SCH.NUM=1\nSCH0=file.xyz');
    expect(entries[0].type).toBe('unknown');
  });

  it('空文本返回空数组', () => {
    expect(parseSch('')).toEqual([]);
  });

  it('文件名两端空白被 trim', () => {
    const entries = parseSch('SCH.NUM=1\nSCH0=  spaced.std  ');
    expect(entries[0].filename).toBe('spaced.std');
    expect(entries[0].path).toBe('CBM/spaced.std');
  });

  it('name 字段正确去除后缀', () => {
    const entries = parseSch('SCH.NUM=2\nSCH0=topo.std\nSCH1=diagram.sld');
    expect(entries[0].name).toBe('topo');
    expect(entries[1].name).toBe('diagram');
  });
});

describe('discoverStdSldFromSCH', () => {
  it('从 GIM 文件集合发现 SCH 条目', async () => {
    const files = new Map<string, File>([
      ['CBM/project.sch', textFile('SCH.NUM=2\nSCH0=zjx.std\nSCH1=zjx.sld', 'project.sch')],
      ['CBM/zjx.std', textFile('<STD/>', 'zjx.std')],
      ['CBM/zjx.sld', textFile('<svg/>', 'zjx.sld')],
    ]);
    const entries = await discoverStdSldFromSCH(files);
    expect(entries).toHaveLength(2);
    expect(entries[0].path).toBe('CBM/zjx.std');
    expect(entries[1].path).toBe('CBM/zjx.sld');
  });

  it('无 CBM/project.sch 返回空数组', async () => {
    const files = new Map<string, File>([
      ['CBM/other.sch', textFile('SCH.NUM=1\nSCH0=a.std', 'other.sch')],
    ]);
    expect(await discoverStdSldFromSCH(files)).toEqual([]);
  });

  it('空文件集合返回空数组', async () => {
    expect(await discoverStdSldFromSCH(new Map())).toEqual([]);
  });
});
