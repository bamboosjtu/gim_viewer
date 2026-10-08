import { it, expect } from 'vitest';
import { buildPowerlineProject, coordinateFromBlha, LineParserTextCache } from '@gim/powerline-core';
import type { LineParserTextFile } from '@gim/powerline-core';
const identity = { id: 'test', name: 'test', sha256: 'abc', size: 10 };
function corpus(): LineParserTextFile[] {
  return [
    { path: 'Cbm/project.cbm', text: 'SUBSYSTEM=line.cbm' },
    { path: 'Cbm/line.cbm', text: 'ENTITYNAME=F2System\nSTRAINSECTIONS.NUM=2\nSTRAINSECTION0=s1.cbm\nSTRAINSECTION1=s2.cbm' },
    { path: 'Cbm/s1.cbm', text: 'ENTITYNAME=F3System\nGROUPS.NUM=5\nGROUP0=a.cbm\nGROUP1=b.cbm\nGROUP2=w1.cbm\nGROUP3=w2.cbm\nGROUP4=j.cbm' },
    { path: 'Cbm/s2.cbm', text: 'ENTITYNAME=F3System\nGROUPS.NUM=2\nGROUP0=a.cbm\nGROUP1=empty.cbm' },
    { path: 'Cbm/a.cbm', text: 'ENTITYNAME=F4System\nGROUPTYPE=TOWER\nBLHA=30,110,10,0\nSTRINGS.NUM=1\nSTRING0.STRING=sa.cbm' },
    { path: 'Cbm/b.cbm', text: 'ENTITYNAME=F4System\nGROUPTYPE=TOWER\nBLHA=30.001,110.001,12,0\nSTRINGS.NUM=1\nSTRING0.STRING=sb.cbm' },
    { path: 'Cbm/sa.cbm', text: 'ENTITYNAME=STRING' }, { path: 'Cbm/sb.cbm', text: 'ENTITYNAME=STRING' },
    { path: 'Cbm/w1.cbm', text: 'ENTITYNAME=WIRE\nBACKSTRING=sa.cbm\nFRONTSTRING=sb.cbm\nPOINT0.BLHA=30,110,10,0\nPOINT1.BLHA=30.001,110.001,12,0' },
    { path: 'Cbm/w2.cbm', text: 'ENTITYNAME=WIRE\nBACKSTRING=sa.cbm\nFRONTSTRING=sb.cbm\nPOINT0.BLHA=30.00001,110.00001,14,0\nPOINT1.BLHA=30.00101,110.00101,15,0' },
    { path: 'Cbm/j.cbm', text: 'ENTITYNAME=WIRE\nISJUMPER=1\nBACKSTRING=sa.cbm\nFRONTSTRING=sa.cbm' },
    { path: 'Cbm/empty.cbm', text: 'ENTITYNAME=F4System\nGROUPTYPE=CROSS' },
  ];
}
it('merges phase hang points by explicit tower identity, excludes jumpers and retains shared boundary occurrences', () => {
  const p = buildPowerlineProject(corpus(), identity);
  expect(p.counts.tower).toBe(2); expect(p.counts.span).toBe(1); expect(p.counts.cross).toBe(0);
  expect(p.objects.find(o => o.kind === 'span')?.rawWireIds).toHaveLength(2);
  expect(p.objects.find(o => o.sourcePath === 'Cbm/a.cbm')?.strainIds).toHaveLength(2);
  expect(p.findings.find(f => f.code === 'empty-cross-group')).toBeDefined();
});
it('does not invent geographic positions from malformed BLHA', () => { expect(coordinateFromBlha('x,110')).toBeUndefined(); expect(coordinateFromBlha('91,110')).toBeUndefined(); expect(coordinateFromBlha(',,0')).toBeUndefined(); expect(coordinateFromBlha('28,,0')).toBeUndefined(); });
it('retains ambiguity instead of guessing a basename match', () => { const c = new LineParserTextCache([{path:'A/shared.fam',text:'a'},{path:'B/shared.fam',text:'b'}]); expect(c.getText('shared.fam')).toBeNull(); expect(c.getText('a\\SHARED.FAM')).toBe('a'); });
it('retains assembly sources without flattening child hardware properties onto a tower', () => {
  const files = corpus(); files.find(f => f.path === 'Cbm/a.cbm')!.text += '\nTOWERS.NUM=1\nTOWER0=device.cbm';
  files.push({path:'Cbm/device.cbm',text:'ENTITYNAME=TOWER_DEVICE\nOBJECTMODELPOINTER=tower.dev'},
    {path:'Dev/tower.dev',text:'BASEFAMILY=tower.fam\nSOLIDMODEL0=assembly.phm'},
    {path:'Dev/tower.fam',text:'TYPE=tower-own-type'},
    {path:'Phm/assembly.phm',text:'SOLIDMODEL0=bolt.dev\nTRANSFORMMATRIX0=matrix'},
    {path:'Dev/bolt.dev',text:'BASEFAMILY=bolt.fam'},
    {path:'Dev/bolt.fam',text:'TYPE=bolt-child-type\nWEIGHT=3'});
  const tower = buildPowerlineProject(files,identity).objects.find(o => o.sourcePath === 'Cbm/a.cbm')!;
  expect(tower.type).toBe('tower-own-type');
  expect(tower.attributes.some(a => a.value === 'bolt-child-type' || a.key === 'TRANSFORMMATRIX0')).toBe(false);
  expect(tower.sourceRefs).toContain('Dev/bolt.fam');
});
