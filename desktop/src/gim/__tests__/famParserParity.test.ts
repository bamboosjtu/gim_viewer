import { expect, it } from 'vitest';
import { parseFamSectionsWithDiagnostics } from '../famParser.js';
import {parseLineFam} from '@gim/powerline-core/lineFamParser.js';
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
