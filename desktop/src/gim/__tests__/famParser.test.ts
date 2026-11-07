import { describe, expect, it } from 'vitest';
import { parseFamSections, parseFamSectionsWithDiagnostics } from '../famParser.js';

describe('parseFamSections vendor-neutral contract', () => {
  it('keeps the first non-empty key candidate and the final segment as value', () => {
    const sections = parseFamSections(
      '\uFEFF[设计参数]\n中文名=英文键=110kV\n中文名=中文名=设备\n=工程系统=出线间隔01\n',
    );
    expect(sections.get('设计参数')).toEqual(new Map([
      ['中文名', '设备'],
      ['工程系统', '出线间隔01'],
    ]));
  });

  it('accepts arbitrary section names and does not create an empty key', () => {
    const result = parseFamSectionsWithDiagnostics(
      '[构力自定义属性]\n==value\n=\n只有一段\nA=B=C\n',
    );
    expect(result.sections.has('构力自定义属性')).toBe(true);
    expect(result.sections.get('构力自定义属性')).toEqual(new Map([['A', 'C']]));
    expect(result.diagnostics.malformedLineCount).toBe(3);
  });
});

import {parseLineFam} from '../../../../packages/powerline-core/src/lineFamParser.js';
it('keeps physical FAM segments while applying the documented domain projections',()=>{
 const source='[Custom]\nA=B=C\nFormula=Internal=A=B';
 const station=parseFamSectionsWithDiagnostics(source,'source.fam');
 expect(station.sections.get('Custom')).toEqual(new Map([['A','C'],['Formula','B']]));
 expect(station.properties.map(row=>({line:row.sourceLine,segments:row.segments,raw:row.rawLine}))).toEqual([
  {line:2,segments:['A','B','C'],raw:'A=B=C'},
  {line:3,segments:['Formula','Internal','A','B'],raw:'Formula=Internal=A=B'},
 ]);
 expect(parseLineFam(source).map(row=>[row.display_key,row.prop_key,row.prop_value])).toEqual([[null,'[Custom]',null],['A','B','C'],['Formula','Internal','A=B']]);
});
