// @vitest-environment node
import { expect, it } from 'vitest';
import { buildEarlyConnectionInput, omitIndexedOpenings } from '../ifcConnectionSubset.js';
import { omitIfcOpeningRelations } from '../../viewer/ifcOpeningPolicy.js';

const encode = (records: string) => new TextEncoder().encode(`ISO-10303-21;HEADER;FILE_SCHEMA(('IFC2X3'));ENDSEC;DATA;\n${records}\nENDSEC;END-ISO-10303-21;`);
const accepts = (type: string, name: string) => type === 'IFCBUILDINGELEMENTPROXY' && /导线/.test(name);
const build = (input: Uint8Array) => buildEarlyConnectionInput(input, new Set(), accepts, 0);
const core = `#1=IFCPROJECT('p',#2,'Project',$,$,$,$,(#3),#4);
#2=IFCOWNERHISTORY($,$,$,$,$,$,$,0);#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,$,3,1.E-5,$,$);
#4=IFCUNITASSIGNMENT((#5));#5=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#20=IFCBUILDINGELEMENTPROXY('g',#2,'\\X2\\5BFC7EBF\\X0\\',$,$,#21,#22,$,$);
#21=IFCLOCALPLACEMENT($,#23);#22=IFCPRODUCTDEFINITIONSHAPE($,$,(#24));
#23=IFCAXIS2PLACEMENT3D(#25,$,$);#24=IFCSHAPEREPRESENTATION(#3,'Body','Brep',(#26));
#25=IFCCARTESIANPOINT((10.,20.,30.));#26=IFCFACETEDBREP(#27);#27=IFCCLOSEDSHELL(());
#30=IFCSTYLEDITEM(#26,(#31),$);#31=IFCPRESENTATIONSTYLEASSIGNMENT((#32));
#32=IFCSURFACESTYLE('color',.BOTH.,(#33));#33=IFCSURFACESTYLERENDERING(#34,0.,$,$,$,$,$,$,.NOTDEFINED.);
#34=IFCCOLOURRGB($,0.2,0.3,0.4);`;

it('retains exact numeric/unit/placement tokens and reverse appearance, without unrelated products', () => {
  const bytes = encode(core + "#99=IFCWALL('unrelated',#2,$,$,$,$,$,$);");
  const original = bytes.slice(), result = build(bytes)!;
  expect(result.expressId).toBe(20);
  const text = new TextDecoder().decode(result.bytes);
  expect(text).toContain('#5=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);');
  expect(text).toContain('#25=IFCCARTESIANPOINT((10.,20.,30.));');
  expect(text).toContain('#34=IFCCOLOURRGB($,0.2,0.3,0.4);');
  expect(text).not.toContain('#99='); expect(bytes).toEqual(original);
  expect(buildEarlyConnectionInput(bytes, new Set(), accepts)).toBeNull();
});
it('ignores fake records/references and delimiters in strings/comments, supports unsorted records and escaped names', () => {
  const tricky = "/* #20=IFCBUILDINGELEMENTPROXY('bad'); */\n"
    + core.replace("'Project'", "'Project; #123 = IFCWALL(''quoted''); /* text */'")
    + "#100=IFCPROPERTYSINGLEVALUE('outside; #999',$,IFCLABEL('x'),$);";
  const result = build(encode(tricky))!;
  expect(result.expressId).toBe(20);
  expect(new TextDecoder().decode(result.bytes)).toContain("'Project; #123 = IFCWALL(''quoted''); /* text */'");
  expect(new TextDecoder().decode(result.bytes)).not.toContain('#100=');
});
it('indexes real opening endpoints and applies exactly the existing derived omission policy', () => {
  const bytes = encode(core + "#101=IFCRELVOIDSELEMENT('r;#888',#2,/* #777 */$,$,#20,#99);#99=IFCOPENINGELEMENT('o',#2,$,$,$,$,$,$);"), old = bytes.slice();
  const result = build(bytes)!;
  expect(result.openings).toHaveLength(1);
  expect(result.openings[0]).toMatchObject({id:101, host:20, opening:99});
  omitIndexedOpenings(bytes, result.openings); omitIfcOpeningRelations(old);
  expect(bytes).toEqual(old);
});
it.each([
  core + '#20=IFCWALL($);',
  core.replace('#25=IFCCARTESIANPOINT((10.,20.,30.));',''),
  core + "#201=IFCPROJECT('p2',#2,$,$,$,$,$,(),#4);",
  core + '#123=IFCPROPERTYSINGLEVALUE(',
])('rejects unsupported/incomplete dependency graphs rather than fabricating geometry', records => {
  expect(() => build(encode(records))).toThrow();
});
it('bounds sparse-ID index allocation and selected byte closure', () => {
  const sparse = core + Array.from({length:129}, (_, i) => `#${(i+1)*65536}=IFCCARTESIANPOINT((0.,0.,0.));`).join('');
  expect(() => build(encode(sparse))).toThrow('64 MiB');
  const large = core.replace('#27=IFCCLOSEDSHELL(());', `#27=IFCCLOSEDSHELL((/*${'x'.repeat(8*1024*1024)}*/));`);
  expect(() => build(encode(large))).toThrow('closure exceeds budget');
});
it('does not treat a filename, comment or distant record as a cheap positive probe', () => {
  expect(build(encode(core.replace('5BFC7EBF','666E901A')))).toBeNull();
  const distant = encode('#2=IFCOWNERHISTORY($,$,$,$,$,$,$,0);/*'+'x'.repeat(4*1024*1024)+'*/'+core.replace('#2=IFCOWNERHISTORY($,$,$,$,$,$,$,0);',''));
  expect(build(distant)).toBeNull();
});
