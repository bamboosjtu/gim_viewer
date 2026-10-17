import { afterEach, describe, expect, it } from 'vitest';
import { AppState } from '../../app/state.js';
import {compareSubstationNames} from '../../gim/substationBusiness.js';
import type { CbmNode } from '../../gim/types.js';
import {
  buildFunctionalDomainIndex,
  buildFunctionalSearchIndex,
  renderSubstationFunctionalTree,
  revealFunctionalSearchTarget,
} from '../substationFunctionalTreeView.js';

function node(overrides: Partial<CbmNode> = {}): CbmNode {
  return {
    path: 'CBM/project.cbm',
    name: '工程',
    entityName: 'F1System',
    children: [],
    famPath: '',
    devPath: '',
    ifcFile: '',
    ifcGuid: '',
    classifyName: '',
    transformMatrix: '',
    systemNames: [],
    devSymbolName: '',
    devType: '',
    devExpanded: false,
    ...overrides,
  };
}

it('sorts transformer body and neutral equipment by transformer number before standby wording',()=>{
  expect(['2号备用主变本体系统','3号备用主变本体系统','1号主变本体系统','3号主变中性点设备','1号主变中性点设备','2号主变中性点设备'].sort(compareSubstationNames))
    .toEqual(['1号主变本体系统','1号主变中性点设备','2号备用主变本体系统','2号主变中性点设备','3号备用主变本体系统','3号主变中性点设备']);
});

it('child display hints do not promote raw classification codes to functional domains', () => {
  const root = node({ children: [node({ entityName:'F3System', path:'CBM/system.cbm',
    systemNames:[], classifyName:'0****001', name:'0****001（含部件A、部件B）', rawProperties:{} })] });
  expect(buildFunctionalDomainIndex(root).domains.map((domain) => domain.title)).toEqual(['未归类系统']);
});

describe('substation functional tree projection', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('按 F3 功能域分组，F2 只成为专业徽标，并把未分类系统收拢为一个域', () => {
    const duplicatePart = node({
      path: 'CBM/part-index.cbm',
      name: '柜内端子',
      entityName: 'PARTINDEX',
      devPath: 'part.dev',
    });
    const virtualPart = node({
      path: 'CBM/device.cbm#dev:0:part.dev',
      name: '柜内端子',
      entityName: 'DEV_SUBDEVICE',
      devPath: 'part.dev',
    });
    const electricalSystem = node({
      path: 'CBM/electrical-system.cbm',
      name: '电气系统 / 220kV系统 / 进线间隔',
      entityName: 'F3System',
      systemNames: ['电气系统', '220kV系统', '进线间隔'],
      children: [
        node({
          path: 'CBM/component.cbm',
          entityName: 'F4System',
          name: '断路器',
          ifcFile: 'model.ifc',
          ifcGuid: 'guid-1',
        }),
        node({
          path: 'CBM/device.cbm',
          entityName: 'F4System',
          name: '保护柜',
          devPath: 'cabinet.dev',
          children: [duplicatePart, virtualPart],
        }),
      ],
    });
    const buildingSystem = node({
      path: 'CBM/building-system.cbm',
      name: '建筑物系统 / 建筑',
      entityName: 'F3System',
      systemNames: ['建筑物系统', '建筑'],
      children: [],
    });
    const unclassifiedSystem = node({
      path: 'CBM/unclassified-system.cbm',
      name: '&其他',
      entityName: 'F3System',
      systemNames: [],
      classifyName: '建筑系统代码',
      children: [],
    });
    const root = node({
      children: [
        node({ entityName: 'F2System', classifyName: 'A', children: [electricalSystem] }),
        node({ entityName: 'F2System', classifyName: 'U', children: [buildingSystem] }),
        node({ entityName: 'F2System', classifyName: '02', children: [unclassifiedSystem] }),
      ],
    });

    const index = buildFunctionalDomainIndex(root);
    expect(index.domains.map((domain) => domain.title)).toEqual(['电气系统', '建筑物系统', '未归类系统']);
    expect(index.domains.find((domain) => domain.title === '电气系统')?.disciplineLabels).toEqual([]);
    expect(index.domains.find((domain) => domain.title === '未归类系统')?.systems).toHaveLength(1);

    const electrical = index.domains[0].systems[0];
    expect(electrical.assets.map((asset) => asset.role)).toEqual(['device', 'device']);
    expect(electrical.assets[1].parts).toHaveLength(1);
    expect(electrical.assets[1].parts[0].sourceNodes).toHaveLength(2);
    expect(index.targetByKey.get(virtualPart.path)?.rowKey).toBe(electrical.assets[1].parts[0].key);
  });

  it('默认只生成工程根和功能域，搜索命中时按祖先链惰性展开', () => {
    const f3 = node({
      path: 'CBM/system.cbm',
      name: '电气系统 / 10kV系统 / 间隔01',
      entityName: 'F3System',
      systemNames: ['电气系统', '10kV系统', '间隔01'],
      children: [
        node({
          path: 'CBM/device.cbm',
          entityName: 'F4System',
          name: '设备',
          devPath: 'device.dev',
          children: [node({ path: 'CBM/part.cbm', entityName: 'PARTINDEX', name: '部件', devPath: 'part.dev' })],
        }),
      ],
    });
    const root = node({ children: [node({ entityName: 'F2System', classifyName: 'A', children: [f3] })] });
    const state = new AppState();
    state.projectName = '测试变电工程';
    state.currentCbmTree = root;
    const index = buildFunctionalDomainIndex(root);
    const host = document.createElement('div');
    document.body.appendChild(host);
    let clicked: CbmNode | null = null;
    renderSubstationFunctionalTree(state, index, host, (selected) => { clicked = selected; });

    expect(host.querySelectorAll('.functional-tree-row')).toHaveLength(2);
    const initialBadges = Array.from(host.querySelectorAll<HTMLElement>('.functional-badge'))
      .map((element) => element.textContent || '');
    expect(initialBadges).toEqual(['1 个域', '1 个系统']);
    expect(host.textContent).not.toContain('F4 1');
    const searchItems = buildFunctionalSearchIndex(state, index);
    const partItem = searchItems.find((item) => item.title === '部件');
    expect(partItem).toBeDefined();
    const rowKey = revealFunctionalSearchTarget(index, partItem!.key);
    expect(rowKey).toBeTruthy();
    expect(host.querySelector(`[data-node-path="${rowKey}"]`)).not.toBeNull();
    // 展开祖先链只操作箭头，不触发祖先对象选择。
    expect(clicked).toBeNull();
    host.querySelector<HTMLElement>(`[data-node-path="${rowKey}"]`)!.click();
    expect(clicked).not.toBeNull();
    expect(clicked!.path).toBe('CBM/part.cbm');
  });
});

it('component labels override equipment words, nested independent units keep their own identity', () => {
  const actuator = node({path:'actuator',entityName:'PARTINDEX',name:'断路器操动机构',devPath:'actuator.dev'});
  const nested = node({path:'nested',entityName:'PARTINDEX',name:'汇控柜',devPath:'cabinet.dev'});
  const breaker = node({path:'breaker',entityName:'F4System',name:'断路器',children:[actuator,nested]});
  const root = node({children:[node({path:'system',entityName:'F3System',systemNames:['电气系统','220kV系统','进线间隔'],children:[breaker]})]});
  const assets = buildFunctionalDomainIndex(root).domains[0].systems[0].assets;
  expect(assets.map(row=>[row.node.path,row.role])).toEqual([['breaker','device'],['nested','device']]);
  expect(assets[0].parts.map(part=>part.node.path)).toEqual(['actuator']);
});

it('systems and voltage groups are independent of physical depth and retain repeated parts of the same DEV', () => {
  const parts=[node({path:'part-1',name:'散热器',entityName:'PARTINDEX',devPath:'shared.dev'}),node({path:'part-2',name:'散热器',entityName:'PARTINDEX',devPath:'shared.dev'})];
  const device=node({path:'main',name:'主变压器',entityName:'F2System',children:parts});
  const context=node({path:'context',entityName:'F4System',systemNames:['电气系统','220kV系统','主变间隔'],children:[device]});
  const index=buildFunctionalDomainIndex(node({children:[context]}));
  const system=index.domains[0].systems[0];
  expect(system.title).toBe('主变间隔');expect(system.groupPath).toEqual(['220kV系统']);
  expect(system.assets.map(row=>row.node.path)).toEqual(['main']);
  expect(system.assets[0].parts.map(row=>row.node.path)).toEqual(['part-1','part-2']);
  expect(index.targetByKey.get('part-1')!.rowKey).not.toBe(index.targetByKey.get('part-2')!.rowKey);
});
it('FAM corroboration retains source rows and marks conflicting classifications', () => {
  const source=node({path:'object',name:'对象',devPath:'object.dev',famPath:'Fam/object.fam'});
  const rows=[{sourcePath:'FAM/object.fam',sourceLine:2,section:'属性',rawKey:'NAME',label:'设备名称',rawValue:'断路器',rawLine:'设备名称=NAME=断路器'}];
  const root=node({children:[source]});const fam=new Map([['FAM/OBJECT.FAM',rows]]);
  const asset=buildFunctionalDomainIndex(root,fam).domains[0].systems[0].assets[0];
  expect(asset.role).toBe('device');expect(asset.classification.famEvidence[0]).toBe(rows[0]);
  const conflict=node({path:'conflict',name:'主变散热器',devPath:'part.dev',famPath:'Fam/object.fam'});
  const classified=buildFunctionalDomainIndex(node({children:[conflict]}),fam).domains[0].systems[0].assets[0];
  expect(classified.role).toBe('component');expect(classified.classification.conflict).toBe(true);
});

it('a device SYSTEMNAME labels the unit without creating another system group',()=>{
  const unit=node({path:'breaker',name:'断路器',systemNames:['断路器'],devPath:'breaker.dev'});
  const root=node({children:[node({path:'bay',name:'主变系统',systemNames:['电气系统','220kV系统','主变间隔'],children:[unit]})]});
  const index=buildFunctionalDomainIndex(root);const system=index.domains[0].systems[0];
  expect(index.domains).toHaveLength(1);expect(system.title).toBe('主变间隔');expect(system.assets.map(row=>row.node.path)).toEqual(['breaker']);
});

it('coalesces voltage prefixes, keeps alphanumeric bays, separates secondary systems and sorts numeric bay labels', () => {
  const bay = (label:string,path:string,unit='220kV系统') => node({path,name:label,systemNames:['交流电气系统',unit,label],
    children:[node({path:`${path}/breaker`,name:'断路器',devPath:`${path}.dev`})]});
  const root = node({children:[node({path:'voltage',name:'220kV系统',systemNames:['交流电气系统','220kV系统'],children:[
    bay('18断路器间隔','bay18'),bay('02断路器间隔','bay2'),bay('01断路器间隔','bay1'),bay('1EM PT','pt'),
    bay('公用测控系统','secondary','跨电压等级系统'),
  ]})]});
  const state = new AppState(); state.currentCbmTree=root;
  const index = buildFunctionalDomainIndex(root), host = document.createElement('div');document.body.appendChild(host);
  renderSubstationFunctionalTree(state,index,host,()=>{});
  host.querySelector<HTMLButtonElement>('.tree-children .tree-toggle[data-toggle-key]')!.click();
  const labelRows = (label:string) => [...host.querySelectorAll<HTMLElement>('.functional-tree-row')]
    .filter(row => row.querySelector('.tree-label')?.textContent === label);
  expect(labelRows('220kV系统')).toHaveLength(1);
  expect(labelRows('控制及直流/二次系统')).toHaveLength(1);
  labelRows('220kV系统')[0].querySelector<HTMLButtonElement>('.tree-toggle')!.click();
  const children = labelRows('220kV系统')[0].nextElementSibling!;
  expect([...children.children].map(el => el.querySelector('.tree-label')!.textContent))
    .toEqual(['1EM PT','01断路器间隔','02断路器间隔','18断路器间隔']);
  expect(children.textContent).not.toContain('公用测控系统');
  const target = revealFunctionalSearchTarget(index,'bay2/breaker');
  expect(host.querySelector(`[data-node-path="${target}"]`)).not.toBeNull();
  document.body.innerHTML='';
});

it('counts one independent unit for a unique part alias pair while preserving repeated occurrences', () => {
  const part = (path:string,entityName:string,devPath='switch.dev') => node({path,entityName,name:'隔离开关',devPath});
  const root = node({children:[node({path:'bay',systemNames:['电气系统','220kV系统','间隔'],children:[
    node({path:'owner',name:'组合设备',devPath:'owner.dev',children:[part('pi','PARTINDEX'),part('virtual','DEV_SUBDEVICE')]}),
    node({path:'other-owner',name:'组合设备',devPath:'other.dev',children:[part('repeat-1','PARTINDEX'),part('repeat-2','PARTINDEX')]}),
  ]})]});
  const index=buildFunctionalDomainIndex(root),assets=index.domains[0].systems.find(system=>system.title==='间隔')!.assets;
  expect(assets.filter(asset=>asset.role==='device').map(asset=>asset.node.path)).toEqual(['pi','repeat-1','repeat-2']);
  expect(index.targetByKey.get('virtual')!.rowKey).toBe('pi');
  expect(index.targetByKey.get('repeat-1')!.rowKey).not.toBe(index.targetByKey.get('repeat-2')!.rowKey);
});
