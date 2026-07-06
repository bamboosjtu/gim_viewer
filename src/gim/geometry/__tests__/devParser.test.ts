import { describe, it, expect } from 'vitest';
import { parseDev } from '../devParser.js';

describe('parseDev', () => {
  describe('基础字段解析', () => {
    it('解析 BASEFAMILY / SYMBOLNAME / TYPE（变电工程）', () => {
      const text = `BASEFAMILY=4058963c-f997-4209-a3d5-beda62a70479.fam
SYMBOLNAME=柜体
TYPE=OTHERS
SUBDEVICES.NUM=0
SOLIDMODELS.NUM=1
SOLIDMODEL0=9aaf75bf-db95-4f71-a556-31fae57d58b3.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.devPath).toBe('DEV/abc.dev');
      expect(doc.baseFamily).toBe('4058963c-f997-4209-a3d5-beda62a70479.fam');
      expect(doc.symbolName).toBe('柜体');
      expect(doc.type).toBe('OTHERS');
    });

    it('解析 DEVICETYPE（线路工程，TYPE 缺失时回退 DEVICETYPE）', () => {
      const text = `DEVICETYPE=BASE
SYMBOLNAME=BASE
BASEFAMILY=abc.fam
SOLIDMODELS.NUM=1
SOLIDMODEL0=xyz.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1`;
      const doc = parseDev(text, 'DEV/line.dev');
      expect(doc.type).toBe('BASE');
    });

    it('TYPE 与 DEVICETYPE 同时存在时优先 TYPE', () => {
      const text = `TYPE=OTHERS
DEVICETYPE=BASE
BASEFAMILY=abc.fam
SOLIDMODELS.NUM=0`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.type).toBe('OTHERS');
    });

    it('BASEFAMILY / SYMBOLNAME / TYPE 全部缺失时为空字符串', () => {
      const text = `SOLIDMODELS.NUM=0`;
      const doc = parseDev(text, 'DEV/empty.dev');
      expect(doc.baseFamily).toBe('');
      expect(doc.symbolName).toBe('');
      expect(doc.type).toBe('');
    });
  });

  describe('SOLIDMODELS 块解析', () => {
    it('单个 SOLIDMODEL + TRANSFORMMATRIX', () => {
      const text = `BASEFAMILY=abc.fam
SOLIDMODELS.NUM=1
SOLIDMODEL0=abc.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,100,200,50,1`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.solidModels).toHaveLength(1);
      expect(doc.solidModels[0].solidModelPath).toBe('abc.phm');
      // Three.js Matrix4.elements：平移在索引 12/13/14
      expect(doc.solidModels[0].transformMatrix[12]).toBe(100);
      expect(doc.solidModels[0].transformMatrix[13]).toBe(200);
      expect(doc.solidModels[0].transformMatrix[14]).toBe(50);
    });

    it('多个 SOLIDMODEL + TRANSFORMMATRIX（按索引对应）', () => {
      const text = `SOLIDMODELS.NUM=3
SOLIDMODEL0=a.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,10,0,0,1
SOLIDMODEL1=b.phm
TRANSFORMMATRIX1=1,0,0,0,0,1,0,0,0,0,1,0,20,0,0,1
SOLIDMODEL2=c.phm
TRANSFORMMATRIX2=1,0,0,0,0,1,0,0,0,0,1,0,30,0,0,1`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.solidModels).toHaveLength(3);
      expect(doc.solidModels[0].solidModelPath).toBe('a.phm');
      expect(doc.solidModels[0].transformMatrix[12]).toBe(10);
      expect(doc.solidModels[1].solidModelPath).toBe('b.phm');
      expect(doc.solidModels[1].transformMatrix[12]).toBe(20);
      expect(doc.solidModels[2].solidModelPath).toBe('c.phm');
      expect(doc.solidModels[2].transformMatrix[12]).toBe(30);
    });

    it('SOLIDMODEL 缺失 TRANSFORMMATRIX → 回退单位矩阵', () => {
      const text = `SOLIDMODELS.NUM=1
SOLIDMODEL0=abc.phm`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.solidModels[0].transformMatrix).toEqual([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ]);
    });

    it('TRANSFORMMATRIX 长度不为 16 → 回退单位矩阵', () => {
      const text = `SOLIDMODELS.NUM=1
SOLIDMODEL0=abc.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.solidModels[0].transformMatrix).toEqual([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ]);
    });

    it('TRANSFORMMATRIX 含 NaN → 回退单位矩阵', () => {
      const text = `SOLIDMODELS.NUM=1
SOLIDMODEL0=abc.phm
TRANSFORMMATRIX0=1,abc,0,0,0,1,0,0,0,0,1,0,0,0,0,1`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.solidModels[0].transformMatrix).toEqual([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ]);
    });

    it('SOLIDMODELn 索引超出 NUM → 跳过', () => {
      const text = `SOLIDMODELS.NUM=1
SOLIDMODEL0=abc.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
SOLIDMODEL1=extra.phm
TRANSFORMMATRIX1=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.solidModels).toHaveLength(1);
      expect(doc.solidModels[0].solidModelPath).toBe('abc.phm');
    });

    it('SOLIDMODELn 值为空 → 跳过该条目', () => {
      const text = `SOLIDMODELS.NUM=2
SOLIDMODEL0=abc.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
SOLIDMODEL1=
TRANSFORMMATRIX1=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.solidModels).toHaveLength(1);
    });

    it('SOLIDMODELS.NUM 缺失 → 空列表', () => {
      const text = `BASEFAMILY=abc.fam`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.solidModels).toHaveLength(0);
    });

    it('SOLIDMODELS.NUM=0 → 空列表', () => {
      const text = `SOLIDMODELS.NUM=0`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.solidModels).toHaveLength(0);
    });
  });

  describe('SUBDEVICES 块解析（变电工程专用）', () => {
    it('SUBDEVICES + SOLIDMODELS 共存：TRANSFORMMATRIX 索引各自独立从 0 开始', () => {
      // 这是 dev.md 文档强调的关键约束
      const text = `BASEFAMILY=abc.fam
TYPE=FrameCapacitor
SUBDEVICES.NUM=2
SUBDEVICE0=child1.dev
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,10,0,0,1
SUBDEVICE1=child2.dev
TRANSFORMMATRIX1=1,0,0,0,0,1,0,0,0,0,1,0,20,0,0,1
SOLIDMODELS.NUM=1
SOLIDMODEL0=main.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,30,0,0,1`;
      const doc = parseDev(text, 'DEV/parent.dev');
      // SUBDEVICES 块
      expect(doc.subDevices).toHaveLength(2);
      expect(doc.subDevices[0].devPath).toBe('child1.dev');
      expect(doc.subDevices[0].transformMatrix[12]).toBe(10);
      expect(doc.subDevices[1].devPath).toBe('child2.dev');
      expect(doc.subDevices[1].transformMatrix[12]).toBe(20);
      // SOLIDMODELS 块的 TRANSFORMMATRIX0 重新从 0 开始
      expect(doc.solidModels).toHaveLength(1);
      expect(doc.solidModels[0].solidModelPath).toBe('main.phm');
      expect(doc.solidModels[0].transformMatrix[12]).toBe(30);
    });

    it('SUBDEVICES.NUM=0 → subDevices 为空', () => {
      const text = `SUBDEVICES.NUM=0
SOLIDMODELS.NUM=0`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.subDevices).toHaveLength(0);
    });

    it('仅 SUBDEVICES 无 SOLIDMODELS', () => {
      const text = `SUBDEVICES.NUM=1
SUBDEVICE0=child.dev
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,100,0,0,1
SOLIDMODELS.NUM=0`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.subDevices).toHaveLength(1);
      expect(doc.subDevices[0].devPath).toBe('child.dev');
      expect(doc.subDevices[0].transformMatrix[12]).toBe(100);
      expect(doc.solidModels).toHaveLength(0);
    });

    it('SUBDEVICE 缺失 TRANSFORMMATRIX → 回退单位矩阵', () => {
      const text = `SUBDEVICES.NUM=1
SUBDEVICE0=child.dev
SOLIDMODELS.NUM=0`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.subDevices[0].transformMatrix).toEqual([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ]);
    });

    it('含 9 个子设备的 FrameCapacitor（变电工程典型样本，简化为 3 个验证）', () => {
      // 基于 docs/schema/dev.md 真实样本（简化，仅保留 SUBDEVICE0/1/8 验证格式与归属）
      const text = `BASEFAMILY=77791a2a-6f55-4c6c-8d7a-c48e0cb0fc4d.fam
SYMBOLNAME=框架式电容器（典设A2-6）
TYPE=FrameCapacitor
SUBDEVICES.NUM=9
SUBDEVICE0=1caef33c-0f6e-4c60-bc2f-b0bdb3aa24c3.dev
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
SUBDEVICE1=da2d14df-d86b-42de-b7d6-de7815d57a05.dev
TRANSFORMMATRIX1=1,0,0,0,0,1,0,0,0,0,1,0,1.08286712929839E-12,0,-1.40772726808791E-11,1
SUBDEVICE8=2bb88510-6ac5-41e2-95d0-2b886fdad9bd.dev
TRANSFORMMATRIX8=1,0,0,0,0,1,0,0,0,0,1,0,1.46728496019932E-10,0,-1.3651351653956E-11,1
SOLIDMODELS.NUM=1
SOLIDMODEL0=b1b1f864-a3e5-4ae5-b8a8-ed57b3c28805.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1`;
      const doc = parseDev(text, 'DEV/cap.dev');
      // 测试文本仅含 SUBDEVICE0/1/8（NUM=9 但实际提供 3 个）
      // 解析器按顺序收集，验证非连续索引也能被收集
      expect(doc.subDevices).toHaveLength(3);
      expect(doc.subDevices[0].devPath).toBe('1caef33c-0f6e-4c60-bc2f-b0bdb3aa24c3.dev');
      expect(doc.subDevices[2].devPath).toBe('2bb88510-6ac5-41e2-95d0-2b886fdad9bd.dev');
      // SUBDEVICE1 矩阵：translation 位于索引 12/13/14
      expect(doc.subDevices[1].transformMatrix[12]).toBe(1.08286712929839e-12);
      expect(doc.subDevices[1].transformMatrix[13]).toBe(0);
      expect(doc.subDevices[1].transformMatrix[14]).toBe(-1.40772726808791e-11);
      expect(doc.solidModels).toHaveLength(1);
      expect(doc.solidModels[0].solidModelPath).toBe('b1b1f864-a3e5-4ae5-b8a8-ed57b3c28805.phm');
    });
  });

  describe('线路工程典型样本', () => {
    it('STRING 类型：4 个子 DEV 递归引用（SOLIDMODELn → .dev）', () => {
      // 基于 docs/schema/dev.md 真实样本（简化）
      const text = `DEVICETYPE=STRING
SYMBOLNAME=INSULATOR
BASEFAMILY=006bb90c-7d49-4f08-92f8-b43f2f18c4db.fam
SOLIDMODELS.NUM=4
SOLIDMODEL0=9e67c7f3-b43c-4cb9-afd0-71518db7fc5a.dev
TRANSFORMMATRIX0=-0.000000,-1.000000,0.000000,0.000000,-1.000000,0.000000,0.000000,0.000000,-0.000000,0.000000,-1.000000,0.000000,0.000000,0.000000,-0.100000,1.000000
SOLIDMODEL1=4357eeab-750f-4af6-a356-0dad58d2fa98.dev
TRANSFORMMATRIX1=1.000000,0.000000,0.000000,0.000000,0.000000,1.000000,0.000000,0.000000,0.000000,0.000000,1.000000,0.000000,-0.000000,0.000000,-0.100000,1.000000
SOLIDMODEL2=4f162b79-db69-4aea-b17f-bb70fb72ce22.dev
TRANSFORMMATRIX2=0.000000,1.000000,0.000000,0.000000,-1.000000,0.000000,0.000000,0.000000,0.000000,0.000000,1.000000,0.000000,-0.000000,0.000000,-0.195000,1.000000
SOLIDMODEL3=e9bc64b3-401d-49b1-b3cd-13dea6440516.dev
TRANSFORMMATRIX3=0.000000,-1.000000,0.000000,0.000000,1.000000,0.000000,0.000000,0.000000,0.000000,0.000000,1.000000,0.000000,-0.000000,0.000000,-0.315000,1.000000`;
      const doc = parseDev(text, 'DEV/insulator.dev');
      expect(doc.solidModels).toHaveLength(4);
      // 全部指向 .dev（线路工程典型，递归组合）
      expect(doc.solidModels.every((s) => s.solidModelPath.endsWith('.dev'))).toBe(true);
      // SUBDEVICES 应为空（线路工程不使用 SUBDEVICES 块）
      expect(doc.subDevices).toHaveLength(0);
      // 验证 TRANSFORMMATRIX0 的旋转分量（-1 表示 90° 旋转）
      expect(doc.solidModels[0].transformMatrix[1]).toBe(-1);
      expect(doc.solidModels[0].transformMatrix[4]).toBe(-1);
    });
  });

  describe('isEmpty 标识', () => {
    it('无 SOLIDMODELS 且无 SUBDEVICES → isEmpty=true', () => {
      const text = `BASEFAMILY=abc.fam
SOLIDMODELS.NUM=0
SUBDEVICES.NUM=0`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.isEmpty).toBe(true);
    });

    it('有 SOLIDMODELS → isEmpty=false', () => {
      const text = `SOLIDMODELS.NUM=1
SOLIDMODEL0=abc.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.isEmpty).toBe(false);
    });

    it('仅 SUBDEVICES → isEmpty=false', () => {
      const text = `SUBDEVICES.NUM=1
SUBDEVICE0=child.dev
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
SOLIDMODELS.NUM=0`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.isEmpty).toBe(false);
    });

    it('空文本 → isEmpty=true', () => {
      const doc = parseDev('', 'DEV/empty.dev');
      expect(doc.isEmpty).toBe(true);
      expect(doc.solidModels).toHaveLength(0);
      expect(doc.subDevices).toHaveLength(0);
    });
  });

  describe('格式异常处理', () => {
    it('CRLF 行尾 → 正常解析', () => {
      const text = 'BASEFAMILY=abc.fam\r\nSOLIDMODELS.NUM=1\r\nSOLIDMODEL0=abc.phm\r\nTRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.baseFamily).toBe('abc.fam');
      expect(doc.solidModels).toHaveLength(1);
    });

    it('含空白行 → 跳过空行', () => {
      const text = `BASEFAMILY=abc.fam

SOLIDMODELS.NUM=1

SOLIDMODEL0=abc.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.solidModels).toHaveLength(1);
    });

    it('行首尾空白 → trim 后正确解析', () => {
      const text = `  BASEFAMILY=abc.fam  
  SOLIDMODELS.NUM=1  
  SOLIDMODEL0=abc.phm  
  TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1  `;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.baseFamily).toBe('abc.fam');
      expect(doc.solidModels[0].solidModelPath).toBe('abc.phm');
    });

    it('TRANSFORMMATRIX 含尾随逗号 → 仍按 16 浮点解析（split 后 filter 空串）', () => {
      // phmParser 用 filter 移除空串，devParser 也是同样处理
      const text = `SOLIDMODELS.NUM=1
SOLIDMODEL0=abc.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1,`;
      const doc = parseDev(text, 'DEV/abc.dev');
      // 尾随逗号产生空段，filter 后仍为 16 个有效值
      expect(doc.solidModels[0].transformMatrix[0]).toBe(1);
      expect(doc.solidModels[0].transformMatrix[15]).toBe(1);
    });

    it('无 = 号的行 → 跳过', () => {
      const text = `BASEFAMILY=abc.fam
这是一行没有等号的注释
SOLIDMODELS.NUM=0`;
      const doc = parseDev(text, 'DEV/abc.dev');
      expect(doc.baseFamily).toBe('abc.fam');
    });

    it('TRANSFORMMATRIX 出现在 SOLIDMODELS.NUM 之前 → 不归属（currentBlock=null）', () => {
      // 边界情况：TRANSFORMMATRIX 在 NUM 之前，currentBlock 还没设置
      // 此时 solidModels 还是空数组，tmIndex 越界，不归属任何块
      const text = `TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
SOLIDMODELS.NUM=1
SOLIDMODEL0=abc.phm`;
      const doc = parseDev(text, 'DEV/abc.dev');
      // SOLIDMODEL0 创建时使用 IDENTITY，后续没有 TRANSFORMMATRIX0 覆盖
      // （因为 TRANSFORMMATRIX0 出现在前，已经被跳过）
      expect(doc.solidModels).toHaveLength(1);
      expect(doc.solidModels[0].transformMatrix).toEqual([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ]);
    });
  });

  describe('devPath 透传', () => {
    it('devPath 完整路径（含 DEV/ 前缀）', () => {
      const doc = parseDev('SOLIDMODELS.NUM=0', 'DEV/abc-123.dev');
      expect(doc.devPath).toBe('DEV/abc-123.dev');
    });

    it('devPath 裸文件名', () => {
      const doc = parseDev('SOLIDMODELS.NUM=0', 'abc.dev');
      expect(doc.devPath).toBe('abc.dev');
    });
  });
});
