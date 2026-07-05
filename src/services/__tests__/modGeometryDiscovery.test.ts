import { describe, it, expect, vi } from 'vitest';
import { discoverModGeometriesFromNode } from '../modGeometryDiscovery.js';
import type { CbmNode } from '../../gim/types.js';

/** 构造 CbmNode */
function makeNode(devPath: string): CbmNode {
  return {
    path: 'CBM/test.cbm',
    name: 'test',
    entityName: '',
    children: [],
    famPath: '',
    devPath,
    ifcFile: '',
    ifcGuid: '',
    classifyName: '',
    transformMatrix: '',
  };
}

/**
 * 构造 File 对象（确保 .text() 可用）。
 *
 * jsdom 的 File 实现可能不稳定，统一用 Blob + 类型断言构造。
 */
function makeFile(content: string, name: string): File {
  return new File([content], name, { type: 'text/plain' });
}

/** 构造 DEV 文件文本（变电工程典型：SOLIDMODELS 指向 .phm） */
function makeDevText(opts?: {
  phmPath?: string;
  transform?: string;
  num?: number;
}): string {
  const phmPath = opts?.phmPath ?? 'main.phm';
  const transform = opts?.transform ?? '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';
  const num = opts?.num ?? 1;
  let text = `BASEFAMILY=abc.fam
SYMBOLNAME=test
TYPE=OTHERS
SOLIDMODELS.NUM=${num}
`;
  for (let i = 0; i < num; i++) {
    text += `SOLIDMODEL${i}=${phmPath}\nTRANSFORMMATRIX${i}=${transform}\n`;
  }
  return text;
}

/** 构造 PHM 文件文本（SOLIDMODELS 指向 .mod 或 .stl） */
function makePhmText(opts?: {
  modelPath?: string;
  transform?: string;
  color?: string;
  num?: number;
}): string {
  const modelPath = opts?.modelPath ?? 'main.mod';
  const transform = opts?.transform ?? '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';
  const color = opts?.color ?? '';
  const num = opts?.num ?? 1;
  let text = `SOLIDMODELS.NUM=${num}\n`;
  for (let i = 0; i < num; i++) {
    text += `SOLIDMODEL${i}=${modelPath}\nTRANSFORMMATRIX${i}=${transform}\nCOLOR${i}=${color}\n`;
  }
  return text;
}

describe('discoverModGeometriesFromNode', () => {
  describe('基础场景', () => {
    it('完整链：CBM → DEV → PHM → MOD → 返回 1 个几何来源', async () => {
      const node = makeNode('abc.dev');
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(makeDevText({ phmPath: 'main.phm' }), 'abc.dev')],
        ['PHM/main.phm', makeFile(makePhmText({ modelPath: 'main.mod' }), 'main.phm')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results).toHaveLength(1);
      expect(results[0].modPath).toBe('MOD/main.mod');
      expect(results[0].devPath).toBe('DEV/abc.dev');
      expect(results[0].phmPath).toBe('PHM/main.phm');
    });

    it('多个 SOLIDMODEL → 返回多个几何来源', async () => {
      const node = makeNode('abc.dev');
      const devText = `SOLIDMODELS.NUM=2
SOLIDMODEL0=a.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
SOLIDMODEL1=b.phm
TRANSFORMMATRIX1=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1`;
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(devText, 'abc.dev')],
        ['PHM/a.phm', makeFile(makePhmText({ modelPath: 'a.mod' }), 'a.phm')],
        ['PHM/b.phm', makeFile(makePhmText({ modelPath: 'b.mod' }), 'b.phm')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results).toHaveLength(2);
      expect(results[0].modPath).toBe('MOD/a.mod');
      expect(results[1].modPath).toBe('MOD/b.mod');
    });

    it('PHM 多个 SOLIDMODEL → 全部发现', async () => {
      const node = makeNode('abc.dev');
      const phmText = `SOLIDMODELS.NUM=3
SOLIDMODEL0=a.mod
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
COLOR0=
SOLIDMODEL1=b.mod
TRANSFORMMATRIX1=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
COLOR1=
SOLIDMODEL2=c.mod
TRANSFORMMATRIX2=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
COLOR2=`;
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(makeDevText({ phmPath: 'main.phm' }), 'abc.dev')],
        ['PHM/main.phm', makeFile(phmText, 'main.phm')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results).toHaveLength(3);
      expect(results.map((r) => r.modPath)).toEqual(['MOD/a.mod', 'MOD/b.mod', 'MOD/c.mod']);
    });
  });

  describe('TransformMatrix 透传', () => {
    it('DEV TRANSFORMMATRIX 行主序透传', async () => {
      const node = makeNode('abc.dev');
      const devTransform = '1,0,0,100,0,1,0,200,0,0,1,50,0,0,0,1';
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(makeDevText({ transform: devTransform }), 'abc.dev')],
        ['PHM/main.phm', makeFile(makePhmText(), 'main.phm')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results[0].devTransformMatrix[3]).toBe(100);
      expect(results[0].devTransformMatrix[7]).toBe(200);
      expect(results[0].devTransformMatrix[11]).toBe(50);
    });

    it('PHM TRANSFORMMATRIX 行主序透传', async () => {
      const node = makeNode('abc.dev');
      const phmTransform = '1,0,0,10,0,1,0,20,0,0,1,30,0,0,0,1';
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(makeDevText(), 'abc.dev')],
        ['PHM/main.phm', makeFile(makePhmText({ transform: phmTransform }), 'main.phm')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results[0].phmTransformMatrix[3]).toBe(10);
      expect(results[0].phmTransformMatrix[7]).toBe(20);
      expect(results[0].phmTransformMatrix[11]).toBe(30);
    });
  });

  describe('Color 透传', () => {
    it('PHM COLORn 为空 → phmColor 为 undefined（MOD 引用典型）', async () => {
      const node = makeNode('abc.dev');
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(makeDevText(), 'abc.dev')],
        ['PHM/main.phm', makeFile(makePhmText({ color: '' }), 'main.phm')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results[0].phmColor).toBeUndefined();
    });

    it('PHM COLORn 非空 → phmColor 解析为对象（STL 引用典型）', async () => {
      const node = makeNode('abc.dev');
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(makeDevText(), 'abc.dev')],
        ['PHM/main.phm', makeFile(makePhmText({ color: '128,128,128,100' }), 'main.phm')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results[0].phmColor).toEqual({ r: 128, g: 128, b: 128, a: 100 });
    });
  });

  describe('边界情况', () => {
    it('node.devPath 为空 → 返回空数组', async () => {
      const node = makeNode('');
      const files = new Map<string, File>();
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results).toEqual([]);
    });

    it('files 为 null（缓存命中场景）→ 返回空数组', async () => {
      const node = makeNode('abc.dev');
      const results = await discoverModGeometriesFromNode(node, null);
      expect(results).toEqual([]);
    });

    it('DEV 文件不存在 → 返回空数组 + warn', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const node = makeNode('missing.dev');
      const files = new Map<string, File>();
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DEV/missing.dev'));
      warnSpy.mockRestore();
    });

    it('DEV isEmpty → 返回空数组', async () => {
      const node = makeNode('abc.dev');
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile('SOLIDMODELS.NUM=0', 'abc.dev')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results).toEqual([]);
    });

    it('PHM 文件不存在 → 该 SOLIDMODEL 跳过 + warn', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const node = makeNode('abc.dev');
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(makeDevText({ phmPath: 'missing.phm' }), 'abc.dev')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('PHM/missing.phm'));
      warnSpy.mockRestore();
    });

    it('PHM isEmpty → 该 SOLIDMODEL 跳过', async () => {
      const node = makeNode('abc.dev');
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(makeDevText({ phmPath: 'empty.phm' }), 'abc.dev')],
        ['PHM/empty.phm', makeFile('SOLIDMODELS.NUM=0', 'empty.phm')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results).toEqual([]);
    });

    it('PHM 引用 STL → 新版 discoverGeometriesFromNode 正常返回 STL', async () => {
      const { discoverGeometriesFromNode } = await import('../modGeometryDiscovery.js');
      const node = makeNode('abc.dev');
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(makeDevText({ phmPath: 'main.phm' }), 'abc.dev')],
        ['PHM/main.phm', makeFile(makePhmText({ modelPath: 'main.stl', color: '128,128,128,100' }), 'main.phm')],
      ]);
      const results = await discoverGeometriesFromNode(node, files);
      expect(results.mods).toEqual([]);
      expect(results.stls).toHaveLength(1);
      expect(results.stls[0].stlPath).toBe('MOD/main.stl');
    });

    it('PHM 引用 STL → 旧版 discoverModGeometriesFromNode 兼容（仅返回 MOD）', async () => {
      const node = makeNode('abc.dev');
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(makeDevText({ phmPath: 'main.phm' }), 'abc.dev')],
        ['PHM/main.phm', makeFile(makePhmText({ modelPath: 'main.stl', color: '128,128,128,100' }), 'main.phm')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      // 旧版 wrapper 仅返回 .mods，STL 不出现（向后兼容）
      expect(results).toEqual([]);
    });

    it('PHM 引用未知扩展名 → 跳过 + warn', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const node = makeNode('abc.dev');
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(makeDevText({ phmPath: 'main.phm' }), 'abc.dev')],
        ['PHM/main.phm', makeFile(makePhmText({ modelPath: 'main.xyz' }), 'main.phm')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('main.xyz'));
      warnSpy.mockRestore();
    });

    it('DEV SOLIDMODEL 指向 .dev（线路工程递归）→ 跳过', async () => {
      const node = makeNode('abc.dev');
      const devText = `SOLIDMODELS.NUM=1
SOLIDMODEL0=child.dev
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1`;
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(devText, 'abc.dev')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results).toEqual([]);
    });

    it('DEV 同时含 SOLIDMODELS 和 SUBDEVICES → 仅处理 SOLIDMODELS（不递归 SUBDEVICES）', async () => {
      const node = makeNode('parent.dev');
      const devText = `BASEFAMILY=abc.fam
TYPE=FrameCapacitor
SUBDEVICES.NUM=1
SUBDEVICE0=child.dev
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
SOLIDMODELS.NUM=1
SOLIDMODEL0=main.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1`;
      const files = new Map<string, File>([
        ['DEV/parent.dev', makeFile(devText, 'parent.dev')],
        ['PHM/main.phm', makeFile(makePhmText({ modelPath: 'main.mod' }), 'main.phm')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results).toHaveLength(1);
      expect(results[0].modPath).toBe('MOD/main.mod');
    });
  });

  describe('大小写处理', () => {
    it('MOD 文件名大小写不敏感（.MOD 也接受）', async () => {
      const node = makeNode('abc.dev');
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(makeDevText({ phmPath: 'main.phm' }), 'abc.dev')],
        ['PHM/main.phm', makeFile(makePhmText({ modelPath: 'main.MOD' }), 'main.phm')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results).toHaveLength(1);
      expect(results[0].modPath).toBe('MOD/main.MOD');
    });

    it('PHM 文件名大小写不敏感（.PHM 也接受）', async () => {
      const node = makeNode('abc.dev');
      const files = new Map<string, File>([
        ['DEV/abc.dev', makeFile(makeDevText({ phmPath: 'main.PHM' }), 'abc.dev')],
        ['PHM/main.PHM', makeFile(makePhmText({ modelPath: 'main.mod' }), 'main.PHM')],
      ]);
      const results = await discoverModGeometriesFromNode(node, files);
      expect(results).toHaveLength(1);
      expect(results[0].phmPath).toBe('PHM/main.PHM');
    });
  });
});
