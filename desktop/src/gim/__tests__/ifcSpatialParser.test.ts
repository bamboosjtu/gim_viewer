import { describe, expect, it } from 'vitest';
import type { CbmNode, FileDevEntry, IfcEntry } from '../types.js';
import type {
  IfcSpatialParseProfile,
  IfcSpatialReadProfile,
  SubstationSpatialIndexObserver,
} from '../ifcSpatialParser.js';
import {
  buildSubstationSpatialIndexFromFiles,
  buildSubstationSpatialIndexFromTexts,
} from '../ifcSpatialParser.js';

const entry: IfcEntry = { modelId: 'model', name: 'model', path: 'DEV/model.ifc' };

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

describe('ifc spatial parser', () => {
  it('解析空间聚合、包含关系和 IFCGUID → CBM 链接', () => {
    const text = [
      "#1=IFCPROJECT('p',#99,'项目',$,$,$,$,(#90),$);",
      "#2=IFCSITE('s',#99,'站区',$,$,$,$,$,.ELEMENT.,$,$,0.,$,$);",
      "#3=IFCBUILDING('b',#99,'主建筑',$,$,$,$,$,.ELEMENT.,$,$);",
      "#4=IFCBUILDINGSTOREY('f',#99,'一层',$,$,$,$,$,.ELEMENT.,0.);",
      "#10=IFCWALL('wall-guid',#99,'墙体',$,$,$,$,$,$);",
      "#11=IFCWALL('orphan-guid',#99,'无空间容器构件',$,$,$,$,$,$);",
      "#12=IFCDISTRIBUTIONPORT('port-guid',#99,'端口',$,$,$,$,$);",
      "#13=IFCPROPERTYSINGLEVALUE('Manufacturer',$,IFCLABEL('Null'),$);",
      "#20=IFCRELAGGREGATES('r1',#99,$,$,#1,(#2));",
      "#21=IFCRELAGGREGATES('r2',#99,$,$,#2,(#3));",
      "#22=IFCRELAGGREGATES('r3',#99,$,$,#3,(#4));",
      "#23=IFCRELCONTAINEDINSPATIALSTRUCTURE('r4',#99,$,$,(#10),#4);",
    ].join('\n');
    const cbm = node({
      path: 'CBM/wall.cbm',
      entityName: 'F4System',
      ifcFile: 'model.ifc',
      ifcGuid: 'wall-guid',
      children: [],
    });
    const orphan = node({
      path: 'CBM/orphan.cbm',
      entityName: 'F4System',
      ifcFile: 'model.ifc',
      ifcGuid: 'orphan-guid',
      children: [],
    });
    const root = node({ children: [cbm, orphan] });
    const index = buildSubstationSpatialIndexFromTexts([{ entry, text }], root);

    expect(index.coverage.hasSpatialEntities).toBe(true);
    expect(index.coverage.hasSpatialContainment).toBe(true);
    expect(index.coverage.hasSpaces).toBe(false);
    expect(index.nodes.find((item) => item.kind === 'storey')?.objectKeys).toHaveLength(1);
    expect(index.coverage.directCbmIfcLinks).toBe(2);
    expect(index.coverage.spatiallyContainedCbmLinks).toBe(1);
    expect(index.coverage.confirmedWithoutSpatialContainer).toBe(1);
    expect(index.coverage.uncontainedIfcObjects).toBe(2);
    expect(index.objects.some((item) => item.globalId === 'port-guid')).toBe(true);
    expect(index.objects.some((item) => item.name === 'IFCPROPERTYSINGLEVALUE #13')).toBe(false);
    expect(index.models[0].resourceTypeCounts?.IFCPROPERTYSINGLEVALUE).toBe(1);
    expect(index.linksByCbmPath.get('CBM/orphan.cbm')?.unlocatedReason).toBe('no-spatial-container');
    expect(index.linksByCbmPath.get('CBM/wall.cbm')?.confidence).toBe('confirmed');
  });

  it('保留没有 IFCGUID 但有合法变换矩阵的设备为位置推断', () => {
    const root = node({
      children: [
        node({
          path: 'CBM/device.cbm',
          entityName: 'F4System',
          devPath: 'device.dev',
          transformMatrix: '1,0,0,0,0,1,0,0,0,0,1,0,10,20,30,1',
        }),
        node({
          path: 'CBM/origin.cbm',
          entityName: 'F4System',
          devPath: 'origin.dev',
          transformMatrix: '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1',
        }),
      ],
    });
    const index = buildSubstationSpatialIndexFromTexts([{ entry, text: '' }], root);
    const link = index.linksByCbmPath.get('CBM/device.cbm');
    expect(link?.confidence).toBe('inferred');
    expect(link?.position).toEqual([10, 20, 30]);
    expect(index.coverage.placementOnlyAssets).toBe(2);
    expect(index.coverage.positionedAssets).toBe(1);
    expect(index.coverage.identityPlacementAssets).toBe(1);
    expect(index.placementGroups).toHaveLength(1);
    expect(index.identityPlacementLinks).toHaveLength(1);
  });

  it('让无自身矩阵的 PARTINDEX 和 DEV_SUBDEVICE 继承几何加载使用的父级位置', () => {
    const parent = node({
      path: 'CBM/equipment.cbm',
      entityName: 'F4System',
      devPath: 'equipment.dev',
      transformMatrix: '1,0,0,0,0,1,0,0,0,0,1,0,100,200,300,1',
    });
    const part = node({
      path: 'CBM/part.cbm',
      entityName: 'PARTINDEX',
      devPath: 'part.dev',
      transformMatrix: '',
    });
    const virtualChild = node({
      path: 'CBM/equipment.cbm#dev:0:child.dev',
      entityName: 'DEV_SUBDEVICE',
      devPath: 'child.dev',
      transformMatrix: '1,0,0,0,0,1,0,0,0,0,1,0,10,20,30,1',
    });
    parent.children.push(part, virtualChild);
    const index = buildSubstationSpatialIndexFromTexts([{ entry, text: '' }], node({ children: [parent] }));

    expect(index.linksByCbmPath.get('CBM/part.cbm')).toMatchObject({
      confidence: 'inferred',
      position: [100, 200, 300],
      placementKind: 'translated',
    });
    expect(index.linksByCbmPath.get('CBM/equipment.cbm#dev:0:child.dev')).toMatchObject({
      confidence: 'inferred',
      position: [110, 220, 330],
      placementKind: 'translated',
    });
    expect(index.coverage.unlocatedAssets).toBe(0);
    expect(index.coverage.placementOnlyAssets).toBe(3);
  });

  it('按 IFC 标准顺序计算父级与子级平移', () => {
    const text = [
      "#10=IFCWALL('wall-translation',#99,'墙体',$,$,#40,$,$,$);",
      '#40=IFCLOCALPLACEMENT(#50,#60);',
      '#50=IFCLOCALPLACEMENT($,#51);',
      '#51=IFCAXIS2PLACEMENT3D(#52,$,$);',
      '#52=IFCCARTESIANPOINT((100.,200.,300.));',
      '#60=IFCAXIS2PLACEMENT3D(#61,$,$);',
      '#61=IFCCARTESIANPOINT((10.,20.,30.));',
    ].join('\n');
    const index = buildSubstationSpatialIndexFromTexts([{ entry, text }], node());
    expect(index.objects.find((item) => item.globalId === 'wall-translation')?.placement?.position)
      .toEqual([110, 220, 330]);
  });

  it('父级旋转会作用于子级平移（验证 Parent × Relative 顺序）', () => {
    const text = [
      "#10=IFCWALL('wall-rotation',#99,'旋转墙体',$,$,#40,$,$,$);",
      '#40=IFCLOCALPLACEMENT(#50,#60);',
      '#50=IFCLOCALPLACEMENT($,#51);',
      '#51=IFCAXIS2PLACEMENT3D(#52,#53,#54);',
      '#52=IFCCARTESIANPOINT((100.,200.,300.));',
      '#53=IFCDIRECTION((0.,0.,1.));',
      '#54=IFCDIRECTION((0.,1.,0.));',
      '#60=IFCAXIS2PLACEMENT3D(#61,$,$);',
      '#61=IFCCARTESIANPOINT((10.,0.,0.));',
    ].join('\n');
    const index = buildSubstationSpatialIndexFromTexts([{ entry, text }], node());
    expect(index.objects.find((item) => item.globalId === 'wall-rotation')?.placement?.position)
      .toEqual([100, 210, 300]);
  });

  it('保留 IFC 原生身份字段和属性集摘要，Name 为占位符时不再显示 --', () => {
    const text = [
      "#1=IFCPROJECT('p',#99,'项目',$,$,$,$,(#2),$);",
      "#2=IFCSITE('s',#99,'站区',$,$,$,$,$,.ELEMENT.,$,$,0.,$,$);",
      "#3=IFCBUILDING('b',#99,'建筑',$,$,$,$,$,.ELEMENT.,$,$);",
      "#4=IFCBUILDINGSTOREY('f',#99,'一层',$,$,$,$,$,.ELEMENT.,0.);",
      "#10=IFCBUILDINGELEMENTPROXY('wall-guid',#99,'--','墙体描述',$,#40,#41,'W-01',.ELEMENT.);",
      "#40=IFCLOCALPLACEMENT($,#42);",
      "#41=IFCPRODUCTDEFINITIONSHAPE($,$,());",
      "#42=IFCAXIS2PLACEMENT3D(#43,$,$);",
      "#43=IFCCARTESIANPOINT((1.,2.,3.));",
      "#50=IFCPROPERTYSET('ps',#99,'Pset_WallCommon',$,(#51));",
      "#51=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2h'),$);",
      "#52=IFCRELDEFINESBYPROPERTIES('r5',#99,$,$,(#10),#50);",
      "#20=IFCRELAGGREGATES('r1',#99,$,$,#1,(#2));",
      "#21=IFCRELAGGREGATES('r2',#99,$,$,#2,(#3));",
      "#22=IFCRELAGGREGATES('r3',#99,$,$,#3,(#4));",
      "#23=IFCRELCONTAINEDINSPATIALSTRUCTURE('r4',#99,$,$,(#10),#4);",
    ].join('\n');
    const index = buildSubstationSpatialIndexFromTexts([{ entry, text }], node());
    const object = index.objects.find((item) => item.globalId === 'wall-guid')!;
    expect(object.name).toBe('墙体描述');
    expect(object.description).toBe('墙体描述');
    expect(object.tag).toBe('W-01');
    expect(object.predefinedType).toBe('ELEMENT');
    expect(object.placementRef).toBe('#40');
    expect(object.placement?.position).toEqual([1, 2, 3]);
    expect(object.geometryStatus).toBe('represented');
    expect(object.representationRef).toBe('#41');
    expect(object.propertySets?.[0].name).toBe('Pset_WallCommon');
    expect(object.propertySets?.[0].values).toEqual([
      { name: 'FireRating', value: '2h', dataType: 'IFCLABEL' },
    ]);
    expect(object.relationshipCount).toBeGreaterThanOrEqual(2);
    expect(object.propertySetNames).toEqual(['Pset_WallCommon']);
    expect(object.sourcePath).toBe('DEV/model.ifc');
  });

  it('沿 IFC 分解关系继承空间归属，避免子构件被误列为未落位', () => {
    const text = [
      "#1=IFCPROJECT('p',#99,'项目',$,$,$,$,(#2),$);",
      "#2=IFCSITE('s',#99,'站区',$,$,$,$,$,.ELEMENT.,$,$,0.,$,$);",
      "#3=IFCBUILDING('b',#99,'建筑',$,$,$,$,$,.ELEMENT.,$,$);",
      "#4=IFCBUILDINGSTOREY('f',#99,'一层',$,$,$,$,$,.ELEMENT.,0.);",
      "#10=IFCELEMENTASSEMBLY('assembly-guid',#99,'装配体',$,$,$,$,$,.ACCESSORY.);",
      "#11=IFCWALL('child-guid',#99,'装配子构件',$,$,$,$,$,$);",
      "#12=IFCWALL('orphan-guid',#99,'真正未落位',$,$,$,$,$,$);",
      "#20=IFCRELAGGREGATES('r1',#99,$,$,#1,(#2));",
      "#21=IFCRELAGGREGATES('r2',#99,$,$,#2,(#3));",
      "#22=IFCRELAGGREGATES('r3',#99,$,$,#3,(#4));",
      "#23=IFCRELCONTAINEDINSPATIALSTRUCTURE('r4',#99,$,$,(#10),#4);",
      "#24=IFCRELAGGREGATES('r5',#99,$,$,#10,(#11));",
    ].join('\n');
    const index = buildSubstationSpatialIndexFromTexts([{ entry, text }], node());
    const storey = index.nodes.find((item) => item.kind === 'storey')!;
    expect(storey.directObjectKeys).toEqual(['ifc:model:object:10']);
    expect(storey.objectKeys).toEqual(expect.arrayContaining(['ifc:model:object:10', 'ifc:model:object:11']));
    expect(index.objectByKey.get('ifc:model:object:11')?.spatialContainment).toBe('inherited');
    expect(index.models[0].directContainedObjectCount).toBe(1);
    expect(index.models[0].containedObjectCount).toBe(1);
    expect(index.models[0].spatialObjectCount).toBe(2);
    expect(index.coverage.directContainedIfcObjects).toBe(1);
    expect(index.coverage.decompositionInheritedIfcObjects).toBe(1);
    expect(index.coverage.hostInheritedIfcObjects).toBe(0);
    expect(index.coverage.boundaryContainedIfcObjects).toBe(0);
    expect(index.coverage.inheritedContainedIfcObjects).toBe(1);
    expect(index.coverage.uncontainedIfcObjects).toBe(1);
    expect(storey.decompositionObjectKeys).toEqual(['ifc:model:object:11']);
  });

  it('沿开洞/端口宿主关系补齐空间归属，并保留宿主证据', () => {
    const text = [
      "#1=IFCPROJECT('p',#99,'项目',$,$,$,$,(#2),$);",
      "#2=IFCSITE('s',#99,'站区',$,$,$,$,$,.ELEMENT.,$,$,0.,$,$);",
      "#3=IFCBUILDING('b',#99,'建筑',$,$,$,$,$,.ELEMENT.,$,$);",
      "#4=IFCBUILDINGSTOREY('f',#99,'一层',$,$,$,$,$,.ELEMENT.,0.);",
      "#10=IFCWALL('wall-guid',#99,'墙体',$,$,$,$,$,$);",
      "#11=IFCOPENINGELEMENT('opening-guid',#99,'开洞',$,$,$,$,$);",
      "#12=IFCDISTRIBUTIONPORT('port-guid',#99,'端口',$,$,$,$,$);",
      "#20=IFCRELAGGREGATES('r1',#99,$,$,#1,(#2));",
      "#21=IFCRELAGGREGATES('r2',#99,$,$,#2,(#3));",
      "#22=IFCRELAGGREGATES('r3',#99,$,$,#3,(#4));",
      "#23=IFCRELCONTAINEDINSPATIALSTRUCTURE('r4',#99,$,$,(#10),#4);",
      "#24=IFCRELVOIDSELEMENT('r5',#99,$,$,#10,#11);",
      "#25=IFCRELCONNECTSPORTTOELEMENT('r6',#99,$,$,#12,#10);",
    ].join('\n');
    const index = buildSubstationSpatialIndexFromTexts([{ entry, text }], node());
    const storey = index.nodes.find((item) => item.kind === 'storey')!;
    const opening = index.objects.find((item) => item.globalId === 'opening-guid')!;
    const port = index.objects.find((item) => item.globalId === 'port-guid')!;
    expect(storey.objectKeys).toEqual(expect.arrayContaining([opening.key, port.key]));
    expect(opening.spatialContainment).toBe('inherited');
    expect(opening.spatialInheritanceKind).toBe('host-relation');
    expect(port.spatialInheritanceKind).toBe('host-relation');
    expect(opening.hostObjectKey).toBe('ifc:model:object:10');
    expect(port.hostObjectKey).toBe('ifc:model:object:10');
    expect(index.coverage.uncontainedIfcObjects).toBe(0);
    expect(index.coverage.inheritedContainedIfcObjects).toBe(2);
    expect(index.coverage.decompositionInheritedIfcObjects).toBe(0);
    expect(index.coverage.hostInheritedIfcObjects).toBe(2);
    expect(storey.hostObjectKeys).toEqual(expect.arrayContaining([opening.key, port.key]));
  });

  it('将 IFCRELSPACEBOUNDARY 显式投影到 IFCSPACE，不冒充直接包含', () => {
    const text = [
      "#1=IFCPROJECT('p',#99,'项目',$,$,$,$,(#2),$);",
      "#2=IFCSITE('s',#99,'站区',$,$,$,$,$,.ELEMENT.,$,$,0.,$,$);",
      "#3=IFCBUILDING('b',#99,'建筑',$,$,$,$,$,.ELEMENT.,$,$);",
      "#4=IFCBUILDINGSTOREY('f',#99,'一层',$,$,$,$,$,.ELEMENT.,0.);",
      "#5=IFCSPACE('sp',#99,'电缆夹层',$,$,$,$,$,.ELEMENT.,$,$);",
      "#10=IFCWALL('wall-guid',#99,'墙体',$,$,$,$,$,$);",
      "#20=IFCRELAGGREGATES('r1',#99,$,$,#1,(#2));",
      "#21=IFCRELAGGREGATES('r2',#99,$,$,#2,(#3));",
      "#22=IFCRELAGGREGATES('r3',#99,$,$,#3,(#4));",
      "#23=IFCRELAGGREGATES('r4',#99,$,$,#4,(#5));",
      "#24=IFCRELSPACEBOUNDARY('r5',#99,$,$,#5,#10,.PHYSICAL.,.INTERNAL.,$);",
    ].join('\n');
    const index = buildSubstationSpatialIndexFromTexts([{ entry, text }], node());
    const space = index.nodes.find((item) => item.kind === 'space')!;
    const wall = index.objects.find((item) => item.globalId === 'wall-guid')!;
    expect(space.boundaryObjectKeys).toEqual([wall.key]);
    expect(space.directObjectKeys).toHaveLength(0);
    expect(wall.spatialKey).toBe(space.key);
    expect(wall.spatialContainment).toBe('boundary');
    expect(wall.spatialRelation).toBe('space-boundary');
    expect(index.coverage.uncontainedIfcObjects).toBe(0);
    expect(index.coverage.boundaryContainedIfcObjects).toBe(1);
  });

  it('保留工程量单位和 Representation 缺失状态', () => {
    const text = [
      "#1=IFCPROJECT('p',#99,'项目',$,$,$,$,(#2),$);",
      "#2=IFCSITE('s',#99,'站区',$,$,$,$,$,.ELEMENT.,$,$,0.,$,$);",
      "#3=IFCBUILDING('b',#99,'建筑',$,$,$,$,$,.ELEMENT.,$,$);",
      "#4=IFCBUILDINGSTOREY('f',#99,'一层',$,$,$,$,$,.ELEMENT.,0.);",
      "#10=IFCWALL('wall-guid',#99,'墙体',$,$,#40,$,$,$);",
      "#40=IFCLOCALPLACEMENT($,#41);",
      "#41=IFCAXIS2PLACEMENT3D(#42,$,$);",
      "#42=IFCCARTESIANPOINT((0.,0.,0.));",
      "#50=IFCPROPERTYSET('ps',#99,'Pset_WallCommon',$,(#51));",
      "#51=IFCELEMENTQUANTITY('q',#99,'BaseQuantities',$,$,(#52));",
      "#52=IFCQUANTITYLENGTH('Length',$,#60,12.5);",
      "#60=IFCSIUNIT(*,.MILLI.,.METRE.,$);",
      "#53=IFCRELDEFINESBYPROPERTIES('r5',#99,$,$,(#10),#51);",
      "#20=IFCRELAGGREGATES('r1',#99,$,$,#1,(#2));",
      "#21=IFCRELAGGREGATES('r2',#99,$,$,#2,(#3));",
      "#22=IFCRELAGGREGATES('r3',#99,$,$,#3,(#4));",
      "#23=IFCRELCONTAINEDINSPATIALSTRUCTURE('r4',#99,$,$,(#10),#4);",
    ].join('\n');
    const index = buildSubstationSpatialIndexFromTexts([{ entry, text }], node());
    const object = index.objects.find((item) => item.globalId === 'wall-guid')!;
    expect(object.geometryStatus).toBe('unrepresented');
    expect(object.propertySets?.[0].values[0]).toEqual({
      name: 'Length', value: '12.5', dataType: 'length', unit: 'MILLI METRE',
    });
  });

  it('把 FileDevRelation 的图纸来源挂到空间资产，并兼容带路径/大小写差异的 CBM 引用', () => {
    const root = node({
      children: [node({
        path: 'CBM/Device-A.CBM',
        entityName: 'F4System',
        devPath: 'device.dev',
        transformMatrix: '1,0,0,0,0,1,0,0,0,0,1,0,10,20,30,1',
      })],
    });
    const relation: FileDevEntry[] = [{
      ifcName: 'GIS 布置',
      ifcFile: '',
      modelId: '',
      deviceCount: 1,
      deviceCbms: ['.\\cbm\\device-a.cbm'],
    }];
    const index = buildSubstationSpatialIndexFromTexts([{ entry, text: '' }], root, relation);
    const link = index.linksByCbmPath.get('CBM/Device-A.CBM');
    expect(link?.confidence).toBe('inferred');
    expect(link?.sourceDesignNames).toEqual(['GIS 布置']);
    expect(link?.sourceDesignFiles).toBeUndefined();
  });

  it('逐 IFC 读取时发出 read/STEP/semantic/finalize profile，且路径大小写不敏感', async () => {
    const text = "#1=IFCWALL('wall-guid',#99,'墙体',$,$,$,$,$,$);";
    const observer: SubstationSpatialIndexObserver & {
      reads: IfcSpatialReadProfile[];
      steps: Array<Parameters<NonNullable<SubstationSpatialIndexObserver['onStepScan']>>[0]>;
      parses: IfcSpatialParseProfile[];
      finalizes: Array<Parameters<NonNullable<SubstationSpatialIndexObserver['onFinalize']>>[0]>;
    } = {
      reads: [],
      steps: [],
      parses: [],
      finalizes: [],
      onModelRead(profile) { this.reads.push(profile); },
      onStepScan(profile) { this.steps.push(profile); },
      onModelParsed(profile) { this.parses.push(profile); },
      onFinalize(profile) { this.finalizes.push(profile); },
    };
    const files = new Map<string, File>([['dev/MODEL.IFC', new File([text], 'MODEL.IFC')]]);
    const result = await buildSubstationSpatialIndexFromFiles(
      files,
      [entry],
      node(),
      [],
      observer,
    );
    expect(result.models).toHaveLength(1);
    expect(observer.reads).toHaveLength(1);
    expect(observer.reads[0]).toMatchObject({
      entryPath: 'DEV/model.ifc',
      found: true,
      bytes: new TextEncoder().encode(text).byteLength,
    });
    expect(observer.reads[0].readMs).toBeGreaterThanOrEqual(0);
    expect(observer.reads[0].decodeMs).toBeGreaterThanOrEqual(0);
    expect(observer.steps).toHaveLength(1);
    expect(observer.steps[0]).toMatchObject({ entryPath: 'DEV/model.ifc', rawEntityCount: 1 });
    expect(observer.parses).toHaveLength(1);
    expect(observer.parses[0]).toMatchObject({ rawEntityCount: 1, objectCount: 1 });
    expect(observer.finalizes).toHaveLength(1);
    expect(observer.finalizes[0]).toMatchObject({ modelCount: 1, objectCount: 1 });
  });

  it('单个 IFC 读取失败时记录错误并保留其它模型的完整索引', async () => {
    const goodEntry: IfcEntry = { modelId: 'good', name: 'good', path: 'DEV/good.ifc' };
    const badEntry: IfcEntry = { modelId: 'bad', name: 'bad', path: 'DEV/bad.ifc' };
    const badFile = {
      size: 123,
      async arrayBuffer(): Promise<ArrayBuffer> { throw new Error('simulated read failure'); },
    } as unknown as File;
    const reads: IfcSpatialReadProfile[] = [];
    const result = await buildSubstationSpatialIndexFromFiles(
      new Map<string, File>([
        ['DEV/good.ifc', new File(["#1=IFCWALL('good',#99,'good',$,$,$,$,$,$);"], 'good.ifc')],
        ['DEV/bad.ifc', badFile],
      ]),
      [goodEntry, badEntry],
      node(),
      [],
      { onModelRead: (profile) => reads.push(profile) },
    );
    expect(result.models.map((model) => model.modelId)).toEqual(['good', 'bad']);
    expect(result.models.find((model) => model.modelId === 'bad')?.parseError).toContain('无法读取 IFC 内容');
    expect(reads[1]).toMatchObject({ found: true, bytes: 123, error: 'simulated read failure' });
  });
});
