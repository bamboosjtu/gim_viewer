import { describe, expect, it } from 'vitest';
import { parseStd } from '../stdParser.js';

const SAMPLE_STD = `<?xml version="1.0"?>
<STD version="DLT1" revision="2023">
  <Substation name="" desc="">
    <VoltageLevel name="AE" desc="220 kV">
      <Voltage multiplier="k" unit="V">220</Voltage>
      <Group name="GSK10" desc="AEC2组合电器GIS" gridId="A0AEC*002GSK*010" type="multiequipment" />
      <Bay name="C2" desc="7E出线间隔" gridId="A0AEC*002">
        <ConductingEquipment name="13.避雷器" desc="避雷器描述" gridId="" groupGridId="A0AEC*002GSK*010" type="SAR" virtual="true" />
        <ConductingEquipment name="GFA1" desc="主变有载调压设备" gridId="A0ATA*240GFA*001" type="PTR" virtual="false">
          <Parameter name="" desc="设备名称" dimension="">主变压器</Parameter>
          <Parameter name="" desc="额定电流" dimension="">4000A</Parameter>
        </ConductingEquipment>
      </Bay>
      <Bay name="A240" desc="2号备用主变" gridId="A0ATA*240">
        <ConductingEquipment name="GFA1" gridId="A0ATA*240GFA*001" type="PTR" virtual="false" />
      </Bay>
    </VoltageLevel>
  </Substation>
</STD>`;

describe('parseStd', () => {
  it('解析 demo 样本：DLT1/2023 版本', () => {
    const doc = parseStd(SAMPLE_STD);
    expect(doc.version).toBe('DLT1');
    expect(doc.revision).toBe('2023');
    expect(doc.substation).not.toBeNull();
  });

  it('解析 VoltageLevel 电压字段', () => {
    const doc = parseStd(SAMPLE_STD);
    const vl = doc.substation!.voltageLevels[0];
    expect(vl.name).toBe('AE');
    expect(vl.desc).toBe('220 kV');
    expect(vl.voltage).toBe(220);
    expect(vl.voltageMultiplier).toBe('k');
    expect(vl.voltageUnit).toBe('V');
  });

  it('解析 Bay 列表', () => {
    const doc = parseStd(SAMPLE_STD);
    const vl = doc.substation!.voltageLevels[0];
    expect(vl.bays).toHaveLength(2);
    expect(vl.bays[0].name).toBe('C2');
    expect(vl.bays[0].desc).toBe('7E出线间隔');
    expect(vl.bays[1].name).toBe('A240');
  });

  it('解析 Group（多设备组合）', () => {
    const doc = parseStd(SAMPLE_STD);
    const vl = doc.substation!.voltageLevels[0];
    expect(vl.groups).toHaveLength(1);
    expect(vl.groups[0].name).toBe('GSK10');
    expect(vl.groups[0].gridId).toBe('A0AEC*002GSK*010');
    expect(vl.groups[0].type).toBe('multiequipment');
  });

  it('解析 ConductingEquipment（含 virtual 标记）', () => {
    const doc = parseStd(SAMPLE_STD);
    const bay = doc.substation!.voltageLevels[0].bays[0];
    expect(bay.conductingEquipments).toHaveLength(2);

    const virtual = bay.conductingEquipments[0];
    expect(virtual.virtual).toBe(true);
    expect(virtual.gridId).toBe('');
    expect(virtual.type).toBe('SAR');
    expect(virtual.groupGridId).toBe('A0AEC*002GSK*010');

    const real = bay.conductingEquipments[1];
    expect(real.virtual).toBe(false);
    expect(real.gridId).toBe('A0ATA*240GFA*001');
    expect(real.type).toBe('PTR');
  });

  it('解析 Parameter 列表', () => {
    const doc = parseStd(SAMPLE_STD);
    const ce = doc.substation!.voltageLevels[0].bays[0].conductingEquipments[1];
    expect(ce.parameters).toHaveLength(2);
    expect(ce.parameters[0].desc).toBe('设备名称');
    expect(ce.parameters[0].value).toBe('主变压器');
    expect(ce.parameters[1].desc).toBe('额定电流');
    expect(ce.parameters[1].value).toBe('4000A');
  });

  it('构建 gridId 索引（仅含非空 gridId）', () => {
    const doc = parseStd(SAMPLE_STD);
    expect(doc.gridIdIndex.size).toBe(4); // Group + 2 Bay + 1 非虚拟 CE
    expect(doc.gridIdIndex.has('A0AEC*002GSK*010')).toBe(true);
    expect(doc.gridIdIndex.has('A0AEC*002')).toBe(true);
    expect(doc.gridIdIndex.has('A0ATA*240')).toBe(true);
    expect(doc.gridIdIndex.has('A0ATA*240GFA*001')).toBe(true);
    // virtual=true 且 gridId="" 的设备不进入索引
    expect(doc.gridIdIndex.has('')).toBe(false);
  });

  it('gridId 索引指向正确的节点类型', () => {
    const doc = parseStd(SAMPLE_STD);
    expect(doc.gridIdIndex.get('A0AEC*002')!.tag).toBe('Bay');
    expect(doc.gridIdIndex.get('A0AEC*002GSK*010')!.tag).toBe('Group');
    expect(doc.gridIdIndex.get('A0ATA*240GFA*001')!.tag).toBe('ConductingEquipment');
  });

  it('空文本返回空文档', () => {
    const doc = parseStd('');
    expect(doc.version).toBe('');
    expect(doc.substation).toBeNull();
    expect(doc.gridIdIndex.size).toBe(0);
  });

  it('非 XML 文本返回空文档', () => {
    const doc = parseStd('not xml at all');
    expect(doc.substation).toBeNull();
  });

  it('根元素非 STD 返回空文档', () => {
    const doc = parseStd('<?xml version="1.0"?><OTHER/>');
    expect(doc.substation).toBeNull();
  });

  it('无 Substation 子元素返回 version 但 substation=null', () => {
    const doc = parseStd('<?xml version="1.0"?><STD version="DLT1"/>');
    expect(doc.version).toBe('DLT1');
    expect(doc.substation).toBeNull();
  });

  it('attributes 字段保留全部原始属性', () => {
    const doc = parseStd(SAMPLE_STD);
    const bay = doc.substation!.voltageLevels[0].bays[0];
    expect(bay.attributes.name).toBe('C2');
    expect(bay.attributes.desc).toBe('7E出线间隔');
    expect(bay.attributes.gridId).toBe('A0AEC*002');
  });

  it('path 字段构建层级路径', () => {
    const doc = parseStd(SAMPLE_STD);
    const vl = doc.substation!.voltageLevels[0];
    expect(vl.path).toBe('Substation/AE');
    const bay = vl.bays[0];
    expect(bay.path).toBe('Substation/AE/C2');
  });
});
