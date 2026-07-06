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
 * 1. SYSTEMNAME1..4 拼接（如"交流电气系统/110kV系统/#2主变 110kV进线间隔"）— 系统层可读
 * 2. PARTNAME（部件名）
 * 3. SYSCLASSIFYNAME（系统分类编码，如 0AFD*002）— 编码可读性差，作为回退
 * 4. ENTITYNAME（如 F1System/F2System/F3System/F4System/PARTINDEX）
 * 5. 文件名（去 .cbm 后缀）
 *
 * 注意：F4System/PARTINDEX 设备层节点的名称会在 build() 中被 DEV SYMBOLNAME 覆盖。
 *
 * @param kv 已解析的键值表
 * @param path CBM 文件路径（用于提取文件名回退）
 */
function extractDisplayName(kv: Record<string, string>, path: string): { name: string; systemNames: string[] } {
  const systemNames: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const sn = kv[`SYSTEMNAME${i}`];
    if (sn && sn.trim()) systemNames.push(sn.trim());
  }

  const partName = kv['PARTNAME'] || '';
  const sysClassifyName = kv['SYSCLASSIFYNAME'] || '';
  const entityName = kv['ENTITYNAME'] || '';
  const fileName = path.split('/').pop()!.replace(/\.cbm$/i, '');

  let name: string;
  if (systemNames.length > 0) {
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

/**
 * 判断节点是否为设备层节点（F4System 或 PARTINDEX），其名称应优先用 DEV SYMBOLNAME。
 *
 * - F4System：变电设备层（一次/二次设备）
 * - PARTINDEX：部件索引层（最底层，设备内部件）
 * - DEV_SUBDEVICE：DEV SUBDEVICES 展开的虚拟子设备节点
 */
function isDeviceLayer(entityName: string): boolean {
  return entityName === 'F4System' || entityName === 'PARTINDEX' || entityName === 'DEV_SUBDEVICE';
}

/**
 * 将 F2System 的 SYSCLASSIFYNAME 单字符代码映射为工程专业名称。
 *
 * 变电工程内部的专业分项（CBM 中 F2System 的 SYSCLASSIFYNAME 为单字符）：
 * - U → 建筑工程
 * - A → 安装工程
 * - S → 暖通工程
 * - G → 给排水工程
 */
function mapF2ClassifyName(code: string): string {
  switch (code) {
    case 'U': return '建筑工程';
    case 'A': return '安装工程';
    case 'S': return '暖通工程';
    case 'G': return '给排水工程';
    default: return '';
  }
}

/** 解析 DEV 文件获取 SYMBOLNAME 和 TYPE（失败返回空值） */
async function readDevInfo(
  devPath: string,
  files: Map<string, File>,
): Promise<{ symbolName: string; type: string } | null> {
  const normalized = devPath.startsWith('DEV/') ? devPath : `DEV/${devPath}`;
  const devFile = files.get(normalized);
  if (!devFile) return null;
  try {
    const doc = parseDev(await devFile.text(), normalized);
    return { symbolName: doc.symbolName || '', type: doc.type || '' };
  } catch {
    return null;
  }
}

/** 从文件集合递归构建 CBM 层级树（含 DEV SYMBOLNAME 回填与 SUBDEVICES 展开） */
export async function buildCbmTree(files: Map<string, File>, projectTypeName?: string): Promise<CbmNode | null> {
  const visited = new Set<string>();
  // DEV 文件缓存（同一 DEV 可能被多个 CBM 节点引用，避免重复解析）
  const devInfoCache = new Map<string, { symbolName: string; type: string } | null>();

  async function readDevCached(devPath: string): Promise<{ symbolName: string; type: string } | null> {
    const normalized = devPath.startsWith('DEV/') ? devPath : `DEV/${devPath}`;
    if (devInfoCache.has(normalized)) return devInfoCache.get(normalized)!;
    const info = await readDevInfo(devPath, files);
    devInfoCache.set(normalized, info);
    return info;
  }

  async function build(p: string): Promise<CbmNode | null> {
    if (visited.has(p)) return null;
    visited.add(p);
    const f = files.get(p);
    if (!f) return null;
    const kv = parseKeyValue(await f.text());
    const en = kv['ENTITYNAME'] || '';
    let { name, systemNames } = extractDisplayName(kv, p);
    const cn = kv['SYSCLASSIFYNAME'] || kv['PARTNAME'] || '';
    const devPath = kv['OBJECTMODELPOINTER'] || '';

    // 读取 DEV SYMBOLNAME/TYPE（回填到节点，供 getNodeDisplayName 使用）
    let devSymbolName = '';
    let devType = '';
    if (devPath) {
      const info = await readDevCached(devPath);
      if (info) {
        devSymbolName = info.symbolName;
        devType = info.type;
        // 设备层节点（F4System/PARTINDEX）优先用 DEV SYMBOLNAME 作为节点名称
        // 这比 SYSCLASSIFYNAME 编码（如 CAH*006）可读得多
        if (isDeviceLayer(en) && devSymbolName) {
          name = devSymbolName;
        }
      }
    }

    // F1System 根节点：显示工程类型名（如"变电工程"/"建筑工程"）
    if (en === 'F1System' && projectTypeName) {
      name = projectTypeName;
    }

    // F2System：将 SYSCLASSIFYNAME 单字符代码（U/A/S/G）映射为工程专业名
    if (en === 'F2System') {
      const f2Name = mapF2ClassifyName(cn);
      if (f2Name) name = f2Name;
    }

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

    // 4. 方向 B：若此节点有 devPath，展开 DEV SUBDEVICES 块为虚拟子节点
    let devExpanded = false;
    if (devPath) {
      const devChildren = await expandDevSubDevices(devPath, files, p, devInfoCache);
      if (devChildren.length > 0) {
        children.push(...devChildren);
        devExpanded = true;
      }
    }

    // F1System 子节点（F2System）按 U→A→S→G 顺序排列
    if (en === 'F1System') {
      const f2Order: Record<string, number> = { U: 0, A: 1, S: 2, G: 3 };
      children.sort((a, b) => {
        const ai = f2Order[a.classifyName] ?? 99;
        const bi = f2Order[b.classifyName] ?? 99;
        return ai - bi;
      });
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
      devSymbolName,
      devType,
      devExpanded,
    };
  }

  if (!files.has('CBM/project.cbm')) return null;
  return build('CBM/project.cbm');
}

/**
 * 解析 DEV 文件，展开 SUBDEVICES 块为 CBM 子节点（方向 B）。
 *
 * @param devPath 当前节点的 OBJECTMODELPOINTER（DEV 文件名）
 * @param files GIM 解压文件集合
 * @param parentCbmPath 父 CBM 节点路径（用于生成虚拟子节点 path）
 * @param devInfoCache DEV 信息缓存（避免重复解析同一 DEV 文件）
 * @param devVisited 循环引用防护
 * @returns 虚拟 CbmNode 列表
 */
async function expandDevSubDevices(
  devPath: string,
  files: Map<string, File>,
  parentCbmPath: string,
  devInfoCache: Map<string, { symbolName: string; type: string } | null>,
  devVisited?: Set<string>,
): Promise<CbmNode[]> {
  if (!devVisited) devVisited = new Set<string>();

  const normalizedDevPath = devPath.startsWith('DEV/') ? devPath : `DEV/${devPath}`;
  if (devVisited.has(normalizedDevPath)) return [];
  devVisited.add(normalizedDevPath);

  // 从缓存读取 DEV 文档（若已解析过）
  const devFile = files.get(normalizedDevPath);
  if (!devFile) return [];

  let devDoc;
  try {
    devDoc = parseDev(await devFile.text(), normalizedDevPath);
  } catch {
    return [];
  }

  const children: CbmNode[] = [];
  for (const subDevice of devDoc.subDevices) {
    const childDevPath = subDevice.devPath;
    const normalizedChildDevPath = childDevPath.startsWith('DEV/') ? childDevPath : `DEV/${childDevPath}`;

    // 从缓存获取子 DEV 的 SYMBOLNAME/TYPE
    let childSymbolName = '';
    let childType = '';
    let grandChildren: CbmNode[] = [];
    try {
      // 优先查缓存
      let childInfo = devInfoCache.get(normalizedChildDevPath);
      if (childInfo === undefined) {
        const childFile = files.get(normalizedChildDevPath);
        if (childFile) {
          const childDoc = parseDev(await childFile.text(), normalizedChildDevPath);
          childInfo = { symbolName: childDoc.symbolName || '', type: childDoc.type || '' };
        } else {
          childInfo = null;
        }
        devInfoCache.set(normalizedChildDevPath, childInfo);
      }
      if (childInfo) {
        childSymbolName = childInfo.symbolName;
        childType = childInfo.type;
      }
      // 递归展开孙 SUBDEVICES
      grandChildren = await expandDevSubDevices(childDevPath, files, `${parentCbmPath}#dev:${childDevPath}`, devInfoCache, devVisited);
    } catch {
      // 子 DEV 解析失败，跳过
    }

    // 虚拟子节点名称：SYMBOLNAME > TYPE > devPath 文件名
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
