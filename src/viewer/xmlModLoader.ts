/**
 * 变电 XML MOD 文件加载入口。
 *
 * 把 MOD 文件 buffer 转换为 Three.js Group。
 *
 * 与 IFC 加载器（ifcEntryLoader）的差异：
 * - 不使用 OBC Fragments（IFC 专用）
 * - 直接添加到 ctx.world.scene.three（与 IFC fragments 共存于同一 scene）
 * - 独立跟踪（state.loadedXmlModGroups），不与 IFC loadedModels 混用
 *
 * 引用链：CBM → DEV → PHM → MOD
 * - Entity 内部 TransformMatrix 由 entityToMesh 应用（primitive 局部坐标 → MOD 局部空间）
 * - CBM/DEV/SUBDEVICE/PHM 外部矩阵由调用方累积后应用（MOD 局部空间 → 工程坐标）
 * - MOD Group 在 xmlModDocumentToGroup 中统一从毫米缩放到 IFC 场景米量级
 *
 * P0 范围：
 * - 仅处理 currentFiles 非空场景（首次打开）
 * - 缓存命中场景（currentFiles=null）由 P2 实现
 */

import * as THREE from 'three';
import { parseXmlMod } from '../gim/geometry/xmlModParser.js';
import { xmlModDocumentToGroup } from './xmlModGeometry.js';

const RENDERABLE_MOD_PRIMITIVE_RE = /<(Cylinder|Cuboid|Sphere|TruncatedCone|Ring|CircularGasket)\b/;
const GIM_MATRIX_TRANSLATION_TO_SCENE_UNIT = 0.001;

/**
 * 从 XML 文本加载 MOD 文件并转换为 Three.js Group。
 *
 * 内部步骤：
 * 1. parseXmlMod → XmlModDocument
 * 2. xmlModDocumentToGroup → THREE.Group（Entity 内部 TransformMatrix 已应用，单位已缩放）
 *
 * @param modText MOD 文件 XML 文本
 * @param modPath MOD 文件路径（如 "MOD/abc.mod"），用于 Group.name 与错误消息
 * @returns THREE.Group（已应用 Entity 内部 TransformMatrix；外部矩阵待应用）
 * @throws XML 解析失败时抛错（由调用方 try/catch）
 */
export function loadXmlModFromText(modText: string, modPath: string): THREE.Group {
  const doc = parseXmlMod(modText, modPath);
  return xmlModDocumentToGroup(doc);
}

/**
 * 从 GIM 解压文件集合加载 MOD 文件。
 *
 * @param modPath 完整路径（如 "MOD/abc.mod"）
 * @param files GIM 解压后的文件集合
 * @returns THREE.Group；找不到文件或解析失败返回 null
 */
export async function loadXmlModFromFiles(
  modPath: string,
  files: Map<string, File>,
): Promise<THREE.Group | null> {
  const file = files.get(modPath);
  if (!file) {
    console.warn(`[xmlModLoader] MOD 文件不存在: ${modPath}`);
    return null;
  }
  // 使用 arrayBuffer + TextDecoder 而非 file.text()，确保跨运行时（浏览器/jsdom）兼容
  const buffer = await file.arrayBuffer();
  const text = new TextDecoder().decode(buffer);
  try {
    if (!RENDERABLE_MOD_PRIMITIVE_RE.test(text)) {
      const group = new THREE.Group();
      group.name = `xml-mod:${modPath}`;
      return group;
    }
    return loadXmlModFromText(text, modPath);
  } catch (err) {
    console.error(`[xmlModLoader] MOD 解析失败: ${modPath}`, err);
    return null;
  }
}

/**
 * GIM DEV/PHM 变换矩阵 → Three.js Matrix4。
 *
 * 样本研究结论：GIM 矩阵实际为列主序展开，平移在 m[12]/m[13]/m[14]，
 * 等同于 Three.js Matrix4.elements 数组布局。使用 fromArray 直接加载。
 *
 * 长度不为 16 时返回单位矩阵。
 */
export function rowMajorToMatrix4(arr: number[]): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (!Array.isArray(arr) || arr.length !== 16) return m;
  m.fromArray(arr);
  return m;
}

/**
 * 应用外部变换矩阵（DEV + PHM）到 MOD Group。
 *
 * @deprecated 使用 applyPlacementTransformToSceneUnits。
 * 此函数不缩放平移分量，且缺少 CBM/SUBDEVICE 累积矩阵，不能表达完整 placement。
 *
 * 应用顺序：先 PHM（MOD 坐标 → 装配坐标），后 DEV（装配坐标 → 设备坐标）。
 * 即：final = DEV × PHM × MOD-local
 *
 * @param group xmlModDocumentToGroup 返回的 Group（已含 Entity 内部 TransformMatrix）
 * @param devTransformMatrix DEV SOLIDMODELS 块的 TRANSFORMMATRIX（列主序，长度 16）
 * @param phmTransformMatrix PHM SOLIDMODELn 的 TRANSFORMMATRIX（列主序，长度 16）
 */
export function applyExternalTransforms(
  group: THREE.Group,
  devTransformMatrix: number[],
  phmTransformMatrix: number[],
): void {
  // 先应用 PHM 矩阵（MOD local → PHM/assembly space）
  group.applyMatrix4(rowMajorToMatrix4(phmTransformMatrix));
  // 再应用 DEV 矩阵（PHM/assembly → device space）
  group.applyMatrix4(rowMajorToMatrix4(devTransformMatrix));
}

/**
 * 应用已累积的 CBM/DEV/SUBDEVICE/PHM 放置矩阵。
 *
 * MOD 文件内部几何在 xmlModDocumentToGroup 中统一缩放 0.001；外部装配矩阵的
 * 平移量同样来自 GIM 工程长度单位，需要在应用到已缩放 Group 前缩到 viewer 单位。
 * 旋转/缩放分量保持不变。
 */
export function applyPlacementTransformToSceneUnits(
  group: THREE.Group,
  transformMatrix: number[] | null | undefined,
): void {
  if (!Array.isArray(transformMatrix) || transformMatrix.length !== 16) return;
  const matrix = rowMajorToMatrix4(transformMatrix);
  matrix.elements[12] *= GIM_MATRIX_TRANSLATION_TO_SCENE_UNIT;
  matrix.elements[13] *= GIM_MATRIX_TRANSLATION_TO_SCENE_UNIT;
  matrix.elements[14] *= GIM_MATRIX_TRANSLATION_TO_SCENE_UNIT;
  group.applyMatrix4(matrix);
}

/**
 * 释放 xml-mod Group 的 GPU 资源（geometry + material）。
 *
 * 由 projectCleanupService 在切换项目时调用。
 * 调用前需已从 scene 移除（scene.remove(group)）。
 */
export function disposeXmlModGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose());
    } else if (material) {
      material.dispose();
    }
  });
}
