import { describe, expect, it } from 'vitest';
import { serializeDevToGlb } from '../glbCacheService.js';

function file(text: string, name: string): File {
  return new File([text], name, { type: 'text/plain' });
}

const IDENTITY = '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';

describe('serializeDevToGlb strict dependency semantics', () => {
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
});
