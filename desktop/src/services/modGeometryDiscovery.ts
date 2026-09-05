/**
 * 变电工程几何发现服务。
 *
 * 走 CBM 节点 → DEV → PHM → MOD/STL 引用链，发现需要加载的几何来源。
 *
 * 引用链（详见 docs/schema/dev.md §引用关系）：
 * - CBM.OBJECTMODELPOINTER → DEV 文件名（裸名，如 "abc.dev"）
 * - DEV.SOLIDMODELn → PHM 文件名（变电工程仅指向 .phm）
 * - PHM.SOLIDMODELn → MOD / STL 文件名
 *
 * 路径前缀拼接规则：
 * - DEV 文件：files Map key = "DEV/" + devPath
 * - PHM 文件：files Map key = "PHM/" + solidModelPath
 * - MOD/STL 文件：files Map key = "MOD/" + solidModelPath
 *
 * 当前范围：
 * - SOLIDMODELS 路径（CBM → DEV → PHM → MOD/STL）
 * - SUBDEVICES 递归路径（DEV → SUBDEVICE → child DEV）
 * - **PHM 嵌套递归**（BIMBase 实测最深 4 层；docs/schema/05/07）：
 *   PHM.SOLIDMODELn 可指向 .phm，逐边乘 TRANSFORMMATRIXn 向下累积，visited 防环
 * - 返回实例级放置矩阵；同一个 MOD/STL 文件可被多次实例化
 */

import type { CbmNode } from '../gim/types.js';
import type { XmlModColor } from '../gim/geometry/ir.js';
import * as THREE from 'three';
import { parseDev } from '../gim/geometry/devParser.js';
import { parsePhm } from '../gim/geometry/phmParser.js';
import { PARSER_LIMITS } from '../gim/parserLimits.js';
import { getFileByPath } from '../gim/fileLookup.js';

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 发现的 MOD 几何来源 */
export interface DiscoveredModGeometry {
  /** MOD 文件完整路径（如 "MOD/abc.mod"） */
  modPath: string;
  /** 实例唯一键：同一个 MOD 文件可被不同矩阵多次实例化 */
  instanceKey: string;
  /** CBM/DEV/SUBDEVICE/PHM 累积放置矩阵（GIM 原始单位，列主序） */
  placementTransformMatrix: number[];
  /** DEV SOLIDMODELS 块的 TRANSFORMMATRIX（列主序 / Three.js Matrix4.elements，长度 16） */
  devTransformMatrix: number[];
  /** PHM SOLIDMODELn 的 TRANSFORMMATRIX（列主序 / Three.js Matrix4.elements，长度 16） */
  phmTransformMatrix: number[];
  /** PHM COLORn（MOD 引用为 undefined，STL 引用必非空） */
  phmColor?: XmlModColor;
  /** PHM 文件内 COLORn.A 最大值，用于判定透明度刻度 */
  phmColorMaxA?: number;
  /** DEV 文件路径（用于诊断） */
  devPath: string;
  /** PHM 文件路径（用于诊断） */
  phmPath: string;
}

/** 发现的 STL 几何来源 */
export interface DiscoveredStlGeometry {
  /** STL 文件完整路径（如 "MOD/abc.stl"） */
  stlPath: string;
  /** 实例唯一键：同一个 STL 文件可被不同矩阵多次实例化 */
  instanceKey: string;
  /** CBM/DEV/SUBDEVICE/PHM 累积放置矩阵（GIM 原始单位，列主序） */
  placementTransformMatrix: number[];
  /** DEV SOLIDMODELS 块的 TRANSFORMMATRIX（列主序 / Three.js Matrix4.elements，长度 16） */
  devTransformMatrix: number[];
  /** PHM SOLIDMODELn 的 TRANSFORMMATRIX（列主序 / Three.js Matrix4.elements，长度 16） */
  phmTransformMatrix: number[];
  /** PHM COLORn（STL 引用必非空） */
  phmColor?: XmlModColor;
  /** PHM 文件内 COLORn.A 最大值，用于判定透明度刻度 */
  phmColorMaxA?: number;
  /** DEV 文件路径（用于诊断） */
  devPath: string;
  /** PHM 文件路径（用于诊断） */
  phmPath: string;
}

/** 几何发现结果 */
export interface DiscoveredGeometries {
  mods: DiscoveredModGeometry[];
  stls: DiscoveredStlGeometry[];
}

/**
 * 几何引用发现选项。
 *
 * 默认模式保持历史的容错语义：缺失的 DEV/PHM/MOD/STL 只记录 warning，
 * raw 回退可以继续显示其余可达几何。GLB 编译则使用严格模式，因为把
 * “有引用但依赖缺失”当成合法 `empty` 会把不完整结果持久化到 manifest，
 * 后续 warm restore 将永远跳过真实几何。
 */
export interface GeometryDiscoveryOptions {
  strictDependencies?: boolean;
}

/**
 * 从 CBM 节点出发，发现所有需要加载的 MOD/STL 几何来源。
 *
 * 对真实 CBM 设备节点，rootTransform 取 node.transformMatrix（已含父链累积）。
 * 对 DEV_SUBDEVICE 虚拟节点，node.transformMatrix 仅含 SUBDEVICE 局部变换，
 * 调用方需传入 parentCbmTransform（父 CBM 链的累积矩阵），两者相乘得到完整 root。
 *
 * @param node CBM 节点（必须带 devPath）
 * @param files GIM 解压后的文件集合；为 null 时（缓存命中）返回空
 * @param parentCbmTransform 父 CBM 链累积矩阵（用于 DEV_SUBDEVICE 虚拟节点）
 * @returns 发现的 MOD + STL 几何来源列表；找不到 DEV/PHM 时返回空
 */
export async function discoverGeometriesFromNode(
  node: CbmNode,
  files: Map<string, File> | null,
  parentCbmTransform?: number[],
): Promise<DiscoveredGeometries> {
  const empty: DiscoveredGeometries = { mods: [], stls: [] };
  if (!node.devPath || !files) return empty;

  const localTransform = parseOptionalMatrix(node.transformMatrix);
  const rootTransform = parentCbmTransform && parentCbmTransform.length === 16
    ? multiplyMatrices(parentCbmTransform, localTransform)
    : localTransform;
  // CBM exporters are inconsistent: OBJECTMODELPOINTER may be a bare file
  // name or already include a DEV/ prefix (with arbitrary casing).  Let the
  // canonical helper add the prefix exactly once; prepending unconditionally
  // would turn `dev/foo.dev` into `DEV/dev/foo.dev` and make a valid source
  // look missing on mixed-case samples.
  return discoverGeometriesFromDevPath(normalizeDevPath(node.devPath), files, rootTransform, new Set<string>());
}

export async function discoverGeometriesFromDevPath(
  devFilePath: string,
  files: Map<string, File>,
  parentTransform: number[],
  visited: Set<string>,
  depth = 0,
  budget: { instances: number } = { instances: 0 },
  options: GeometryDiscoveryOptions = {},
): Promise<DiscoveredGeometries> {
  const empty: DiscoveredGeometries = { mods: [], stls: [] };
  const strictDependencies = options.strictDependencies === true;
  if (depth > PARSER_LIMITS.maxRecursionDepth) {
    throw new Error(`几何 DEV/PHM 递归深度超过 ${PARSER_LIMITS.maxRecursionDepth}`);
  }
  const normalizedDevPath = normalizeDevPath(devFilePath);
  const devVisitKey = normalizedDevPath.toLowerCase();
  if (visited.has(devVisitKey)) return empty;
  visited.add(devVisitKey);

  const devFile = getFileByPath(files, normalizedDevPath);
  if (!devFile) {
    if (strictDependencies) {
      throw new Error(`DEV 文件不存在: ${normalizedDevPath}`);
    }
    console.warn(`[modDiscovery] DEV 文件不存在: ${normalizedDevPath}`);
    return empty;
  }
  // 使用 arrayBuffer + TextDecoder 而非 file.text()，确保跨运行时（浏览器/jsdom）兼容
  const devBuffer = await devFile.arrayBuffer();
  const devText = new TextDecoder().decode(devBuffer);
  const devDoc = parseDev(devText, normalizedDevPath);

  if (devDoc.isEmpty) return empty;

  const mods: DiscoveredModGeometry[] = [];
  const stls: DiscoveredStlGeometry[] = [];

  /**
   * PHM 递归遍历（BIMBase 实测嵌套最深 4 层，docs/schema/07）。
   *
   * - 逐边乘 TRANSFORMMATRIXn：placement = parent × 本边矩阵（层级级联，docs/schema/phm.md）
   * - 叶级（.mod/.stl/.gl）产出实例；.phm 递归向下
   * - visited 防环；同 PHM 在同一 DEV 链内只展开一次
   */
  async function walkPhm(
    phmFilePath: string,
    parentTransform: number[],
    visited: Set<string>,
    devEntryMatrix: number[],
    phmDepth: number,
  ): Promise<void> {
    if (phmDepth > PARSER_LIMITS.maxRecursionDepth) {
      throw new Error(`几何 PHM 递归深度超过 ${PARSER_LIMITS.maxRecursionDepth}`);
    }
    const phmVisitKey = phmFilePath.toLowerCase();
    if (visited.has(phmVisitKey)) return;
    visited.add(phmVisitKey);

    const phmFile = getFileByPath(files, phmFilePath);
    if (!phmFile) {
      if (strictDependencies) {
        throw new Error(`PHM 文件不存在: ${phmFilePath}`);
      }
      console.warn(`[modDiscovery] PHM 文件不存在: ${phmFilePath}`);
      return;
    }
    // 使用 arrayBuffer + TextDecoder 而非 file.text()，确保跨运行时（浏览器/jsdom）兼容
    const phmBuffer = await phmFile.arrayBuffer();
    const phmText = new TextDecoder().decode(phmBuffer);
    const phmDoc = parsePhm(phmText, phmFilePath);

    if (phmDoc.isEmpty) return;

    for (const phmSolid of phmDoc.solidModels) {
      const modelFileName = phmSolid.solidModelPath;
      const lower = modelFileName.toLowerCase();
      const placementTransform = multiplyMatrices(parentTransform, phmSolid.transformMatrix);

      if (lower.endsWith('.phm')) {
        await walkPhm(normalizePhmPath(modelFileName), placementTransform, new Set(visited), devEntryMatrix, phmDepth + 1);
        continue;
      }

      if (lower.endsWith('.mod')) {
        const modPath = normalizeGeometryPath(modelFileName);
        if (strictDependencies && !getFileByPath(files, modPath)) {
          throw new Error(`MOD 文件不存在: ${modPath}`);
        }
        budget.instances++;
        if (budget.instances > PARSER_LIMITS.maxGeometryInstances) {
          throw new Error(`几何实例数超过安全上限 ${PARSER_LIMITS.maxGeometryInstances}`);
        }
        mods.push({
          modPath,
          instanceKey: makeInstanceKey(modPath, placementTransform, normalizedDevPath, phmFilePath, phmSolid.color),
          placementTransformMatrix: placementTransform,
          devTransformMatrix: devEntryMatrix,
          phmTransformMatrix: phmSolid.transformMatrix,
          phmColor: phmSolid.color,
          phmColorMaxA: phmDoc.colorMaxA,
          devPath: normalizedDevPath,
          phmPath: phmFilePath,
        });
      } else if (lower.endsWith('.stl')) {
        const stlPath = normalizeGeometryPath(modelFileName);
        if (strictDependencies && !getFileByPath(files, stlPath)) {
          throw new Error(`STL 文件不存在: ${stlPath}`);
        }
        budget.instances++;
        if (budget.instances > PARSER_LIMITS.maxGeometryInstances) {
          throw new Error(`几何实例数超过安全上限 ${PARSER_LIMITS.maxGeometryInstances}`);
        }
        stls.push({
          stlPath,
          instanceKey: makeInstanceKey(stlPath, placementTransform, normalizedDevPath, phmFilePath, phmSolid.color),
          placementTransformMatrix: placementTransform,
          devTransformMatrix: devEntryMatrix,
          phmTransformMatrix: phmSolid.transformMatrix,
          phmColor: phmSolid.color,
          phmColorMaxA: phmDoc.colorMaxA,
          devPath: normalizedDevPath,
          phmPath: phmFilePath,
        });
      } else {
        if (strictDependencies) {
          throw new Error(`PHM 引用了不支持的几何文件: ${modelFileName}`);
        }
        console.warn(`[modDiscovery] 未知几何引用类型: ${modelFileName}`);
      }
    }
  }

  // 2. 遍历 DEV SOLIDMODELS（变电指向 .phm；线路可能递归指向 .dev）
  for (const devSolid of devDoc.solidModels) {
    const solidModelName = devSolid.solidModelPath;
    const solidLower = solidModelName.toLowerCase();
    const devTransform = multiplyMatrices(parentTransform, devSolid.transformMatrix);

    if (solidLower.endsWith('.dev')) {
      const child = await discoverGeometriesFromDevPath(
        normalizeDevPath(solidModelName),
        files,
        devTransform,
        new Set(visited),
        depth + 1,
        budget,
        options,
      );
      mods.push(...child.mods);
      stls.push(...child.stls);
      continue;
    }

    if (!solidLower.endsWith('.phm')) {
      if (strictDependencies) {
        throw new Error(`DEV 引用了不支持的几何文件: ${solidModelName}`);
      }
      continue;
    }

    const phmFilePath = normalizePhmPath(solidModelName);
    await walkPhm(phmFilePath, devTransform, new Set(visited), devSolid.transformMatrix, depth + 1);
  }

  // 4. 变电工程 SUBDEVICE → child DEV，矩阵必须向下累积。
  for (const sub of devDoc.subDevices) {
    const childTransform = multiplyMatrices(parentTransform, sub.transformMatrix);
    const child = await discoverGeometriesFromDevPath(
      normalizeDevPath(sub.devPath),
      files,
      childTransform,
      new Set(visited),
      depth + 1,
      budget,
      options,
    );
    mods.push(...child.mods);
    stls.push(...child.stls);
  }

  return { mods, stls };
}

function parseOptionalMatrix(raw: string | undefined): number[] {
  if (!raw) return IDENTITY_MATRIX.slice();
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 16) return IDENTITY_MATRIX.slice();
  const matrix = parts.map(Number);
  return matrix.some((n) => !Number.isFinite(n)) ? IDENTITY_MATRIX.slice() : matrix;
}

/**
 * 在 CBM 树中查找目标节点，并返回其父链累积变换矩阵。
 *
 * 用于 DEV_SUBDEVICE 虚拟节点：其自身 transformMatrix 仅含 SUBDEVICE 局部变换，
 * 需要补上乘以父 CBM 链累积矩阵后，才能作为 discoverGeometriesFromNode 的 root。
 *
 * @param root CBM 树根节点
 * @param targetPath 目标节点 path
 * @returns 父链累积矩阵（列主序，长度 16）；找不到返回单位矩阵
 */
export function computeCbmParentTransform(root: CbmNode | null, targetPath: string): number[] {
  if (!root) return IDENTITY_MATRIX.slice();

  function walk(node: CbmNode, parentTransform: number[]): number[] | null {
    const local = parseOptionalMatrix(node.transformMatrix);
    const current = multiplyMatrices(parentTransform, local);

    if (node.path === targetPath) {
      // 返回父链累积矩阵（不含目标节点自身 local）
      return parentTransform;
    }

    for (const child of node.children) {
      const found = walk(child, current);
      if (found) return found;
    }
    return null;
  }

  return walk(root, IDENTITY_MATRIX.slice()) ?? IDENTITY_MATRIX.slice();
}

function matrix4(arr: number[]): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (arr.length === 16) m.fromArray(arr);
  return m;
}

function multiplyMatrices(a: number[], b: number[]): number[] {
  return matrix4(a).multiply(matrix4(b)).toArray();
}

function normalizeDevPath(path: string): string {
  const p = path.replace(/\\/g, '/');
  return p.toLowerCase().startsWith('dev/') ? p : `DEV/${p}`;
}

function normalizePhmPath(path: string): string {
  const p = path.replace(/\\/g, '/');
  return p.toLowerCase().startsWith('phm/') ? p : `PHM/${p}`;
}

function normalizeGeometryPath(path: string): string {
  const p = path.replace(/\\/g, '/');
  return p.toLowerCase().startsWith('mod/') || p.toLowerCase().startsWith('stl/') ? p : `MOD/${p}`;
}

function makeInstanceKey(path: string, matrix: number[], devPath: string, phmPath: string, color?: XmlModColor): string {
  const compactMatrix = matrix.map((n) => Number.isFinite(n) ? Number(n.toFixed(6)) : 0).join(',');
  const colorKey = color ? `#${color.r},${color.g},${color.b},${color.a}` : '';
  return `${path}#${devPath}>${phmPath}#${compactMatrix}${colorKey}`;
}
