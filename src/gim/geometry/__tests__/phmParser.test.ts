import { describe, it, expect } from 'vitest';
import { parsePhm } from '../phmParser.js';

describe('parsePhm', () => {
  describe('线路工程典型样本', () => {
    it('单 STL 模型（NUM=1，COLOR 非空）', () => {
      const text = [
        'SOLIDMODELS.NUM=1',
        'SOLIDMODEL0=83ebec7e-7e02-4154-9807-1c59d7f7af45.stl',
        'TRANSFORMMATRIX0=1.000000000,0.000000000,0.000000000,0.000000000,0.000000000,1.000000000,0.000000000,0.000000000,0.000000000,0.000000000,1.000000000,0.000000000,0.000000000,0.000000000,0.000000000,1.000000000',
        'COLOR0=215,215,215,100',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/test.phm');
      expect(doc.isEmpty).toBe(false);
      expect(doc.solidModels.length).toBe(1);
      expect(doc.solidModels[0].solidModelPath).toBe('83ebec7e-7e02-4154-9807-1c59d7f7af45.stl');
      expect(doc.solidModels[0].color).toEqual({ r: 215, g: 215, b: 215, a: 100 });
      expect(doc.solidModels[0].transformMatrix.length).toBe(16);
      // 列主序，第 0 个元素是 m11
      expect(doc.solidModels[0].transformMatrix[0]).toBe(1);
      expect(doc.solidModels[0].transformMatrix[15]).toBe(1);
    });

    it('双 MOD 模型（NUM=2，COLOR 均为空）', () => {
      const text = [
        'SOLIDMODELS.NUM=2',
        'SOLIDMODEL0=7c6cf87e-9d8c-443f-af96-ad0f81d83291.mod',
        'SOLIDMODEL1=66d18b7e-0a1c-456a-b150-8d3d09288d24.mod',
        'TRANSFORMMATRIX0=1.000000000,0.000000000,0.000000000,0.000000000,0.000000000,1.000000000,0.000000000,0.000000000,0.000000000,0.000000000,1.000000000,0.000000000,0.000000000,0.000000000,0.000000000,1.000000000',
        'TRANSFORMMATRIX1=1.000000000,0.000000000,0.000000000,0.000000000,0.000000000,1.000000000,0.000000000,0.000000000,0.000000000,0.000000000,1.000000000,0.000000000,0.000000000,0.000000000,0.000000000,1.000000000',
        'COLOR0=195,195,195,100',
        'COLOR1=255,255,255,100',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/dual.mod.phm');
      expect(doc.solidModels.length).toBe(2);
      expect(doc.solidModels[0].color?.r).toBe(195);
      expect(doc.solidModels[1].color?.b).toBe(255);
    });
  });

  describe('变电工程典型样本', () => {
    it('无几何装配节点（NUM=0）', () => {
      const text = 'SOLIDMODELS.NUM=0';
      const doc = parsePhm(text, 'PHM/empty.phm');
      expect(doc.isEmpty).toBe(true);
      expect(doc.solidModels.length).toBe(0);
    });

    it('单 MOD 模型（NUM=1，COLOR 为空）', () => {
      const text = [
        'SOLIDMODELS.NUM=1',
        'SOLIDMODEL0=f0da98cf-841b-4a14-937c-56d9b1e08303.mod',
        'TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1',
        'COLOR0=',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/single-mod.phm');
      expect(doc.solidModels.length).toBe(1);
      expect(doc.solidModels[0].solidModelPath).toBe('f0da98cf-841b-4a14-937c-56d9b1e08303.mod');
      expect(doc.solidModels[0].color).toBeUndefined();
    });

    it('STL+MOD 并存（NUM=2）', () => {
      const text = [
        'SOLIDMODELS.NUM=2',
        'SOLIDMODEL0=8f46293e-5712-469c-a953-c4b31038ea4d.mod',
        'TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1',
        'COLOR0=',
        'SOLIDMODEL1=4846c08f-5304-4ed5-af57-be3a3ea40e68.stl',
        'TRANSFORMMATRIX1=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1',
        'COLOR1=215,215,215,100',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/mixed.phm');
      expect(doc.solidModels.length).toBe(2);
      expect(doc.solidModels[0].color).toBeUndefined();
      expect(doc.solidModels[1].color).toEqual({ r: 215, g: 215, b: 215, a: 100 });
    });
  });

  describe('TRANSFORMMATRIX 处理', () => {
    it('缺失时回退单位矩阵', () => {
      const text = [
        'SOLIDMODELS.NUM=1',
        'SOLIDMODEL0=a.mod',
        'COLOR0=',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/no-matrix.phm');
      expect(doc.solidModels[0].transformMatrix).toEqual([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]);
    });

    it('长度不为 16 时回退单位矩阵', () => {
      const text = [
        'SOLIDMODELS.NUM=1',
        'SOLIDMODEL0=a.mod',
        'TRANSFORMMATRIX0=1,0,0,0,0,1,0,0',  // 仅 8 个
        'COLOR0=',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/bad-matrix.phm');
      expect(doc.solidModels[0].transformMatrix[0]).toBe(1);
      expect(doc.solidModels[0].transformMatrix[15]).toBe(1);
    });

    it('含 NaN 时回退单位矩阵', () => {
      const text = [
        'SOLIDMODELS.NUM=1',
        'SOLIDMODEL0=a.mod',
        'TRANSFORMMATRIX0=1,abc,0,0,0,1,0,0,0,0,1,0,0,0,0,1',
        'COLOR0=',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/nan-matrix.phm');
      expect(doc.solidModels[0].transformMatrix[0]).toBe(1);
      expect(doc.solidModels[0].transformMatrix[15]).toBe(1);
    });

    it('非单位矩阵正确解析（平移分量）', () => {
      const text = [
        'SOLIDMODELS.NUM=1',
        'SOLIDMODEL0=a.mod',
        'TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,100,200,300,1',
        'COLOR0=',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/translate.phm');
      // 列主序：index 12/13/14 是平移分量
      expect(doc.solidModels[0].transformMatrix[12]).toBe(100);
      expect(doc.solidModels[0].transformMatrix[13]).toBe(200);
      expect(doc.solidModels[0].transformMatrix[14]).toBe(300);
    });
  });

  describe('COLOR 处理', () => {
    it('空字符串返回 undefined', () => {
      const text = [
        'SOLIDMODELS.NUM=1',
        'SOLIDMODEL0=a.mod',
        'COLOR0=',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/empty-color.phm');
      expect(doc.solidModels[0].color).toBeUndefined();
    });

    it('undefined 字段返回 undefined', () => {
      const text = [
        'SOLIDMODELS.NUM=1',
        'SOLIDMODEL0=a.mod',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/missing-color.phm');
      expect(doc.solidModels[0].color).toBeUndefined();
    });

    it('R/G/B 超出 0-255 返回 undefined', () => {
      const text = [
        'SOLIDMODELS.NUM=1',
        'SOLIDMODEL0=a.mod',
        'COLOR0=300,0,0,100',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/rgb-overflow.phm');
      expect(doc.solidModels[0].color).toBeUndefined();
    });

    it('A 超出 0-100 返回 undefined', () => {
      const text = [
        'SOLIDMODELS.NUM=1',
        'SOLIDMODEL0=a.mod',
        'COLOR0=100,100,100,150',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/a-overflow.phm');
      expect(doc.solidModels[0].color).toBeUndefined();
    });

    it('格式异常（非数字）返回 undefined', () => {
      const text = [
        'SOLIDMODELS.NUM=1',
        'SOLIDMODEL0=a.mod',
        'COLOR0=abc,def,ghi,jkl',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/bad-color.phm');
      expect(doc.solidModels[0].color).toBeUndefined();
    });

    it('部分缺失返回 undefined', () => {
      const text = [
        'SOLIDMODELS.NUM=1',
        'SOLIDMODEL0=a.mod',
        'COLOR0=100,200,50',  // 仅 3 个
      ].join('\n');
      const doc = parsePhm(text, 'PHM/partial-color.phm');
      expect(doc.solidModels[0].color).toBeUndefined();
    });

    it('边界值 0,0,0,0 与 255,255,255,100 正确解析', () => {
      const text = [
        'SOLIDMODELS.NUM=2',
        'SOLIDMODEL0=a.mod',
        'COLOR0=0,0,0,0',
        'SOLIDMODEL1=b.mod',
        'COLOR1=255,255,255,100',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/boundary.phm');
      expect(doc.solidModels[0].color).toEqual({ r: 0, g: 0, b: 0, a: 0 });
      expect(doc.solidModels[1].color).toEqual({ r: 255, g: 255, b: 255, a: 100 });
    });
  });

  describe('异常输入', () => {
    it('SOLIDMODELS.NUM 缺失 → isEmpty', () => {
      const text = 'OTHER_KEY=value';
      const doc = parsePhm(text, 'PHM/no-num.phm');
      expect(doc.isEmpty).toBe(true);
      expect(doc.solidModels.length).toBe(0);
    });

    it('SOLIDMODELS.NUM 非数字 → isEmpty', () => {
      const text = 'SOLIDMODELS.NUM=abc';
      const doc = parsePhm(text, 'PHM/bad-num.phm');
      expect(doc.isEmpty).toBe(true);
    });

    it('SOLIDMODELS.NUM 为负数 → isEmpty', () => {
      const text = 'SOLIDMODELS.NUM=-1';
      const doc = parsePhm(text, 'PHM/negative-num.phm');
      expect(doc.isEmpty).toBe(true);
    });

    it('SOLIDMODEL{i} 缺失但 NUM 声明 → 跳过该条目', () => {
      const text = [
        'SOLIDMODELS.NUM=3',
        'SOLIDMODEL0=a.mod',
        'COLOR0=',
        // SOLIDMODEL1 缺失
        'SOLIDMODEL2=c.mod',
        'COLOR2=',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/missing-model.phm');
      expect(doc.solidModels.length).toBe(2);
      expect(doc.solidModels[0].solidModelPath).toBe('a.mod');
      expect(doc.solidModels[1].solidModelPath).toBe('c.mod');
    });

    it('空文本 → isEmpty', () => {
      const doc = parsePhm('', 'PHM/empty-text.phm');
      expect(doc.isEmpty).toBe(true);
      expect(doc.solidModels.length).toBe(0);
    });

    it('CRLF 行尾正确解析', () => {
      const text = [
        'SOLIDMODELS.NUM=1',
        'SOLIDMODEL0=a.mod',
        'COLOR0=',
      ].join('\r\n');
      const doc = parsePhm(text, 'PHM/crlf.phm');
      expect(doc.solidModels.length).toBe(1);
      expect(doc.solidModels[0].solidModelPath).toBe('a.mod');
    });

    it('行内 = 后内容可含 =（不破坏解析）', () => {
      // 简单 KV 解析按第一个 = 拆分，所以值中可含 =
      const text = [
        'SOLIDMODELS.NUM=1',
        'SOLIDMODEL0=a.mod',
        'COLOR0=',
        'NOTE=this=value=has=equals',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/equal-in-value.phm');
      expect(doc.solidModels.length).toBe(1);
    });

    it('大小写敏感（PHM 字段名大写）', () => {
      const text = [
        'solidmodels.num=1',  // 小写，应被忽略
        'SOLIDMODEL0=a.mod',
        'COLOR0=',
      ].join('\n');
      const doc = parsePhm(text, 'PHM/lowercase.phm');
      expect(doc.isEmpty).toBe(true);
    });
  });

  describe('phmPath 透传', () => {
    it('phmPath 字段保留原值', () => {
      const doc = parsePhm('SOLIDMODELS.NUM=0', 'PHM/some/uuid.phm');
      expect(doc.phmPath).toBe('PHM/some/uuid.phm');
    });
  });
});
