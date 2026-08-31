import { describe, expect, it } from 'vitest';
import { AppState } from '../../app/state.js';
import { commitStdSldResult, findMissingStdSldCacheParts, type StdSldParseResult } from '../stdSldService.js';

function result(overrides: Partial<StdSldParseResult> = {}): StdSldParseResult {
  return {
    schEntries: [
      { index: 0, filename: 'zjx.std', path: 'CBM/zjx.std', type: 'std', name: 'zjx' },
      { index: 1, filename: 'zjx.sld', path: 'CBM/zjx.sld', type: 'sld', name: 'zjx' },
    ],
    stdDoc: { substation: {} } as StdSldParseResult['stdDoc'],
    sldDoc: {
      safeSvgOuterHTML: '<svg/>',
      groups: [{}],
    } as StdSldParseResult['sldDoc'],
    index: {} as StdSldParseResult['index'],
    ...overrides,
  };
}

describe('findMissingStdSldCacheParts', () => {
  const entries = ['CBM/project.sch', 'CBM/zjx.std', 'CBM/zjx.sld'];

  it('完整恢复 SCH/STD/SLD 时不报缺失', () => {
    expect(findMissingStdSldCacheParts(entries, result())).toEqual([]);
  });

  it('旧缓存完全没有电气图文件时要求回退完整解压', () => {
    expect(findMissingStdSldCacheParts(entries, null)).toEqual(['SCH', 'STD', 'SLD']);
  });

  it('只恢复 STD 但缺少 SLD 时识别 SLD 缺失', () => {
    expect(findMissingStdSldCacheParts(entries, result({ sldDoc: null }))).toEqual(['SLD']);
  });

  it('工程索引不声明电气图文件时保持兼容', () => {
    expect(findMissingStdSldCacheParts(['CBM/project.cbm', 'DEV/model.ifc'], null)).toEqual([]);
  });

  it('路径匹配不区分大小写并兼容反斜杠', () => {
    expect(findMissingStdSldCacheParts(['Cbm\\project.sch', 'cbm\\zjx.std', 'cbm\\zjx.sld'], null))
      .toEqual(['SCH', 'STD', 'SLD']);
  });
});

describe('commitStdSldResult', () => {
  it('只做同步提交，null 结果会清空三项文档状态', () => {
    const state = new AppState();
    const parsed = result();

    commitStdSldResult(state, parsed);
    expect(state.currentStdDoc).toBe(parsed.stdDoc);
    expect(state.currentSldDoc).toBe(parsed.sldDoc);
    expect(state.currentStdSldIndex).toBe(parsed.index);

    commitStdSldResult(state, null);
    expect(state.currentStdDoc).toBeNull();
    expect(state.currentSldDoc).toBeNull();
    expect(state.currentStdSldIndex).toBeNull();
  });
});
