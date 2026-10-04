import { describe, expect, it } from 'vitest';
import { serializeDevToGlb, serializeDevToGlbDetailed, parseDevGlbAsset } from '../glbCacheService.js';
import { collectDeviceGroups } from '../nodeInteractionService.js';
import { AppState } from '../../app/state.js';

function file(text: string, name: string): File {
  return new File([text], name, { type: 'text/plain' });
}

const IDENTITY = '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';

describe('serializeDevToGlb strict dependency semantics', () => {
  it('compiles nested PHM and repeated MOD deterministically, keeps child identity and ignores GL sidecar', async () => {
    const uuid = '12345678-1234-1234-1234-123456789abc';
    const files = new Map(Object.entries({
      'DEV/root.dev': `SUBDEVICES.NUM=1\nSUBDEVICE0=${uuid}.dev`,
      [`DEV/${uuid}.dev`]: 'SOLIDMODELS.NUM=2\nSOLIDMODEL0=first.phm\nSOLIDMODEL1=second.phm',
      'PHM/first.phm': 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=nested.phm',
      'PHM/second.phm': 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=leaf.mod\nTRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,40,0,0,1',
      'PHM/nested.phm': 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=leaf.mod',
      'MOD/leaf.mod': '<Device><Entities><Entity ID="1" Visible="TRUE"><Cuboid L="10" W="10" H="10"/></Entity></Entities></Device>',
      [`MOD/${uuid}.gl`]: '<Device><Entities><Entity ID="1"><GimGeCableConcentration/></Entity></Entities></Device>',
    }).map(([path, text]) => [path, file(text, path)]));
    const first = await serializeDevToGlbDetailed('DEV/root.dev', files);
    const second = await serializeDevToGlbDetailed('DEV/root.dev', files);
    expect(first.status).toBe('complete');
    expect(first.diagnostics).toMatchObject({ discoveredModCount: 2, renderableModCount: 2, unsupportedSourceCount: 0 });
    expect(second.bytes).toEqual(first.bytes);
    expect(first.bytes).not.toBeNull();
    const asset = await parseDevGlbAsset('DEV/root.dev', first.bytes!);
    expect(asset).not.toBeNull();
    const state = new AppState();
    state.loadedXmlModGroups.set('root', asset!.scene);
    expect(collectDeviceGroups(state, `${uuid}.dev`)).toHaveLength(2);
    expect(collectDeviceGroups(state, 'DEV/root.dev')).toHaveLength(1);
  });

  it('missing DEV rejects instead of producing an empty cache entry', async () => {
    await expect(serializeDevToGlb('DEV/missing.dev', new Map())).rejects.toThrow('DEV 文件不存在');
  });

  it('missing PHM/MOD rejects instead of producing an empty cache entry', async () => {
    const dev = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=missing.phm',
      `TRANSFORMMATRIX0=${IDENTITY}`,
    ].join('\n'), 'device.dev');
    await expect(serializeDevToGlb(
      'DEV/device.dev',
      new Map([['DEV/device.dev', dev]]),
    )).rejects.toThrow('PHM 文件不存在');

    const phm = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=missing.mod',
      `TRANSFORMMATRIX0=${IDENTITY}`,
      'COLOR0=',
    ].join('\n'), 'device.phm');
    await expect(serializeDevToGlb(
      'DEV/device.dev',
      new Map([
        ['DEV/device.dev', file([
          'SOLIDMODELS.NUM=1',
          'SOLIDMODEL0=device.phm',
          `TRANSFORMMATRIX0=${IDENTITY}`,
        ].join('\n'), 'device.dev')],
        ['PHM/device.phm', phm],
      ]),
    )).rejects.toThrow('MOD 文件不存在');
  });

  it('所有依赖存在但 MOD 是合法空占位时返回 null（可记录 empty）', async () => {
    const dev = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=device.phm',
      `TRANSFORMMATRIX0=${IDENTITY}`,
    ].join('\n'), 'device.dev');
    const phm = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=empty.mod',
      `TRANSFORMMATRIX0=${IDENTITY}`,
      'COLOR0=',
    ].join('\n'), 'device.phm');
    const emptyMod = file('<?xml version="1.0"?><Device><Entities /></Device>', 'empty.mod');

    await expect(serializeDevToGlb(
      'DEV/device.dev',
      new Map([
        ['DEV/device.dev', dev],
        ['PHM/device.phm', phm],
        ['MOD/empty.mod', emptyMod],
      ]),
    )).resolves.toBeNull();
  });

  it('非空但未知 primitive 不会被伪装成 deterministic empty', async () => {
    const dev = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=device.phm',
      `TRANSFORMMATRIX0=${IDENTITY}`,
    ].join('\n'), 'device.dev');
    const phm = file([
      'SOLIDMODELS.NUM=1',
      'SOLIDMODEL0=unknown.mod',
      `TRANSFORMMATRIX0=${IDENTITY}`,
      'COLOR0=',
    ].join('\n'), 'device.phm');
    const unknownMod = file(
      '<Device><Entities><Entity ID="0" Type="simple" Visible="true"><UnknownPrimitive Foo="1" /></Entity></Entities></Device>',
      'unknown.mod',
    );

    const result = await serializeDevToGlbDetailed(
      'DEV/device.dev',
      new Map([
        ['DEV/device.dev', dev],
        ['PHM/device.phm', phm],
        ['MOD/unknown.mod', unknownMod],
      ]),
    );

    expect(result.status).toBe('unsupported');
    expect(result.bytes).toBeNull();
    expect(result.diagnostics.emptySourceCount).toBe(0);
    expect(result.diagnostics.unsupportedSourceCount).toBe(1);
    expect(result.diagnostics.unsupportedPrimitiveTypeCounts).toEqual({ UnknownPrimitive: 1 });
  });
});
