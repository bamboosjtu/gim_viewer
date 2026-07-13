/**
 * STD（Substation Topology Definition）解析器。
 *
 * STD 是 GIM 工程的电气拓扑定义文件（XML 格式），描述变电站的层级结构：
 *
 * ```xml
 * <STD version="DLT1" revision="2023">
 *   <Substation name="" desc="">
 *     <VoltageLevel name="AE" desc="220 kV">
 *       <Voltage multiplier="k" unit="V">220</Voltage>
 *       <Group name="GSK10" gridId="A0AEC*002GSK*010" type="multiequipment" />
 *       <Bay name="C2" desc="7E出线间隔" gridId="A0AEC*002">
 *         <ConductingEquipment name="..." gridId="" type="SAR" virtual="true" />
 *         <ConductingEquipment name="GFA1" gridId="A0ATA*240GFA*001" type="PTR" virtual="false" />
 *       </Bay>
 *     </VoltageLevel>
 *   </Substation>
 * </STD>
 * ```
 *
 * **gridId 编码规则**：与 CBM `SYSCLASSIFYNAME` 对齐（多前缀 `A`）：
 * - CBM: `SYSCLASSIFYNAME=0AEC*002` → STD: `gridId=A0AEC*002`
 * - CBM: `SYSCLASSIFYNAME=0ATA*240` → STD: `gridId=A0ATA*240`
 *
 * 关联文档：[05-cbm-tree-structure.md](../../docs/schema/05-cbm-tree-structure.md)
 */

/**
 * 解析后的 STD 文档。
 *
 * 包含 Substation → VoltageLevel → Bay → ConductingEquipment 层级，
 * 以及双向 gridId 索引（gridId → 节点 / 节点 → gridId）。
 */
export interface StdDocument {
  /** STD 版本（如 `DLT1`） */
  version: string;
  /** STD 修订号（如 `2023`） */
  revision: string;
  /** 变电站根节点 */
  substation: StdSubstation | null;
  /** gridId → 节点索引（仅含 gridId 非空的节点） */
  gridIdIndex: Map<string, StdNode>;
}

/** STD 节点公共字段 */
export interface StdNode {
  /** XML 标签名（Substation/VoltageLevel/Bay/Group/ConductingEquipment） */
  tag: string;
  /** name 属性 */
  name: string;
  /** desc 属性 */
  desc: string;
  /** gridId 属性（可能为空字符串） */
  gridId: string;
  /** 在 XML 中的层级路径（用于调试） */
  path: string;
  /** 子节点 */
  children: StdNode[];
  /** 原始属性表（含未单独建模的字段） */
  attributes: Record<string, string>;
}

/** 变电站根节点 */
export interface StdSubstation extends StdNode {
  tag: 'Substation';
  /** 电压等级列表 */
  voltageLevels: StdVoltageLevel[];
}

/** 电压等级节点 */
export interface StdVoltageLevel extends StdNode {
  tag: 'VoltageLevel';
  /** 电压值（伏特，从 `<Voltage>` 元素解析） */
  voltage: number | null;
  /** 电压单位倍数（如 `k`） */
  voltageMultiplier: string;
  /** 电压单位（如 `V`） */
  voltageUnit: string;
  /** Bay 列表 */
  bays: StdBay[];
  /** Group 列表（多设备组合，如 GIS） */
  groups: StdGroup[];
}

/** 间隔节点（Bay） */
export interface StdBay extends StdNode {
  tag: 'Bay';
  /** 导电设备列表 */
  conductingEquipments: StdConductingEquipment[];
  /** 所属 Group gridId（若此 Bay 是组合电器内的间隔） */
  groupGridId: string;
}

/** 多设备组合节点（Group，如 GIS） */
export interface StdGroup extends StdNode {
  tag: 'Group';
  /** 组合类型（如 `multiequipment`） */
  type: string;
}

/** 导电设备节点 */
export interface StdConductingEquipment extends StdNode {
  tag: 'ConductingEquipment';
  /** 设备类型代码（SAR/DIS/CTR/VTR/PTR/OTHER/EVPIS 等） */
  type: string;
  /** 是否虚拟设备（virtual="true" 表示无实际电气设备，仅拓扑占位） */
  virtual: boolean;
  /** 所属 Group gridId（若此设备属于多设备组合） */
  groupGridId: string;
  /** 子设备列表 */
  subEquipments: StdSubEquipment[];
  /** 参数列表 */
  parameters: StdParameter[];
}

/** 子设备节点 */
export interface StdSubEquipment extends StdNode {
  tag: 'SubEquipment';
  type: string;
  phase: string;
}

/** 参数节点（ConductingEquipment 内的 `<Parameter>`） */
export interface StdParameter {
  name: string;
  desc: string;
  dimension: string;
  value: string;
}

/**
 * 解析 STD XML 文本。
 *
 * 使用浏览器内置 DOMParser（与 web-ifc / libarchive.js 无依赖）。
 *
 * @param text STD XML 文本
 * @param sourcePath 文件路径（用于错误消息）
 * @returns 解析后的 StdDocument；若 XML 无效返回空文档
 */
export function parseStd(text: string, sourcePath: string = ''): StdDocument {
  const emptyDoc: StdDocument = {
    version: '',
    revision: '',
    substation: null,
    gridIdIndex: new Map(),
  };

  if (!text || !text.trim()) return emptyDoc;

  // 防御 XML炸弹：仅使用 DOMParser，不启用 XSLT/XInclude
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'text/xml');
  const parseError = xml.querySelector('parsererror');
  if (parseError) {
    console.warn(`[STD] XML 解析失败: ${sourcePath}`, parseError.textContent);
    return emptyDoc;
  }

  const root = xml.documentElement;
  if (root.tagName !== 'STD') {
    console.warn(`[STD] 根元素非 STD: ${root.tagName}, source=${sourcePath}`);
    return emptyDoc;
  }

  const version = root.getAttribute('version') || '';
  const revision = root.getAttribute('revision') || '';
  const gridIdIndex = new Map<string, StdNode>();

  const subEl = findChildElement(root, 'Substation');
  const substation = subEl ? parseSubstation(subEl, gridIdIndex) : null;

  return { version, revision, substation, gridIdIndex };
}

/** 查找直接子元素（非递归） */
function findChildElement(parent: Element, tagName: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (child.tagName === tagName) return child;
  }
  return null;
}

/** 查找全部直接子元素（非递归） */
function findChildElements(parent: Element, tagName: string): Element[] {
  return Array.from(parent.children).filter((c) => c.tagName === tagName);
}

/** 提取元素所有属性到 Record */
function extractAttributes(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    attrs[attr.name] = attr.value;
  }
  return attrs;
}

function parseSubstation(el: Element, gridIdIndex: Map<string, StdNode>): StdSubstation {
  const attrs = extractAttributes(el);
  const name = attrs.name || '';
  const desc = attrs.desc || '';
  const gridId = attrs.gridId || '';
  const path = 'Substation';

  const node: StdSubstation = {
    tag: 'Substation',
    name,
    desc,
    gridId,
    path,
    children: [],
    attributes: attrs,
    voltageLevels: [],
  };
  if (gridId) gridIdIndex.set(gridId, node);

  for (const vlEl of findChildElements(el, 'VoltageLevel')) {
    const vl = parseVoltageLevel(vlEl, gridIdIndex, `${path}/${vlEl.getAttribute('name') || ''}`);
    node.voltageLevels.push(vl);
    node.children.push(vl);
  }
  return node;
}

function parseVoltageLevel(el: Element, gridIdIndex: Map<string, StdNode>, path: string): StdVoltageLevel {
  const attrs = extractAttributes(el);
  const name = attrs.name || '';
  const desc = attrs.desc || '';
  const gridId = attrs.gridId || '';

  // 解析 <Voltage multiplier="k" unit="V">220</Voltage>
  let voltage: number | null = null;
  let voltageMultiplier = '';
  let voltageUnit = '';
  const vEl = findChildElement(el, 'Voltage');
  if (vEl) {
    voltageMultiplier = vEl.getAttribute('multiplier') || '';
    voltageUnit = vEl.getAttribute('unit') || '';
    const text = vEl.textContent?.trim() || '';
    if (text) {
      const n = parseFloat(text);
      if (Number.isFinite(n)) voltage = n;
    }
  }

  const node: StdVoltageLevel = {
    tag: 'VoltageLevel',
    name,
    desc,
    gridId,
    path,
    children: [],
    attributes: attrs,
    voltage,
    voltageMultiplier,
    voltageUnit,
    bays: [],
    groups: [],
  };
  if (gridId) gridIdIndex.set(gridId, node);

  for (const bayEl of findChildElements(el, 'Bay')) {
    const bay = parseBay(bayEl, gridIdIndex, `${path}/${bayEl.getAttribute('name') || ''}`);
    node.bays.push(bay);
    node.children.push(bay);
  }
  for (const groupEl of findChildElements(el, 'Group')) {
    const group = parseGroup(groupEl, gridIdIndex, `${path}/${groupEl.getAttribute('name') || ''}`);
    node.groups.push(group);
    node.children.push(group);
  }
  return node;
}

function parseBay(el: Element, gridIdIndex: Map<string, StdNode>, path: string): StdBay {
  const attrs = extractAttributes(el);
  const name = attrs.name || '';
  const desc = attrs.desc || '';
  const gridId = attrs.gridId || '';

  const node: StdBay = {
    tag: 'Bay',
    name,
    desc,
    gridId,
    path,
    children: [],
    attributes: attrs,
    conductingEquipments: [],
    groupGridId: '',
  };
  if (gridId) gridIdIndex.set(gridId, node);

  for (const ceEl of findChildElements(el, 'ConductingEquipment')) {
    const ce = parseConductingEquipment(ceEl, gridIdIndex, `${path}/${ceEl.getAttribute('name') || ''}`);
    node.conductingEquipments.push(ce);
    node.children.push(ce);
  }
  return node;
}

function parseGroup(el: Element, gridIdIndex: Map<string, StdNode>, path: string): StdGroup {
  const attrs = extractAttributes(el);
  const name = attrs.name || '';
  const desc = attrs.desc || '';
  const gridId = attrs.gridId || '';
  const type = attrs.type || '';

  const node: StdGroup = {
    tag: 'Group',
    name,
    desc,
    gridId,
    path,
    children: [],
    attributes: attrs,
    type,
  };
  if (gridId) gridIdIndex.set(gridId, node);
  return node;
}

function parseConductingEquipment(el: Element, gridIdIndex: Map<string, StdNode>, path: string): StdConductingEquipment {
  const attrs = extractAttributes(el);
  const name = attrs.name || '';
  const desc = attrs.desc || '';
  const gridId = attrs.gridId || '';
  const type = attrs.type || '';
  const virtualAttr = el.getAttribute('virtual');
  const virtual = virtualAttr === 'true';
  const groupGridId = attrs.groupGridId || '';

  const node: StdConductingEquipment = {
    tag: 'ConductingEquipment',
    name,
    desc,
    gridId,
    path,
    children: [],
    attributes: attrs,
    type,
    virtual,
    groupGridId,
    subEquipments: [],
    parameters: [],
  };
  if (gridId) gridIdIndex.set(gridId, node);

  for (const seEl of findChildElements(el, 'SubEquipment')) {
    const seAttrs = extractAttributes(seEl);
    const sub: StdSubEquipment = {
      tag: 'SubEquipment',
      name: seAttrs.name || '',
      desc: seAttrs.desc || '',
      gridId: seAttrs.gridId || '',
      path: `${path}/${seAttrs.name || ''}`,
      children: [],
      attributes: seAttrs,
      type: seAttrs.type || '',
      phase: seAttrs.phase || '',
    };
    node.subEquipments.push(sub);
    node.children.push(sub);
    if (sub.gridId) gridIdIndex.set(sub.gridId, sub);
  }
  for (const pEl of findChildElements(el, 'Parameter')) {
    node.parameters.push({
      name: pEl.getAttribute('name') || '',
      desc: pEl.getAttribute('desc') || '',
      dimension: pEl.getAttribute('dimension') || '',
      value: pEl.textContent?.trim() || '',
    });
  }
  return node;
}
