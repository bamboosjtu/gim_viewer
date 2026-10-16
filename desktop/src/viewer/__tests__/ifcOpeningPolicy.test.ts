import { expect, it } from 'vitest';
import { IfcOpeningRelationEditor, omitIfcOpeningRelations } from '../ifcOpeningPolicy.js';

it('removes only complete opening relations outside STEP strings/comments and preserves IDs/offsets', () => {
  const text = "ISO-10303-21;DATA;\n#1=IFCPLATE('a;#9=IFCRELVOIDSELEMENT(x);', 'it''s');\n/* #8=IFCRELVOIDSELEMENT(x); */\n#2 = IFCRELVOIDSELEMENT(\n'x',#3,$,$,#1,#4);\n#3=IFCRELDEFINESBYPROPERTIES('x');\n#4=IFCOPENINGELEMENT('o');ENDSEC;END-ISO-10303-21;";
  const bytes = new TextEncoder().encode(text), original = bytes.slice();
  const relations:Array<{id:number;host:number;opening:number}>=[];
  expect(omitIfcOpeningRelations(bytes,()=>false,row=>relations.push(row))).toBe(1);
  expect(relations).toEqual([{id:2,host:1,opening:4}]);
  const result = new TextDecoder().decode(bytes);
  expect(bytes.byteLength).toBe(original.byteLength);
  expect(result.indexOf('#3=')).toBe(text.indexOf('#3='));
  expect(result).toContain("#1=IFCPLATE('a;#9=IFCRELVOIDSELEMENT(x);', 'it''s')");
  expect(result).toContain('/* #8=IFCRELVOIDSELEMENT(x); */');
  expect(result).toContain("#4=IFCOPENINGELEMENT('o')");
  expect(result).not.toContain('#2 =');
  expect(omitIfcOpeningRelations(bytes)).toBe(0);
});

it('incremental opening edits match repeated full scans without touching strings, comments or other records', () => {
  const source = new TextEncoder().encode("DATA;\r\n#1=IFCPLATE('keep;#90=IFCRELVOIDSELEMENT(x);');\r\n/* #91=IFCRELVOIDSELEMENT(x); */\r\n#2=IFCRELVOIDSELEMENT('a',#7,$,$,#1,#10);\r\n#3 = ifcrelvoidselement(\r\n'b',#7,$,$,#1,#11);\r\n#4=IFCOPENINGELEMENT('kept');ENDSEC;");
  const indexed = source.slice(), scanned = source.slice();
  const editor = new IfcOpeningRelationEditor(indexed), removed = new Set<number>();
  for (const ids of [[2], [2, 3, 999], [3]]) {
    const previous = removed.size;
    for (const id of ids) if (id === 2 || id === 3) removed.add(id);
    expect(editor.omit(ids)).toBe(removed.size - previous);
    omitIfcOpeningRelations(scanned, id => !removed.has(id));
    expect(indexed).toEqual(scanned);
    expect(indexed.byteLength).toBe(source.byteLength);
  }
});
