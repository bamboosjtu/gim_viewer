import { describe, expect, it } from 'vitest';
import {
  cbmClassifyNameToGridId,
  gridIdToCbmClassifyName,
  buildCbmGridIdIndex,
  buildStdSldIndex,
  getGridIdByCbmPath,
  getCbmNodesByGridId,
} from '../stdSldIndex.js';
import { parseStd } from '../stdParser.js';
import { parseSld } from '../sldParser.js';
import type { CbmNode } from '../types.js';

// ===== 转换函数 =====

describe('cbmClassifyNameToGridId', () => {
  it('标准 CBM SYSCLASSIFYNAME → gridId（首位 0 替换为 A）', () => {
    expect(cbmClassifyNameToGridId('0AEC*002')).toBe('A0AEC*002');
    expect(cbmClassifyNameToGridId('0ATA*240')).toBe('A0ATA*240');
    expect(cbmClassifyNameToGridId('0AFD*001')).toBe('A0AFD*001');
  });

  it('无 * 的值原样返回（避免污染 entityName）', () => {
    expect(cbmClassifyNameToGridId('PARTINDEX')).toBe('PARTINDEX');
    expect(cbmClassifyNameToGridId('F4System')).toBe('F4System');
  });

  it('空字符串返回空字符串', () => {
    expect(cbmClassifyNameToGridId('')).toBe('');
  });

  it('不以 0 开头的值原样返回', () => {
    expect(cbmClassifyNameToGridId('1AEC*002')).toBe('1AEC*002');
    expect(cbmClassifyNameToGridId('A0AEC*002')).toBe('A0AEC*002');
  });
});

describe('gridIdToCbmClassifyName', () => {
  it('标准 gridId → CBM SYSCLASSIFYNAME（去前缀 A）', () => {
    expect(gridIdToCbmClassifyName('A0AEC*002')).toBe('0AEC*002');
    expect(gridIdToCbmClassifyName('A0ATA*240')).toBe('0ATA*240');
  });

  it('不以 A0 开头的 gridId 原样返回（如 GSK 子组）', () => {
    expect(gridIdToCbmClassifyName('A0AEC*002GSK*010')).toBe('A0AEC*002GSK*010');
  });

  it('空字符串返回空字符串', () => {
    expect(gridIdToCbmClassifyName('')).toBe('');
  });
});

// ===== buildCbmGridIdIndex =====

describe('buildCbmGridIdIndex', () => {
  function makeNode(path: string, classifyName: string, children: CbmNode[] = []): CbmNode {
    return {
      path,
      name: path,
      entityName: 'F4System',
      children,
      famPath: '',
      devPath: '',
      ifcFile: '',
      ifcGuid: '',
      classifyName,
      transformMatrix: '',
      systemNames: [],
      devSymbolName: '',
      devType: '',
      devExpanded: false,
    };
  }

  it('遍历 CBM 树构建 gridId → CbmNode[] 索引', () => {
    const tree = makeNode('CBM/root.cbm', '0', [
      makeNode('CBM/child1.cbm', '0AEC*002'),
      makeNode('CBM/child2.cbm', '0ATA*240'),
    ]);
    const { cbmByGridId, gridIdByCbmPath } = buildCbmGridIdIndex(tree);
    expect(cbmByGridId.size).toBe(2);
    expect(cbmByGridId.get('A0AEC*002')!).toHaveLength(1);
    expect(cbmByGridId.get('A0AEC*002')![0].path).toBe('CBM/child1.cbm');
    expect(cbmByGridId.get('A0ATA*240')![0].path).toBe('CBM/child2.cbm');
    expect(gridIdByCbmPath.get('CBM/child1.cbm')).toBe('A0AEC*002');
  });

  it('同一 gridId 对应多个 CBM 节点', () => {
    const tree = makeNode('CBM/root.cbm', '0', [
      makeNode('CBM/a.cbm', '0AEC*002'),
      makeNode('CBM/b.cbm', '0AEC*002'), // 相同 gridId
      makeNode('CBM/c.cbm', '0ATA*240'),
    ]);
    const { cbmByGridId } = buildCbmGridIdIndex(tree);
    expect(cbmByGridId.get('A0AEC*002')).toHaveLength(2);
    expect(cbmByGridId.get('A0ATA*240')).toHaveLength(1);
  });

  it('无 * 的 classifyName 不进入索引', () => {
    const tree = makeNode('CBM/root.cbm', 'PARTINDEX');
    const { cbmByGridId, gridIdByCbmPath } = buildCbmGridIdIndex(tree);
    expect(cbmByGridId.size).toBe(0);
    expect(gridIdByCbmPath.size).toBe(0);
  });

  it('null 树返回空索引', () => {
    const { cbmByGridId, gridIdByCbmPath } = buildCbmGridIdIndex(null);
    expect(cbmByGridId.size).toBe(0);
    expect(gridIdByCbmPath.size).toBe(0);
  });
});

// ===== buildStdSldIndex 集成测试 =====

describe('buildStdSldIndex', () => {
  const STD_XML = `<?xml version="1.0"?>
<STD version="DLT1" revision="2023">
  <Substation>
    <VoltageLevel name="AE">
      <Group name="GSK10" gridId="A0AEC*002GSK*010" type="multiequipment" />
      <Bay name="C2" gridId="A0AEC*002">
        <ConductingEquipment name="避雷器" gridId="" type="SAR" virtual="true" />
        <ConductingEquipment name="GFA1" gridId="A0ATA*240GFA*001" type="PTR" virtual="false" />
      </Bay>
      <Bay name="A240" gridId="A0ATA*240" />
    </VoltageLevel>
  </Substation>
</STD>`;

  const SLD_SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs><symbol id="sym1"><circle r="1"/></symbol></defs>
  <g gridId="A0AEC*002" type="Bay"><use xlink:href="#sym1"/></g>
  <g gridId="A0AEC*002GSK*010" type="Group"><use xlink:href="#sym1"/></g>
  <g gridId="A0ATA*240" type="Bay"><use xlink:href="#sym1"/></g>
  <g gridId="A0ATA*240GFA*001" type="ConductingEquipment"><use xlink:href="#sym1"/></g>
</svg>`;

  const SLD_SVG_MISSING_BAY = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs><symbol id="sym1"><circle r="1"/></symbol></defs>
  <g gridId="A0AEC*002" type="Bay"><use xlink:href="#sym1"/></g>
  <g gridId="A0AEC*002GSK*010" type="Group"><use xlink:href="#sym1"/></g>
  <g gridId="A0ATA*240GFA*001" type="ConductingEquipment"><use xlink:href="#sym1"/></g>
</svg>`;

  function makeCbmNode(path: string, classifyName: string): CbmNode {
    return {
      path,
      name: path,
      entityName: 'F4System',
      children: [],
      famPath: '',
      devPath: '',
      ifcFile: '',
      ifcGuid: '',
      classifyName,
      transformMatrix: '',
      systemNames: [],
      devSymbolName: '',
      devType: '',
      devExpanded: false,
    };
  }

  it('STD/SLD gridId 一一对应，stdOnlyGridIds 为空', () => {
    const stdDoc = parseStd(STD_XML);
    const sldDoc = parseSld(SLD_SVG);
    const index = buildStdSldIndex(null, stdDoc, sldDoc);
    expect(index.stdOnlyGridIds).toHaveLength(0);
    expect(index.sldOnlyGridIds).toHaveLength(0);
  });

  it('STD 中 virtual=true 的设备缺失 SLD 不计入 stdOnlyGridIds', () => {
    // virtual=true 的避雷器 gridId="" 本就不进入索引
    const stdDoc = parseStd(STD_XML);
    const emptySld = parseSld('<svg/>');
    const index = buildStdSldIndex(null, stdDoc, emptySld);
    // 4 个非空 gridId 中，避雷器 gridId="" 不进入索引
    // 实际索引中：A0AEC*002GSK*010 + A0AEC*002 + A0ATA*240GFA*001 + A0ATA*240 = 4
    // 全部非虚拟，所以 stdOnlyGridIds 应有 4 个
    expect(index.stdOnlyGridIds).toHaveLength(4);
    expect(index.stdOnlyGridIds).toContain('A0AEC*002');
    expect(index.stdOnlyGridIds).toContain('A0ATA*240');
  });

  it('SLD 缺失部分 Bay 时仅记录缺失项', () => {
    const stdDoc = parseStd(STD_XML);
    const sldDoc = parseSld(SLD_SVG_MISSING_BAY);
    const index = buildStdSldIndex(null, stdDoc, sldDoc);
    // STD 有 4 个 gridId，SLD 有 3 个，缺失 A0ATA*240
    expect(index.stdOnlyGridIds).toHaveLength(1);
    expect(index.stdOnlyGridIds).toContain('A0ATA*240');
  });

  it('SLD 有图但 STD 无拓扑定义时计入 sldOnlyGridIds', () => {
    const stdDoc = parseStd(STD_XML);
    const sldDoc = parseSld(`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg">
  <g gridId="A0UNKNOWN*001" type="Bay"/>
</svg>`);
    const index = buildStdSldIndex(null, stdDoc, sldDoc);
    expect(index.sldOnlyGridIds).toContain('A0UNKNOWN*001');
  });

  it('CBM 树与 STD/SLD 通过 gridId 关联', () => {
    const cbmRoot: CbmNode = {
      ...makeCbmNode('CBM/root.cbm', ''),
      children: [
        makeCbmNode('CBM/c2.cbm', '0AEC*002'),
        makeCbmNode('CBM/a240.cbm', '0ATA*240'),
      ],
    };
    const stdDoc = parseStd(STD_XML);
    const sldDoc = parseSld(SLD_SVG);
    const index = buildStdSldIndex(cbmRoot, stdDoc, sldDoc);

    // CBM 节点通过 classifyName 转换为 gridId 后能查到
    const c2Nodes = getCbmNodesByGridId(index, 'A0AEC*002');
    expect(c2Nodes).toHaveLength(1);
    expect(c2Nodes[0].path).toBe('CBM/c2.cbm');

    // 反向：CBM path → gridId
    expect(getGridIdByCbmPath(index, 'CBM/c2.cbm')).toBe('A0AEC*002');
    expect(getGridIdByCbmPath(index, 'CBM/a240.cbm')).toBe('A0ATA*240');
  });

  it('三个索引独立处理 null 输入', () => {
    const index = buildStdSldIndex(null, null, null);
    expect(index.stdByGridId.size).toBe(0);
    expect(index.sldByGridId.size).toBe(0);
    expect(index.cbmByGridId.size).toBe(0);
    expect(index.stdOnlyGridIds).toHaveLength(0);
    expect(index.sldOnlyGridIds).toHaveLength(0);
  });
});

// ===== 反向查询 =====

describe('getGridIdByCbmPath / getCbmNodesByGridId', () => {
  it('未匹配返回空字符串/空数组', () => {
    const index = buildStdSldIndex(null, null, null);
    expect(getGridIdByCbmPath(index, 'CBM/missing.cbm')).toBe('');
    expect(getCbmNodesByGridId(index, 'A0UNKNOWN*001')).toEqual([]);
  });
});
