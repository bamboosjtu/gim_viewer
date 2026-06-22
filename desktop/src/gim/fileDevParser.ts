import type { FileDevEntry } from './types.js';
import { parseKeyValue } from './cbmParser.js';
import { parseBoundedCount } from './parserLimits.js';
import { getFileByPath } from './fileLookup.js';

/**
 * 解析 FileDevRelation.cbm。
 *
 * 现实样本存在三种互不等价的写法：
 * - JinQu：`FILE.NUM` + 偶数 FILE 设备列表、奇数 FILE 的 `IFC` 配对；
 * - Bentley：`FILES.NUM` + `FILEn.DEVS.NUM`，NAME 直接是 DGN 图纸名；
 * - BIMBase：`FILE.NUM` + `FILEn.DEV.NUM`，设备列表和 `FILEn.IFC` 在同一条目。
 *
 * 解析器不能依赖奇偶位置，也不能把 DGN 图纸伪装成 IFC 模型。没有实际
 * `.ifc` 目标时保留 `ifcFile/modelId` 为空，调用方仍可使用 ifcName 和设备列表
 * 作为“来源图纸”证据。
 */
export async function parseFileDevRelation(files: Map<string, File>): Promise<FileDevEntry[]> {
  const f = getFileByPath(files, 'CBM/FileDevRelation.cbm');
  if (!f) return [];
  const kv = parseKeyValue(await f.text());
  const countKey = Object.prototype.hasOwnProperty.call(kv, 'FILES.NUM') ? 'FILES.NUM' : 'FILE.NUM';
  const num = parseBoundedCount(kv[countKey], countKey);
  const entries: FileDevEntry[] = [];

  // 只有在“偶数条目全部带设备数、奇数条目全部只带 IFC”时，才判定为
  // JinQu 的奇偶配对。BIMBase 的 FILE0 设备 + FILE1..N IFC 不能误配。
  const isLegacyPair = num > 1 && num % 2 === 0
    && Array.from({ length: num / 2 }, (_, pair) => pair * 2).every((i) => hasDeviceCount(kv, i))
    && Array.from({ length: num / 2 }, (_, pair) => pair * 2 + 1).every((i) => !!kv[`FILE${i}.IFC`])
    && Array.from({ length: num / 2 }, (_, pair) => pair * 2 + 1).every((i) => !hasDeviceCount(kv, i));

  const appendEntry = (i: number, pairedIfc: string = ''): void => {
    const rawName = kv[`FILE${i}.NAME`] || '';
    const directIfc = kv[`FILE${i}.IFC`] || '';
    const devKey = hasDeviceCount(kv, i)
      ? (Object.prototype.hasOwnProperty.call(kv, `FILE${i}.DEVS.NUM`) ? `FILE${i}.DEVS.NUM` : `FILE${i}.DEV.NUM`)
      : null;
    const devNum = devKey ? parseBoundedCount(kv[devKey], devKey) : 0;
    const deviceCbms: string[] = [];
    for (let j = 0; j < devNum; j++) {
      // 当前样本的子键统一为 DEVj；保留 DEVSj 兼容少数导出器变体。
      const dev = kv[`FILE${i}.DEV${j}`] || kv[`FILE${i}.DEVS${j}`];
      if (dev) deviceCbms.push(dev);
    }

    // NAME 带 .ifc 时可直接作为 IFC 来源；NAME 带 .dgn 只作为图纸名，
    // 不填 ifcFile，避免后续懒加载把 DGN 名称当成 IFC modelId。
    const nameAsIfc = /\.ifc$/i.test(rawName) ? rawName : '';
    const ifcFile = directIfc || pairedIfc || nameAsIfc;
    const ifcName = rawName.replace(/\.(?:ifc|dgn)$/i, '') || ifcFile.replace(/\.ifc$/i, '');
    const modelId = /\.ifc$/i.test(ifcFile) ? ifcFile.replace(/\.ifc$/i, '') : '';
    // 有 NAME、IFC 或设备列表任一事实就保留条目；不要静默丢掉“仅 IFC 清单”行。
    if (ifcName || ifcFile || devKey) {
      entries.push({ ifcName, ifcFile, modelId, deviceCount: devNum, deviceCbms });
    }
  };

  if (isLegacyPair) {
    for (let i = 0; i < num; i += 2) appendEntry(i, kv[`FILE${i + 1}.IFC`] || '');
  } else {
    for (let i = 0; i < num; i++) appendEntry(i);
  }
  return entries;
}

function hasDeviceCount(kv: Record<string, string>, index: number): boolean {
  return Object.prototype.hasOwnProperty.call(kv, `FILE${index}.DEVS.NUM`)
    || Object.prototype.hasOwnProperty.call(kv, `FILE${index}.DEV.NUM`);
}
