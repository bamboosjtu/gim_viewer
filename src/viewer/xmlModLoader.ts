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
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { parseXmlMod } from '../gim/geometry/xmlModParser.js';
import { collectBakedGeometriesByMaterial } from './xmlModGeometry.js';
import type { XmlModDocument } from '../gim/geometry/xmlModParser.js';

// re-export 共享 Material / Geometry 释放函数（项目切换时由 projectCleanupService 调用）
export { disposeSharedXmlModMaterials, disposeSharedXmlModGeometries } from './xmlModGeometry.js';

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
/**
 * 按 Material 分组合并 XmlModDocument 中所有 entity 的 Geometry（方案 B：mergeGeometries 静态合并）。
 *
 * 直接从 entity 数据烘焙 TransformMatrix + mm→m 缩放到顶点，不创建中间 Mesh 对象：
 * - 避免 Object3D.applyMatrix4 → decompose → compose 精度损失（修复变压器位置偏离）
 * - 省去 77000+ 个 Mesh 对象的构造和 GC 开销（性能提升）
 * - mm→m 缩放烘焙到顶点，group.scale 保持 1，避免后续 applyPlacementTransform 的
 *   decompose 在 placement 含缩放分量时 corrupt group.scale（修复 GIS 设备位置偏离）
 *
 * 共享的 BufferGeometry（来自 _sharedGeometryCache）仅被 clone，不会被修改。
 * 共享的 Material 仍然复用（不 clone）。
 *
 * @param doc parseXmlMod 返回的 XmlModDocument
 * @returns 合并后的 Group（按 Material 分组，每组一个 merged Mesh；顶点已含 entity.transform + mm→m）
 */
function flattenDocumentToGroup(doc: XmlModDocument): THREE.Group {
  const merged = new THREE.Group();
  merged.name = `xml-mod:${doc.modPath}`;
  merged.userData.modPath = doc.modPath;

  const byMaterial = collectBakedGeometriesByMaterial(doc);

  for (const [mat, geos] of byMaterial) {
    if (geos.length === 0) continue;
    const combined = mergeGeometries(geos, false);
    if (combined) {
      merged.add(new THREE.Mesh(combined, mat));
      for (const g of geos) g.dispose();
    } else {
      // mergeGeometries 失败（attributes 不一致等）：回退到独立 Mesh，避免 entity 丢失
      console.warn(`[xmlModLoader] mergeGeometries 失败，回退到独立 Mesh: ${doc.modPath}`, {
        geoCount: geos.length,
        attributes: geos.map(g => Object.keys(g.attributes)),
      });
      for (const g of geos) {
        merged.add(new THREE.Mesh(g, mat));
        // 不 dispose g — 已交给 Mesh 使用
      }
    }
  }

  // 不设置 group.scale：mm→m 缩放已在 collectBakedGeometriesByMaterial 中烘焙到顶点
  // 保持 group.scale = 1，避免后续 applyPlacementTransformToSceneUnits 的 decompose corrupt scale
  return merged;
}

export function loadXmlModFromText(modText: string, modPath: string): THREE.Group {
  const doc = parseXmlMod(modText, modPath);
  return flattenDocumentToGroup(doc);
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
 * 应用已累积的 CBM/DEV/SUBDEVICE/PHM 放置矩阵（顶点烘焙版）。
 *
 * 关键修复：改为遍历 group 的 mesh，直接对 geometry.applyMatrix4(matrix)
 * 烘焙到顶点，避免 Object3D.applyMatrix4 的 premultiply + decompose 链路。
 *
 * 修复背景：当 placement matrix 含缩放分量 s 时，group.applyMatrix4(matrix)
 * 会执行 `this.matrix.premultiply(matrix)` + `this.matrix.decompose(...)`，
 * decompose 从 `matrix × group.matrix` 提取 scale，导致 group.scale 被错误修改
 *（如 s≠1 时 group.scale 从 1 变为 s，几何被错误缩放）。
 *
 * 顶点烘焙直接变换 BufferGeometry 的 position attribute，数学上精确，
 * 不会触发 decompose，因此 placement 的旋转/平移/缩放/剪切都能正确应用到几何。
 *
 * 单位处理：MOD/STL 顶点已在加载阶段烘焙 mm→m 缩放（顶点单位为米），
 * placement 平移量单位为毫米，这里 × 0.001 转为米后烘焙到顶点，单位一致。
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
  // 烘焙到顶点：避免 Object3D.applyMatrix4 + decompose 在 placement 含缩放时 corrupt group.scale
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.applyMatrix4(matrix);
    }
  });
}

/**
 * 从 Group 中移除 mesh 并 dispose merged geometry。
 *
 * 方案 B（mergeGeometries 静态合并）后，每个 MOD Group 的 merged geometry 是 unique 的
 *（合并时 clone+烘焙，不再共享），需要在移除时逐 mesh dispose。
 * Material 仍共享（_sharedMaterialCache），不在此处 dispose。
 * Base geometry 缓存（_sharedGeometryCache）仍存在，由 disposeSharedXmlModGeometries 统一释放。
 *
 * 此函数由 projectCleanupService 调用。
 */
export function disposeXmlModGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose?.();
  });
}
