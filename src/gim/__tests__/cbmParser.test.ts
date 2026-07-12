import { describe, expect, it } from 'vitest';
import {
  parseKeyValue,
  buildCbmTree,
  buildCbmNodeIndex,
  collectIfcRefs,
} from '../cbmParser.js';
import type { CbmNode } from '../types.js';

function textFile(text: string, name: string): File {
  return new File([text], name, { type: 'text/plain' });
}

// ===== parseKeyValue =====

describe('parseKeyValue', () => {
  it('解析标准 KEY=VALUE 格式', () => {
    const result = parseKeyValue('ENTITYNAME=F1System\nSUBSYSTEM=area.cbm');
    expect(result['ENTITYNAME']).toBe('F1System');
    expect(result['SUBSYSTEM']).toBe('area.cbm');
  });

  it('空字符串返回空对象', () => {
    expect(parseKeyValue('')).toEqual({});
  });

  it('忽略空行和无效行', () => {
    const result = parseKeyValue('\n\nKEY=val\n\n=noval\nvalonly\n');
    expect(result['KEY']).toBe('val');
    expect(Object.keys(result)).toHaveLength(1);
  });

  it('VALUE 中含等号也能正确解析', () => {
    const result = parseKeyValue('FORMULA=a=b+c');
    expect(result['FORMULA']).toBe('a=b+c');
  });

  it('trim 键值两端空白', () => {
    const result = parseKeyValue('  KEY  =  value  ');
    expect(result['KEY']).toBe('value');
  });

  it('支持 \\r\\n 换行', () => {
    const result = parseKeyValue('KEY1=val1\r\nKEY2=val2\r\n');
    expect(result['KEY1']).toBe('val1');
    expect(result['KEY2']).toBe('val2');
  });

  it('重复键后者覆盖前者', () => {
    const result = parseKeyValue('KEY=first\nKEY=second');
    expect(result['KEY']).toBe('second');
  });

  it('等号在行首（idx=0）的行被忽略', () => {
    const result = parseKeyValue('=value\nKEY=val');
    expect(result['KEY']).toBe('val');
    expect(result['']).toBeUndefined();
  });
});

// ===== buildCbmTree 基础结构 =====

describe('buildCbmTree 基础结构', () => {
  it('无 CBM/project.cbm 返回 null', async () => {
    const files = new Map<string, File>([
      ['CBM/other.cbm', textFile('ENTITYNAME=F1System', 'other.cbm')],
    ]);
    expect(await buildCbmTree(files)).toBeNull();
  });

  it('空文件集合返回 null', async () => {
    expect(await buildCbmTree(new Map())).toBeNull();
  });

  it('解析 F1System 根节点并使用 projectTypeName 覆盖名称', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SYSTEMNAME1=原始名称`, 'project.cbm')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree).not.toBeNull();
    expect(tree!.entityName).toBe('F1System');
    expect(tree!.name).toBe('变电工程');
  });

  it('无 projectTypeName 时 F1System 使用 SYSTEMNAME 拼接', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SYSTEMNAME1=全站级
SYSTEMNAME2=区域A`, 'project.cbm')],
    ]);
    const tree = await buildCbmTree(files);
    expect(tree!.name).toBe('全站级 / 区域A');
  });

  it('SYSTEMNAME 占位符被过滤', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SYSTEMNAME1=有效名称
SYSTEMNAME2=其它
SYSTEMNAME3=-
SYSTEMNAME4=其他`, 'project.cbm')],
    ]);
    const tree = await buildCbmTree(files);
    expect(tree!.name).toBe('有效名称');
    expect(tree!.systemNames).toEqual(['有效名称']);
  });

  it('全部 SYSTEMNAME 为占位符时回退到 PARTNAME', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SYSTEMNAME1=-
SYSTEMNAME2=其它
PARTNAME=部件名称`, 'project.cbm')],
    ]);
    const tree = await buildCbmTree(files);
    expect(tree!.name).toBe('部件名称');
  });

  it('无 SYSTEMNAME 和 PARTNAME 时回退到 SYSCLASSIFYNAME', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SYSCLASSIFYNAME=0AFD*002`, 'project.cbm')],
    ]);
    const tree = await buildCbmTree(files);
    expect(tree!.name).toBe('0AFD*002');
  });

  it('无 SYSTEMNAME/PARTNAME/SYSCLASSIFYNAME 时回退到 ENTITYNAME', async () => {
    // 回退链：SYSTEMNAME → PARTNAME → SYSCLASSIFYNAME → ENTITYNAME → 文件名
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile('ENTITYNAME=F1System', 'project.cbm')],
    ]);
    const tree = await buildCbmTree(files);
    expect(tree!.name).toBe('F1System');
  });

  it('完全无名称字段时回退到文件名（去 .cbm 后缀）', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile('SOMEKEY=val', 'project.cbm')],
    ]);
    const tree = await buildCbmTree(files);
    expect(tree!.name).toBe('project');
  });
});

// ===== buildCbmTree 子节点引用 =====

describe('buildCbmTree 子节点引用', () => {
  it('SUBSYSTEM 单值引用', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=child.cbm`, 'project.cbm')],
      ['CBM/child.cbm', textFile('ENTITYNAME=F3System\nSYSTEMNAME1=子节点', 'child.cbm')],
    ]);
    const tree = await buildCbmTree(files);
    expect(tree!.children).toHaveLength(1);
    expect(tree!.children[0].name).toBe('子节点');
  });

  it('SUBSYSTEMS.NUM + SUBSYSTEMi 数组引用', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEMS.NUM=2
SUBSYSTEM0=c1.cbm
SUBSYSTEM1=c2.cbm`, 'project.cbm')],
      ['CBM/c1.cbm', textFile('ENTITYNAME=F3System\nSYSTEMNAME1=子1', 'c1.cbm')],
      ['CBM/c2.cbm', textFile('ENTITYNAME=F3System\nSYSTEMNAME1=子2', 'c2.cbm')],
    ]);
    const tree = await buildCbmTree(files);
    expect(tree!.children).toHaveLength(2);
    expect(tree!.children[0].name).toBe('子1');
    expect(tree!.children[1].name).toBe('子2');
  });

  it('SUBSYSTEMS.NUM=0 时不产生子节点', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEMS.NUM=0`, 'project.cbm')],
    ]);
    const tree = await buildCbmTree(files);
    expect(tree!.children).toHaveLength(0);
  });

  it('SUBDEVICES.NUM + SUBDEVICEi 引用（F4System 内部子设备）', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=dev.cbm`, 'project.cbm')],
      ['CBM/dev.cbm', textFile(
        `ENTITYNAME=F4System
SUBDEVICES.NUM=1
SUBDEVICE0=sub.cbm`, 'dev.cbm')],
      ['CBM/sub.cbm', textFile('ENTITYNAME=F4System\nSYSTEMNAME1=子设备', 'sub.cbm')],
    ]);
    const tree = await buildCbmTree(files);
    expect(tree!.children[0].children).toHaveLength(1);
    expect(tree!.children[0].children[0].name).toBe('子设备');
  });

  it('循环引用防护：A→B→A 不无限递归', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=a.cbm`, 'project.cbm')],
      ['CBM/a.cbm', textFile(
        `ENTITYNAME=F3System
SUBSYSTEM=b.cbm`, 'a.cbm')],
      ['CBM/b.cbm', textFile(
        `ENTITYNAME=F3System
SUBSYSTEM=a.cbm`, 'b.cbm')],
    ]);
    const tree = await buildCbmTree(files);
    expect(tree).not.toBeNull();
    // a.cbm 被 visited，b.cbm 正常构建但 b→a 返回 null
    // tree → a → b（b.children 为空，因为 a.cbm 已 visited）
    expect(tree!.children[0].children).toHaveLength(1); // a → b
    expect(tree!.children[0].children[0].children).toHaveLength(0); // b → (a blocked)
  });

  it('引用不存在的 CBM 文件时跳过', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEMS.NUM=2
SUBSYSTEM0=exists.cbm
SUBSYSTEM1=missing.cbm`, 'project.cbm')],
      ['CBM/exists.cbm', textFile('ENTITYNAME=F3System\nSYSTEMNAME1=存在', 'exists.cbm')],
    ]);
    const tree = await buildCbmTree(files);
    expect(tree!.children).toHaveLength(1);
    expect(tree!.children[0].name).toBe('存在');
  });
});

// ===== buildCbmTree F2System 分类映射 =====

describe('buildCbmTree F2System 分类映射', () => {
  it('F2System SYSCLASSIFYNAME=U → 建筑工程', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=f2.cbm`, 'project.cbm')],
      ['CBM/f2.cbm', textFile(
        `ENTITYNAME=F2System
SYSCLASSIFYNAME=U`, 'f2.cbm')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree!.children[0].name).toBe('建筑工程');
  });

  it('F2System SYSCLASSIFYNAME=A → 安装工程', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=f2.cbm`, 'project.cbm')],
      ['CBM/f2.cbm', textFile(
        `ENTITYNAME=F2System
SYSCLASSIFYNAME=A`, 'f2.cbm')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree!.children[0].name).toBe('安装工程');
  });

  it('F2System SYSCLASSIFYNAME=S → 暖通工程', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=f2.cbm`, 'project.cbm')],
      ['CBM/f2.cbm', textFile(
        `ENTITYNAME=F2System
SYSCLASSIFYNAME=S`, 'f2.cbm')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree!.children[0].name).toBe('暖通工程');
  });

  it('F2System SYSCLASSIFYNAME=G → 给排水工程', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=f2.cbm`, 'project.cbm')],
      ['CBM/f2.cbm', textFile(
        `ENTITYNAME=F2System
SYSCLASSIFYNAME=G`, 'f2.cbm')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree!.children[0].name).toBe('给排水工程');
  });

  it('F2System 未知分类码保持原名称', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=f2.cbm`, 'project.cbm')],
      ['CBM/f2.cbm', textFile(
        `ENTITYNAME=F2System
SYSTEMNAME1=自定义专业
SYSCLASSIFYNAME=X`, 'f2.cbm')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree!.children[0].name).toBe('自定义专业');
  });

  it('F1System 子节点按 U→A→S→G 顺序排列', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEMS.NUM=4
SUBSYSTEM0=g.cbm
SUBSYSTEM1=s.cbm
SUBSYSTEM2=a.cbm
SUBSYSTEM3=u.cbm`, 'project.cbm')],
      ['CBM/g.cbm', textFile('ENTITYNAME=F2System\nSYSCLASSIFYNAME=G', 'g.cbm')],
      ['CBM/s.cbm', textFile('ENTITYNAME=F2System\nSYSCLASSIFYNAME=S', 's.cbm')],
      ['CBM/a.cbm', textFile('ENTITYNAME=F2System\nSYSCLASSIFYNAME=A', 'a.cbm')],
      ['CBM/u.cbm', textFile('ENTITYNAME=F2System\nSYSCLASSIFYNAME=U', 'u.cbm')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    const names = tree!.children.map((c) => c.name);
    expect(names).toEqual(['建筑工程', '安装工程', '暖通工程', '给排水工程']);
  });
});

// ===== buildCbmTree F4System DEV SYMBOLNAME 回填 =====

describe('buildCbmTree F4System DEV SYMBOLNAME 回填', () => {
  it('F4System 设备层节点名称被 DEV SYMBOLNAME 覆盖', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=dev.cbm`, 'project.cbm')],
      ['CBM/dev.cbm', textFile(
        `ENTITYNAME=F4System
SYSCLASSIFYNAME=CAH*006
OBJECTMODELPOINTER=device.dev`, 'dev.cbm')],
      ['DEV/device.dev', textFile(
        `SYMBOLNAME=断路器
TYPE=OTHERS
SOLIDMODELS.NUM=0`, 'device.dev')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    const devNode = tree!.children[0];
    expect(devNode.name).toBe('断路器');
    expect(devNode.devSymbolName).toBe('断路器');
    expect(devNode.devType).toBe('OTHERS');
  });

  it('DEV 文件不存在时回退到 SYSCLASSIFYNAME', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=dev.cbm`, 'project.cbm')],
      ['CBM/dev.cbm', textFile(
        `ENTITYNAME=F4System
SYSCLASSIFYNAME=CAH*006
OBJECTMODELPOINTER=missing.dev`, 'dev.cbm')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree!.children[0].name).toBe('CAH*006');
  });

  it('DEV SYMBOLNAME 为空时不覆盖原名称', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=dev.cbm`, 'project.cbm')],
      ['CBM/dev.cbm', textFile(
        `ENTITYNAME=F4System
SYSTEMNAME1=原名称
OBJECTMODELPOINTER=device.dev`, 'dev.cbm')],
      ['DEV/device.dev', textFile(
        `SYMBOLNAME=
TYPE=OTHERS
SOLIDMODELS.NUM=0`, 'device.dev')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree!.children[0].name).toBe('原名称');
  });

  it('F3System 非设备层节点不被 DEV SYMBOLNAME 覆盖', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=f3.cbm`, 'project.cbm')],
      ['CBM/f3.cbm', textFile(
        `ENTITYNAME=F3System
SYSTEMNAME1=系统名称
OBJECTMODELPOINTER=device.dev`, 'f3.cbm')],
      ['DEV/device.dev', textFile(
        `SYMBOLNAME=不应被采用
TYPE=OTHERS
SOLIDMODELS.NUM=0`, 'device.dev')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree!.children[0].name).toBe('系统名称');
  });
});

// ===== buildCbmTree F3System enhanceF3Name（方案 B） =====

describe('buildCbmTree F3System enhanceF3Name（方案 B）', () => {
  it('编码类 F3 名称追加 F4 子设备名后缀', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=f3.cbm`, 'project.cbm')],
      ['CBM/f3.cbm', textFile(
        `ENTITYNAME=F3System
SYSCLASSIFYNAME=0SAZ*001
SUBSYSTEMS.NUM=2
SUBSYSTEM0=d1.cbm
SUBSYSTEM1=d2.cbm`, 'f3.cbm')],
      ['CBM/d1.cbm', textFile(
        `ENTITYNAME=F4System
OBJECTMODELPOINTER=dev1.dev`, 'd1.cbm')],
      ['CBM/d2.cbm', textFile(
        `ENTITYNAME=F4System
OBJECTMODELPOINTER=dev2.dev`, 'd2.cbm')],
      ['DEV/dev1.dev', textFile('SYMBOLNAME=断路器\nSOLIDMODELS.NUM=0', 'dev1.dev')],
      ['DEV/dev2.dev', textFile('SYMBOLNAME=隔离开关\nSOLIDMODELS.NUM=0', 'dev2.dev')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    const f3Node = tree!.children[0];
    expect(f3Node.name).toContain('含');
    expect(f3Node.name).toContain('断路器');
    expect(f3Node.name).toContain('隔离开关');
  });

  it('可读性强的 F3 名称不追加后缀', async () => {
    const longName = '交流电气系统 / 110kV系统 / #2主变 110kV进线间隔';
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=f3.cbm`, 'project.cbm')],
      ['CBM/f3.cbm', textFile(
        `ENTITYNAME=F3System
SYSTEMNAME1=交流电气系统
SYSTEMNAME2=110kV系统
SYSTEMNAME3=#2主变 110kV进线间隔
SUBSYSTEMS.NUM=1
SUBSYSTEM0=d1.cbm`, 'f3.cbm')],
      ['CBM/d1.cbm', textFile(
        `ENTITYNAME=F4System
OBJECTMODELPOINTER=dev1.dev`, 'd1.cbm')],
      ['DEV/dev1.dev', textFile('SYMBOLNAME=断路器\nSOLIDMODELS.NUM=0', 'dev1.dev')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree!.children[0].name).toBe(longName);
    expect(tree!.children[0].name).not.toContain('含');
  });

  it('超过 3 个子设备时后缀以"等"结尾', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=f3.cbm`, 'project.cbm')],
      ['CBM/f3.cbm', textFile(
        `ENTITYNAME=F3System
SYSCLASSIFYNAME=0SAZ*001
SUBSYSTEMS.NUM=4
SUBSYSTEM0=d1.cbm
SUBSYSTEM1=d2.cbm
SUBSYSTEM2=d3.cbm
SUBSYSTEM3=d4.cbm`, 'f3.cbm')],
      ['CBM/d1.cbm', textFile('ENTITYNAME=F4System\nOBJECTMODELPOINTER=v1.dev', 'd1.cbm')],
      ['CBM/d2.cbm', textFile('ENTITYNAME=F4System\nOBJECTMODELPOINTER=v2.dev', 'd2.cbm')],
      ['CBM/d3.cbm', textFile('ENTITYNAME=F4System\nOBJECTMODELPOINTER=v3.dev', 'd3.cbm')],
      ['CBM/d4.cbm', textFile('ENTITYNAME=F4System\nOBJECTMODELPOINTER=v4.dev', 'd4.cbm')],
      ['DEV/v1.dev', textFile('SYMBOLNAME=设备A\nSOLIDMODELS.NUM=0', 'v1.dev')],
      ['DEV/v2.dev', textFile('SYMBOLNAME=设备B\nSOLIDMODELS.NUM=0', 'v2.dev')],
      ['DEV/v3.dev', textFile('SYMBOLNAME=设备C\nSOLIDMODELS.NUM=0', 'v3.dev')],
      ['DEV/v4.dev', textFile('SYMBOLNAME=设备D\nSOLIDMODELS.NUM=0', 'v4.dev')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    const name = tree!.children[0].name;
    expect(name).toContain('设备A');
    expect(name).toContain('设备B');
    expect(name).toContain('设备C');
    expect(name).not.toContain('设备D');
    expect(name).toContain('等');
  });

  it('无子设备时不追加后缀', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=f3.cbm`, 'project.cbm')],
      ['CBM/f3.cbm', textFile(
        `ENTITYNAME=F3System
SYSCLASSIFYNAME=0SAZ*001`, 'f3.cbm')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree!.children[0].name).toBe('0SAZ*001');
    expect(tree!.children[0].name).not.toContain('含');
  });

  it('子设备无 SYMBOLNAME 时回退到 IFC 文件名', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=f3.cbm`, 'project.cbm')],
      ['CBM/f3.cbm', textFile(
        `ENTITYNAME=F3System
SYSCLASSIFYNAME=0SAZ*001
SUBSYSTEMS.NUM=1
SUBSYSTEM0=d1.cbm`, 'f3.cbm')],
      ['CBM/d1.cbm', textFile(
        `ENTITYNAME=F4System
IFCFILE=model.ifc
IFCGUID=abc123`, 'd1.cbm')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    const name = tree!.children[0].name;
    expect(name).toContain('model');
  });
});

// ===== buildCbmTree IFC 引用和字段解析 =====

describe('buildCbmTree IFC 引用和字段解析', () => {
  it('IFCFILE 和 IFCGUID 正确解析', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F4System
IFCFILE=device.ifc
IFCGUID=3xS9BCV29ByxfxRyi9$q2$$`, 'project.cbm')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree!.ifcFile).toBe('device.ifc');
    // $ 后缀被 trim
    expect(tree!.ifcGuid).toBe('3xS9BCV29ByxfxRyi9$q2');
  });

  it('BASEFAMILY 和 TRANSFORMMATRIX 正确解析', async () => {
    const matrix = '1,0,0,0,0,1,0,0,0,0,1,0,100,200,300,1';
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F4System
BASEFAMILY=fam001.fam
TRANSFORMMATRIX=${matrix}`, 'project.cbm')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree!.famPath).toBe('fam001.fam');
    expect(tree!.transformMatrix).toBe(matrix);
  });

  it('无 IFC 引用时 ifcFile 和 ifcGuid 为空', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile('ENTITYNAME=F1System', 'project.cbm')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree!.ifcFile).toBe('');
    expect(tree!.ifcGuid).toBe('');
  });
});

// ===== buildCbmTree DEV SUBDEVICES expansion（原有用例保留） =====

describe('buildCbmTree DEV SUBDEVICES expansion', () => {
  it('gives repeated child DEV instances unique virtual paths and preserves each local matrix', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(`ENTITYNAME=F1System
SUBSYSTEM=root.cbm`, 'project.cbm')],
      ['CBM/root.cbm', textFile(`ENTITYNAME=F4System
OBJECTMODELPOINTER=parent.dev`, 'root.cbm')],
      ['DEV/parent.dev', textFile(`SYMBOLNAME=Parent
TYPE=ParentType
SUBDEVICES.NUM=2
SUBDEVICE0=child.dev
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,100,0,0,1
SUBDEVICE1=child.dev
TRANSFORMMATRIX1=1,0,0,0,0,1,0,0,0,0,1,0,200,0,0,1
SOLIDMODELS.NUM=0`, 'parent.dev')],
      ['DEV/child.dev', textFile(`SYMBOLNAME=Child
TYPE=ChildType
SUBDEVICES.NUM=0
SOLIDMODELS.NUM=0`, 'child.dev')],
    ]);

    const tree = await buildCbmTree(files, '变电工程');
    const rootDevice = tree?.children[0];
    expect(rootDevice?.children).toHaveLength(2);

    const [first, second] = rootDevice!.children;
    expect(first.path).toContain('#dev:0:child.dev');
    expect(second.path).toContain('#dev:1:child.dev');
    expect(first.path).not.toBe(second.path);
    expect(first.transformMatrix.split(',').map(Number)[12]).toBe(100);
    expect(second.transformMatrix.split(',').map(Number)[12]).toBe(200);
  });

  it('DEV SUBDEVICES 虚拟子节点使用 SYMBOLNAME 作为名称', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=root.cbm`, 'project.cbm')],
      ['CBM/root.cbm', textFile(
        `ENTITYNAME=F4System
OBJECTMODELPOINTER=parent.dev`, 'root.cbm')],
      ['DEV/parent.dev', textFile(
        `SYMBOLNAME=Parent
SUBDEVICES.NUM=1
SUBDEVICE0=child.dev
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
SOLIDMODELS.NUM=0`, 'parent.dev')],
      ['DEV/child.dev', textFile(
        `SYMBOLNAME=子设备名
SUBDEVICES.NUM=0
SOLIDMODELS.NUM=0`, 'child.dev')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    const subDevice = tree!.children[0].children[0];
    expect(subDevice.name).toBe('子设备名');
    expect(subDevice.entityName).toBe('DEV_SUBDEVICE');
    expect(subDevice.devSymbolName).toBe('子设备名');
  });

  it('DEV SUBDEVICES 无 SYMBOLNAME 时回退到 TYPE', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=root.cbm`, 'project.cbm')],
      ['CBM/root.cbm', textFile(
        `ENTITYNAME=F4System
OBJECTMODELPOINTER=parent.dev`, 'root.cbm')],
      ['DEV/parent.dev', textFile(
        `SUBDEVICES.NUM=1
SUBDEVICE0=child.dev
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
SOLIDMODELS.NUM=0`, 'parent.dev')],
      ['DEV/child.dev', textFile(
        `TYPE=ChildType
SUBDEVICES.NUM=0
SOLIDMODELS.NUM=0`, 'child.dev')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    const subDevice = tree!.children[0].children[0];
    expect(subDevice.name).toBe('ChildType');
  });

  it('DEV SUBDEVICES 无 SYMBOLNAME 和 TYPE 时回退到 dev 文件名', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=root.cbm`, 'project.cbm')],
      ['CBM/root.cbm', textFile(
        `ENTITYNAME=F4System
OBJECTMODELPOINTER=parent.dev`, 'root.cbm')],
      ['DEV/parent.dev', textFile(
        `SUBDEVICES.NUM=1
SUBDEVICE0=child.dev
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
SOLIDMODELS.NUM=0`, 'parent.dev')],
      ['DEV/child.dev', textFile(
        `SUBDEVICES.NUM=0
SOLIDMODELS.NUM=0`, 'child.dev')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    const subDevice = tree!.children[0].children[0];
    expect(subDevice.name).toBe('child');
  });

  it('DEV 文件不存在时不产生虚拟子节点', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(
        `ENTITYNAME=F1System
SUBSYSTEM=root.cbm`, 'project.cbm')],
      ['CBM/root.cbm', textFile(
        `ENTITYNAME=F4System
OBJECTMODELPOINTER=missing.dev`, 'root.cbm')],
    ]);
    const tree = await buildCbmTree(files, '变电工程');
    expect(tree!.children[0].children).toHaveLength(0);
    expect(tree!.children[0].devExpanded).toBe(false);
  });
});

// ===== buildCbmNodeIndex =====

describe('buildCbmNodeIndex', () => {
  it('构建 cbmFileName → CbmNode 索引', () => {
    const root: CbmNode = {
      path: 'CBM/project.cbm', name: 'root', entityName: 'F1System',
      children: [
        { path: 'CBM/child1.cbm', name: 'c1', entityName: 'F3System',
          children: [], famPath: '', devPath: '', ifcFile: '', ifcGuid: '',
          classifyName: '', transformMatrix: '', systemNames: [],
          devSymbolName: '', devType: '', devExpanded: false },
        { path: 'CBM/child2.cbm', name: 'c2', entityName: 'F3System',
          children: [], famPath: '', devPath: '', ifcFile: '', ifcGuid: '',
          classifyName: '', transformMatrix: '', systemNames: [],
          devSymbolName: '', devType: '', devExpanded: false },
      ],
      famPath: '', devPath: '', ifcFile: '', ifcGuid: '',
      classifyName: '', transformMatrix: '', systemNames: [],
      devSymbolName: '', devType: '', devExpanded: false,
    };
    const index = buildCbmNodeIndex(root);
    expect(index.size).toBe(3);
    expect(index.has('project.cbm')).toBe(true);
    expect(index.has('child1.cbm')).toBe(true);
    expect(index.has('child2.cbm')).toBe(true);
  });

  it('null 节点返回空 Map', () => {
    expect(buildCbmNodeIndex(null).size).toBe(0);
  });

  it('嵌套 3 层节点全部索引', () => {
    const root: CbmNode = {
      path: 'CBM/a.cbm', name: 'a', entityName: 'F1System',
      children: [{
        path: 'CBM/b.cbm', name: 'b', entityName: 'F2System',
        children: [{
          path: 'CBM/c.cbm', name: 'c', entityName: 'F3System',
          children: [], famPath: '', devPath: '', ifcFile: '', ifcGuid: '',
          classifyName: '', transformMatrix: '', systemNames: [],
          devSymbolName: '', devType: '', devExpanded: false,
        }],
        famPath: '', devPath: '', ifcFile: '', ifcGuid: '',
        classifyName: '', transformMatrix: '', systemNames: [],
        devSymbolName: '', devType: '', devExpanded: false,
      }],
      famPath: '', devPath: '', ifcFile: '', ifcGuid: '',
      classifyName: '', transformMatrix: '', systemNames: [],
      devSymbolName: '', devType: '', devExpanded: false,
    };
    const index = buildCbmNodeIndex(root);
    expect(index.size).toBe(3);
    expect(index.get('c.cbm')?.name).toBe('c');
  });
});

// ===== collectIfcRefs =====

describe('collectIfcRefs', () => {
  it('收集节点及其后代的 IFC 引用', () => {
    const root: CbmNode = {
      path: 'CBM/root.cbm', name: 'root', entityName: 'F1System',
      children: [
        { path: 'CBM/a.cbm', name: 'a', entityName: 'F4System',
          children: [], famPath: '', devPath: '', ifcFile: 'model1.ifc', ifcGuid: 'guid-001',
          classifyName: '', transformMatrix: '', systemNames: [],
          devSymbolName: '', devType: '', devExpanded: false },
        { path: 'CBM/b.cbm', name: 'b', entityName: 'F4System',
          children: [], famPath: '', devPath: '', ifcFile: 'model1.ifc', ifcGuid: 'guid-002',
          classifyName: '', transformMatrix: '', systemNames: [],
          devSymbolName: '', devType: '', devExpanded: false },
        { path: 'CBM/c.cbm', name: 'c', entityName: 'F4System',
          children: [], famPath: '', devPath: '', ifcFile: 'model2.ifc', ifcGuid: 'guid-003',
          classifyName: '', transformMatrix: '', systemNames: [],
          devSymbolName: '', devType: '', devExpanded: false },
      ],
      famPath: '', devPath: '', ifcFile: '', ifcGuid: '',
      classifyName: '', transformMatrix: '', systemNames: [],
      devSymbolName: '', devType: '', devExpanded: false,
    };
    const refs = collectIfcRefs(root);
    expect(refs.size).toBe(2);
    expect(refs.get('model1')!.has('guid-001')).toBe(true);
    expect(refs.get('model1')!.has('guid-002')).toBe(true);
    expect(refs.get('model2')!.has('guid-003')).toBe(true);
  });

  it('无 IFC 引用时返回空 Map', () => {
    const root: CbmNode = {
      path: 'CBM/root.cbm', name: 'root', entityName: 'F1System',
      children: [],
      famPath: '', devPath: '', ifcFile: '', ifcGuid: '',
      classifyName: '', transformMatrix: '', systemNames: [],
      devSymbolName: '', devType: '', devExpanded: false,
    };
    expect(collectIfcRefs(root).size).toBe(0);
  });

  it('ifcFile 有值但 ifcGuid 为空时不收集', () => {
    const root: CbmNode = {
      path: 'CBM/root.cbm', name: 'root', entityName: 'F4System',
      children: [],
      famPath: '', devPath: '', ifcFile: 'model.ifc', ifcGuid: '',
      classifyName: '', transformMatrix: '', systemNames: [],
      devSymbolName: '', devType: '', devExpanded: false,
    };
    expect(collectIfcRefs(root).size).toBe(0);
  });

  it('ifcGuid 有值但 ifcFile 为空时不收集', () => {
    const root: CbmNode = {
      path: 'CBM/root.cbm', name: 'root', entityName: 'F4System',
      children: [],
      famPath: '', devPath: '', ifcFile: '', ifcGuid: 'guid-001',
      classifyName: '', transformMatrix: '', systemNames: [],
      devSymbolName: '', devType: '', devExpanded: false,
    };
    expect(collectIfcRefs(root).size).toBe(0);
  });

  it('IFC 文件名 .ifc 后缀被去除作为 modelId', () => {
    const root: CbmNode = {
      path: 'CBM/root.cbm', name: 'root', entityName: 'F4System',
      children: [],
      famPath: '', devPath: '', ifcFile: 'test.IFC', ifcGuid: 'guid',
      classifyName: '', transformMatrix: '', systemNames: [],
      devSymbolName: '', devType: '', devExpanded: false,
    };
    const refs = collectIfcRefs(root);
    expect(refs.has('test')).toBe(true);
  });

  it('嵌套 3 层节点的 IFC 引用全部收集', () => {
    const root: CbmNode = {
      path: 'CBM/a.cbm', name: 'a', entityName: 'F1System',
      children: [{
        path: 'CBM/b.cbm', name: 'b', entityName: 'F3System',
        children: [{
          path: 'CBM/c.cbm', name: 'c', entityName: 'F4System',
          children: [], famPath: '', devPath: '', ifcFile: 'deep.ifc', ifcGuid: 'deep-guid',
          classifyName: '', transformMatrix: '', systemNames: [],
          devSymbolName: '', devType: '', devExpanded: false,
        }],
        famPath: '', devPath: '', ifcFile: 'mid.ifc', ifcGuid: 'mid-guid',
        classifyName: '', transformMatrix: '', systemNames: [],
        devSymbolName: '', devType: '', devExpanded: false,
      }],
      famPath: '', devPath: '', ifcFile: 'top.ifc', ifcGuid: 'top-guid',
      classifyName: '', transformMatrix: '', systemNames: [],
      devSymbolName: '', devType: '', devExpanded: false,
    };
    const refs = collectIfcRefs(root);
    expect(refs.size).toBe(3);
    expect(refs.get('top')!.has('top-guid')).toBe(true);
    expect(refs.get('mid')!.has('mid-guid')).toBe(true);
    expect(refs.get('deep')!.has('deep-guid')).toBe(true);
  });
});
