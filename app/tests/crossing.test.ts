import { describe, expect, it } from 'vitest';
import { classifyCrossing, parseLineFam, buildPowerlineProject, LineParserTextCache } from '@gim/powerline-core';
const fields = (text: string, source = 'Cbm/cross.fam') => parseLineFam(text).map(a => ({ key: a.prop_key, label: a.display_key, value: a.prop_value, source }));
describe('CROSS own FAM key families', () => {
  it.each([
    ['powerline', '电压等级=VOLTAGE=\n名称=NAME=110kV线路'],
    ['building', '房屋高度=HIGH=\n屋顶类型=ROOFTYPE='],
    ['tree', '树高=HIGH=\n树木种类=TREETYPE='],
    ['road', '公路等级=GRADE=\n车道数=='],
    ['railway', '铁路等级=铁路等级=一级\n接触网高=接触网高=\n路基宽=WIDE=10'],
    ['river', '是否通航=BOART=\n水位高=WATERLEVEL='],
    ['underground-communication-cable', '等级=GRADE=\n权属=OWNERSHIP='],
  ])('identifies %s by keys including empty values', (kind, text) => {
    const result = classifyCrossing(fields(text));
    expect(result.kind).toBe(kind); expect(result.status).toBe('identified'); expect(result.evidence.length).toBeGreaterThan(0);
  });
  it('retains empty contact-network height and exact source keys as railway evidence', () => {
    const result = classifyCrossing(fields('铁路名称=NAME=示例铁路\n铁路等级=铁路等级=一级\n接触网高=接触网高=\n路基高=HIGH=10\n路基宽=WIDE=10\n权属=OWNERSHIP=示例单位'));
    expect(result.name).toBe('示例铁路');
    expect(result.details.find(a => a.label === '接触网高')).toEqual({ label: '接触网高', key: '接触网高', value: '', source: 'Cbm/cross.fam' });
  });
  it('retains conflicts instead of applying a first-match priority', () => {
    const result = classifyCrossing(fields('屋顶类型=ROOFTYPE=\n接触网高=接触网高='));
    expect(result.status).toBe('conflict'); expect(result.kind).toBe('unknown'); expect(result.matchedKinds).toEqual(['building','railway']);
  });
  it('does not classify from generic keys, attribute values or CODE', () => {
    for (const text of ['名称=NAME=铁路\n高度=HIGH=10\n宽度=WIDE=5\nCODE=201', 'GRADE=1\nOWNERSHIP=x', '公路等级=GRADE=一级\n权属=OWNERSHIP=x\nNAME=路']) {
      const result = classifyCrossing(fields(text));
      expect(result.kind).toBe(text.startsWith('公路等级') ? 'road' : 'unknown');
    }
  });
  it('keeps incomplete two-key signatures from different FAM files separate', () => {
    expect(classifyCrossing([...fields('等级=GRADE=','Cbm/a.fam'),...fields('权属=OWNERSHIP=','Cbm/b.fam')]).status).toBe('unknown');
  });
  it('annotates voltage explicitly taken from a name while keeping the empty source value', () => {
    const result = classifyCrossing(fields('名称=NAME=380V线路\n电压等级=VOLTAGE='));
    expect(result.details).toContainEqual({ label: '电压（名称）', key: 'NAME', value: '380V', source: 'Cbm/cross.fam' });
    expect(result.details.find(a => a.label === '电压等级')?.value).toBe('');
  });
  it('uses source FAM type instead of generic DEV and MOD values in business projection', () => {
    const project = buildPowerlineProject([
      {path:'Cbm/project.cbm',text:'SUBSYSTEM=x.cbm'},
      {path:'Cbm/x.cbm',text:'ENTITYNAME=CROSS\nBASEFAMILY=x.fam\nOBJECTMODELPOINTER=x.dev\nCODE=201\nBLHA=30,110,10'},
      {path:'Cbm/x.fam',text:'铁路等级=铁路等级=一级\n接触网高=接触网高='},
      {path:'Dev/x.dev',text:'DEVICETYPE=CROSS\nSYMBOLNAME=EQUIPMENT\nBASEFAMILY=x.fam'},
      {path:'Dev/x.fam',text:'房屋种类=HOUSETYPE=辅助模板'},
    ],{id:'test',name:'test',sha256:'abc',size:1});
    const crossing=project.objects.find(o=>o.kind==='cross')!;
    expect(crossing.type).toBe('铁路'); expect(crossing.businessCode).toBe('201');
    expect(crossing.crossing?.kind).toBe('railway');
    expect(crossing.crossing?.evidence.every(a=>a.source==='Cbm/x.fam')).toBe(true);
    expect(JSON.parse(JSON.stringify(project)).objects.find((o: {kind:string})=>o.kind==='cross').crossing).toEqual(crossing.crossing);
  });
  it('resolves a bare FAM relative to its source while preserving unscoped ambiguity', () => {
    const cache=new LineParserTextCache([{path:'Cbm/SHARED.fam',text:'rail'},{path:'Dev/shared.fam',text:'device'}]);
    expect(cache.resolveOriginalPath('shared.fam','cbm/cross.cbm')).toBe('Cbm/SHARED.fam');
    expect(cache.resolveOriginalPath('shared.fam','DEV/device.dev')).toBe('Dev/shared.fam');
    expect(cache.resolveOriginalPath('shared.fam')).toBeNull();
  });
});
