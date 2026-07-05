/**
 * 变电工程几何发现服务。
 *
 * 走 CBM 节点 → DEV → PHM → MOD 引用链，发现需要加载的 xml-mod 几何来源。
 *
 * 引用链（详见 docs/schema/dev.md §引用关系）：
 * - CBM.OBJECTMODELPOINTER → DEV 文件名（裸名，如 "abc.dev"）
 * - DEV.SOLIDMODELn → PHM 文件名（变电工程仅指向 .phm）
 * - PHM.SOLIDMODELn → MOD / STL 文件名
 *
 * 路径前缀拼接规则：
 * - DEV 文件：files Map key = "DEV/" + devPath
 * - PHM 文件：files Map key = "PHM/" + solidModelPath
 * - MOD 文件：files Map key = "MOD/" + solidModelPath
 *
 * P0 范围：
 * - 仅处理 SOLIDMODELS 路径（DEV → PHM → MOD）
 * - 不递归 SUBDEVICES（P2 任务）
 * - 不处理 STL（P1 任务）
 * - 不处理缓存命中场景（currentFiles=null 时直接返回空，P2 任务）
 */

import type { CbmNode } from '../gim/types.js';
import type { XmlModColor } from '../gim/geometry/ir.js';
import { parseDev } from '../gim/geometry/devParser.js';
import { parsePhm } from '../gim/geometry/phmParser.js';

/** 发现的 MOD 几何来源 */
export interface DiscoveredModGeometry {
  /** MOD 文件完整路径（如 "MOD/abc.mod"） */
  modPath: string;
  /** DEV SOLIDMODELS 块的 TRANSFORMMATRIX（行主序，长度 16） */
  devTransformMatrix: number[];
  /** PHM SOLIDMODELn 的 TRANSFORMMATRIX（行主序，长度 16） */
  phmTransformMatrix: number[];
  /** PHM COLORn（MOD 引用为 undefined，STL 引用必非空） */
  phmColor?: XmlModColor;
  /** DEV 文件路径（用于诊断） */
  devPath: string;
  /** PHM 文件路径（用于诊断） */
  phmPath: string;
}

/**
 * 从 CBM 节点出发，发现所有需要加载的 MOD 几何来源。
 *
 * @param node CBM 节点（必须带 devPath）
 * @param files GIM 解压后的文件集合；为 null 时（缓存命中）返回空数组
 * @returns 发现的 MOD 几何来源列表；找不到 DEV/PHM 时返回空数组
 */
export async function discoverModGeometriesFromNode(
  node: CbmNode,
  files: Map<string, File> | null,
): Promise<DiscoveredModGeometry[]> {
  if (!node.devPath || !files) return [];

  // 1. 读 DEV 文件
  const devFilePath = `DEV/${node.devPath}`;
  const devFile = files.get(devFilePath);
  if (!devFile) {
    console.warn(`[modDiscovery] DEV 文件不存在: ${devFilePath}`);
    return [];
  }
  // 使用 arrayBuffer + TextDecoder 而非 file.text()，确保跨运行时（浏览器/jsdom）兼容
  const devBuffer = await devFile.arrayBuffer();
  const devText = new TextDecoder().decode(devBuffer);
  const devDoc = parseDev(devText, devFilePath);

  if (devDoc.isEmpty) return [];

  const results: DiscoveredModGeometry[] = [];

  // 2. 遍历 DEV SOLIDMODELS（变电工程仅指向 .phm）
  for (const devSolid of devDoc.solidModels) {
    const phmFileName = devSolid.solidModelPath;
    if (!phmFileName.toLowerCase().endsWith('.phm')) {
      // 跳过非 .phm 引用（如线路工程的 .dev 递归，P0 不处理）
      continue;
    }

    const phmFilePath = `PHM/${phmFileName}`;
    const phmFile = files.get(phmFilePath);
    if (!phmFile) {
      console.warn(`[modDiscovery] PHM 文件不存在: ${phmFilePath}`);
      continue;
    }
    // 使用 arrayBuffer + TextDecoder 而非 file.text()，确保跨运行时（浏览器/jsdom）兼容
    const phmBuffer = await phmFile.arrayBuffer();
    const phmText = new TextDecoder().decode(phmBuffer);
    const phmDoc = parsePhm(phmText, phmFilePath);

    if (phmDoc.isEmpty) continue;

    // 3. 遍历 PHM SOLIDMODELS（.mod 或 .stl）
    for (const phmSolid of phmDoc.solidModels) {
      const modelFileName = phmSolid.solidModelPath;
      const lower = modelFileName.toLowerCase();

      if (lower.endsWith('.mod')) {
        results.push({
          modPath: `MOD/${modelFileName}`,
          devTransformMatrix: devSolid.transformMatrix,
          phmTransformMatrix: phmSolid.transformMatrix,
          phmColor: phmSolid.color,
          devPath: devFilePath,
          phmPath: phmFilePath,
        });
      } else if (lower.endsWith('.stl')) {
        // STL P1 实现，P0 跳过
        console.debug(`[modDiscovery] STL 跳过（P1）: ${modelFileName}`);
      } else {
        console.warn(`[modDiscovery] 未知几何引用类型: ${modelFileName}`);
      }
    }
  }

  return results;
}
