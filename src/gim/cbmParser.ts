import type { CbmNode } from './types.js';
import { parseDev } from './geometry/devParser.js';

/** 解析 KEY=VALUE 格式文本 */
export function parseKeyValue(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

/**
 * 从 CBM kv 提取可读名称（按优先级回退）。
 *
 * 优先级链（变电工程）：
 * 1. SYSTEMNAME1..4 拼接（如"交流电气系统/110kV系统/#2主变 110kV进线间隔"）— 最可读
 * 2. PARTNAME（部件名）
 * 3. SYSCLASSIFYNAME（系统分类编码，如 0AFD*002）— 编码可读性差，作为回退
 * 4. ENTITYNAME（如 F1System/F2System/F3System/F4System/PARTINDEX）
 * 5. 文件名（去 .cbm 后缀）
 *
 * @param kv 已解析的键值表
 * @param path CBM 文件路径（用于提取文件名回退）
 */
function extractDisplayName(kv: Record<string, string>, path: string): { name: string; systemNames: string[] } {
  // 提取 SYSTEMNAME1..4（变电工程特有）
  const systemNames: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const sn = kv[`SYSTEMNAME${i}`];
    if (sn && sn.trim()) systemNames.push(sn.trim());
  }

  // 优先级链
  const partName = kv['PARTNAME'] || '';
  const sysClassifyName = kv['SYSCLASSIFYNAME'] || '';
  const entityName = kv['ENTITYNAME'] || '';
  const fileName = path.split('/').pop()!.replace(/\.cbm$/i, '');

  // 名称选择：SYSTEMNAME 拼接 > PARTNAME > SYSCLASSIFYNAME > ENTITYNAME > 文件名
  let name: string;
  if (systemNames.length > 0) {
    // SYSTEMNAME1..4 通常语义递进（系统大类→小类），用 " / " 分隔
    name = systemNames.join(' / ');
  } else if (partName) {
    name = partName;
  } else if (sysClassifyName) {
    name = sysClassifyName;
  } else if (entityName) {
    name = entityName;
  } else {
    name = fileName;
  }

  return { name, systemNames };
}

/** 从文件集合递归构建 CBM 层级树（含 DEV SUBDEVICES 展开与名称增强） */
export async function buildCbmTree(files: Map<string, File>): Promise<CbmNode | null> {
  const visited = new Set<string>();

  async function build(p: string): Promise<CbmNode | null> {
    if (visited.has(p)) return null;
    visited.add(p);
    const f = files.get(p);
    if (!f) return null;
    const kv = parseKeyValue(await f.text());
    const en = kv['ENTITYNAME'] || '';
    const { name, systemNames } = extractDisplayName(kv, p);
    const cn = kv['SYSCLASSIFYNAME'] || kv['PARTNAME'] || '';
    const devPath = kv['OBJECTMODELPOINTER'] || '';

    const children: CbmNode[] = [];

    // 1. SUBSYSTEM 单值引用
    const sg = kv['SUBSYSTEM'];
    if (sg) {
      const c = await build(`CBM/${sg}`);
      if (c) children.push(c);
    }

    // 2. SUBSYSTEMS.NUM + SUBSYSTEMi 数组引用
    const sn = parseInt(kv['SUBSYSTEMS.NUM'] || '0', 10);
    for (let i = 0; i < sn; i++) {
      const s = kv[`SUBSYSTEM${i}`];
      if (s) {
        const c = await build(`CBM/${s}`);
        if (c) children.push(c);
      }
    }

    // 3. SUBDEVICES.NUM + SUBDEVICEi 数组引用（F4System 内部子设备分组）
    const dn2 = parseInt(kv['SUBDEVICES.NUM'] || '0', 10);
    for (let i = 0; i < dn2; i++) {
      const s = kv[`SUBDEVICE${i}`];
      if (s) {
        const c = await build(`CBM/${s}`);
        if (c) children.push(c);
      }
    }

    // 4. 方向 B 新增：若此节点有 devPath，解析 DEV 文件并展开 SUBDEVICES 块
    if (devPath) {
      const devChildren = await expandDevSubDevices(devPath, files, p);
      children.push(...devChildren);
    }

    return {
      path: p,
      name,
      entityName: en,
      children,
      famPath: kv['BASEFAMILY'] || '',
      devPath,
      ifcFile: kv['IFCFILE'] || '',
      ifcGuid: (kv['IFCGUID'] || '').replace(/\$+$/, '').trim(),
      classifyName: cn,
      transformMatrix: kv['TRANSFORMMATRIX'] || '',
      systemNames,
      devSymbolName: '',
      devType: '',
      devExpanded: false,
    };
  }

  if (!files.has('CBM/project.cbm')) return null;
  return build('CBM/project.cbm');
}

/**
 * 解析 DEV 文件，展开 SUBDEVICES 块为 CBM 子节点（方向 B）。
 *
 * DEV 文件的 SUBDEVICES 块包含递归子 DEV 引用（如屏柜内的开关、继电器）。
 * 这些子设备在传统 CBM 树中不可见，需要展开为虚拟 CbmNode。
 *
 * 虚拟 CbmNode 的特点：
 * - path = `${parentCbmPath}#dev:${childDevPath}`（虚拟路径，避免与真实 CBM 冲突）
 * - entityName = 'DEV_SUBDEVICE'（标识为 DEV 子设备节点）
 * - name = 子 DEV 的 SYMBOLNAME（最可读）
 * - devPath = 子 DEV 文件名
 * - devSymbolName / devType 来自子 DEV 文件
 * - 递归展开子 DEV 的 SUBDEVICES（深度优先）
 *
 * 防止循环引用：使用 devVisited Set 记录已解析的 DEV 路径。
 *
 * @param devPath 当前节点的 OBJECTMODELPOINTER（DEV 文件名）
 * @param files GIM 解压文件集合
 * @param parentCbmPath 父 CBM 节点路径（用于生成虚拟子节点 path）
 * @returns 虚拟 CbmNode 列表（可能为空，若 DEV 文件不存在或无 SUBDEVICES）
 */
async function expandDevSubDevices(
  devPath: string,
  files: Map<string, File>,
  parentCbmPath: string,
  devVisited?: Set<string>,
): Promise<CbmNode[]> {
  // 初始化循环引用防护
  if (!devVisited) devVisited = new Set<string>();

  // 标准化 DEV 路径
  const normalizedDevPath = devPath.startsWith('DEV/') ? devPath : `DEV/${devPath}`;

  // 循环引用防护
  if (devVisited.has(normalizedDevPath)) return [];
  devVisited.add(normalizedDevPath);

  // 读取 DEV 文件
  const devFile = files.get(normalizedDevPath);
  if (!devFile) return [];

  let devDoc;
  try {
    const devText = await devFile.text();
    devDoc = parseDev(devText, normalizedDevPath);
  } catch {
    return [];
  }

  // 展开 SUBDEVICES 块为虚拟 CbmNode
  const children: CbmNode[] = [];
  for (const subDevice of devDoc.subDevices) {
    const childDevPath = subDevice.devPath;
    const normalizedChildDevPath = childDevPath.startsWith('DEV/') ? childDevPath : `DEV/${childDevPath}`;

    // 递归读取子 DEV 文件以获取 SYMBOLNAME/TYPE
    let childSymbolName = '';
    let childType = '';
    let grandChildren: CbmNode[] = [];
    try {
      const childFile = files.get(normalizedChildDevPath);
      if (childFile) {
        const childDoc = parseDev(await childFile.text(), normalizedChildDevPath);
        childSymbolName = childDoc.symbolName || '';
        childType = childDoc.type || '';
        // 递归展开孙 SUBDEVICES（传入 devVisited 防循环）
        grandChildren = await expandDevSubDevices(childDevPath, files, `${parentCbmPath}#dev:${childDevPath}`, devVisited);
      }
    } catch {
      // 子 DEV 解析失败，跳过
    }

    // 显示名称优先级：SYMBOLNAME > TYPE > devPath 文件名
    const childName = childSymbolName || childType || childDevPath.replace(/\.dev$/i, '');

    const virtualPath = `${parentCbmPath}#dev:${childDevPath}`;
    children.push({
      path: virtualPath,
      name: childName,
      entityName: 'DEV_SUBDEVICE',
      children: grandChildren,
      famPath: '',
      devPath: childDevPath,
      ifcFile: '',
      ifcGuid: '',
      classifyName: '',
      transformMatrix: '',
      systemNames: [],
      devSymbolName: childSymbolName,
      devType: childType,
      devExpanded: true,
    });
  }

  return children;
}

/** 构建 CBM 文件名 → CbmNode 索引 */
export function buildCbmNodeIndex(node: CbmNode | null): Map<string, CbmNode> {
  const index = new Map<string, CbmNode>();
  function walk(n: CbmNode) {
    const fileName = n.path.split('/').pop() || '';
    if (fileName) index.set(fileName, n);
    for (const child of n.children) walk(child);
  }
  if (node) walk(node);
  return index;
}

/** 收集节点及其后代的所有 IFC 引用 → Map<modelId, Set<ifcGuid>> */
export function collectIfcRefs(node: CbmNode): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  function walk(n: CbmNode) {
    if (n.ifcFile && n.ifcGuid) {
      const modelId = n.ifcFile.replace(/\.ifc$/i, '');
      if (!refs.has(modelId)) refs.set(modelId, new Set());
      refs.get(modelId)!.add(n.ifcGuid);
    }
    for (const child of n.children) walk(child);
  }
  walk(node);
  return refs;
}
