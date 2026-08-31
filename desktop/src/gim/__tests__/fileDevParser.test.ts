import { describe, expect, it } from 'vitest';
import { parseFileDevRelation } from '../fileDevParser.js';
import { createIfcModelId } from '../modelIdentity.js';

describe('FileDevRelation 路径兼容', () => {
  it('识别 Cbm/ 目录大小写变体', async () => {
    const relation = [
      'FILE.NUM=2',
      'FILE0.NAME=一次设备',
      'FILE0.DEV.NUM=1',
      'FILE0.DEV0=CBM/device.cbm',
      'FILE1.IFC=device.ifc',
    ].join('\n');
    const files = new Map<string, File>([
      ['Cbm/FileDevRelation.cbm', new File([relation], 'FileDevRelation.cbm')],
      ['DEV/device.ifc', new File(['ISO-10303-21'], 'device.ifc')],
    ]);

    await expect(parseFileDevRelation(files)).resolves.toEqual([
      {
        ifcName: '一次设备',
        ifcFile: 'device.ifc',
        modelId: createIfcModelId('DEV/device.ifc'),
        deviceCount: 1,
        deviceCbms: ['CBM/device.cbm'],
      },
    ]);
  });

  it('缺失或重复 basename 的 IFC 来源不伪造 modelId', async () => {
    const relation = [
      'FILE.NUM=1',
      'FILE0.NAME=设备图纸',
      'FILE0.IFC=missing.ifc',
      'FILE0.DEV.NUM=1',
      'FILE0.DEV0=CBM/device.cbm',
    ].join('\n');
    const files = new Map<string, File>([
      ['CBM/FileDevRelation.cbm', new File([relation], 'FileDevRelation.cbm')],
    ]);

    await expect(parseFileDevRelation(files)).resolves.toEqual([
      expect.objectContaining({
        ifcFile: 'missing.ifc',
        modelId: '',
      }),
    ]);
  });

  it('识别 Bentley 的 FILES.NUM + DEVS.NUM，并保留仅有设备列表的图纸', async () => {
    const relation = [
      'FILES.NUM=2',
      'FILE0.NAME=220kV GIS设备.DGN',
      'FILE0.DEVS.NUM=2',
      'FILE0.DEV0=CBM/a.cbm',
      'FILE0.DEV1=b.cbm',
      'FILE1.NAME=二次屏柜布置.DGN',
      'FILE1.DEVS.NUM=1',
      'FILE1.DEV0=CBM/c.cbm',
    ].join('\n');
    const files = new Map<string, File>([
      ['cbm/FileDevRelation.cbm', new File([relation], 'FileDevRelation.cbm')],
    ]);

    await expect(parseFileDevRelation(files)).resolves.toEqual([
      {
        ifcName: '220kV GIS设备',
        ifcFile: '',
        modelId: '',
        deviceCount: 2,
        deviceCbms: ['CBM/a.cbm', 'b.cbm'],
      },
      {
        ifcName: '二次屏柜布置',
        ifcFile: '',
        modelId: '',
        deviceCount: 1,
        deviceCbms: ['CBM/c.cbm'],
      },
    ]);
  });

  it('识别非奇偶配对的 BIMBase 条目，并保留 IFC-only 条目', async () => {
    const relation = [
      'FILE.NUM=3',
      'FILE0.NAME=电气总平',
      'FILE0.DEV.NUM=1',
      'FILE0.DEV0=first.cbm',
      'FILE1.NAME=建筑',
      'FILE1.IFC=建筑.ifc',
      'FILE2.NAME=设备接线',
      'FILE2.IFC=设备接线.ifc',
    ].join('\n');
    const files = new Map<string, File>([
      ['CBM/FileDevRelation.cbm', new File([relation], 'FileDevRelation.cbm')],
    ]);

    await expect(parseFileDevRelation(files)).resolves.toEqual([
      {
        ifcName: '电气总平',
        ifcFile: '',
        modelId: '',
        deviceCount: 1,
        deviceCbms: ['first.cbm'],
      },
      {
        ifcName: '建筑',
        ifcFile: '建筑.ifc',
        modelId: '',
        deviceCount: 0,
        deviceCbms: [],
      },
      {
        ifcName: '设备接线',
        ifcFile: '设备接线.ifc',
        modelId: '',
        deviceCount: 0,
        deviceCbms: [],
      },
    ]);
  });
});
