/**
 * 变电 XML MOD primitive → Three.js BufferGeometry 转换。
 *
 * 14 类 primitive 转换策略：
 * - 基础体（SAFE_PRIMITIVES）：精确几何，经样本验证渲染正确
 * - 复杂体（StretchedBody / PorcelainBushing / TerminalBlock / ChannelSteel / Table）：
 *   MVP 阶段暂停渲染，避免错误几何污染场景
 * - 弱 schema 3 类：暂不渲染，避免占位盒污染场景
 *
 * TransformMatrix 应用：
 * - GIM 矩阵实测为列主序展开（平移在 m[12], m[13], m[14]）
 * - 等同于 Three.js Matrix4.elements 数组布局
 * - 使用 Matrix4.fromArray() 直接加载
 *
 * Color 应用：
 * - R/G/B 范围 0-255 → setRGB(r/255, g/255, b/255)
 * - A 范围 0-100（透明度百分比）→ opacity = a/100
 *
 * 单位：
 * - MOD 原始尺寸/平移为毫米
 * - IFC 当前场景为米量级
 * - xmlModDocumentToGroup 在 Group 层统一缩放 0.001，避免逐 primitive 丢精度
 */

import * as THREE from 'three';
import type {
  XmlModColor,
  XmlModEntity,
  XmlModPrimitive,
} from '../gim/geometry/ir.js';
import type { XmlModDocument } from '../gim/geometry/xmlModParser.js';

const MOD_MM_TO_SCENE_UNIT = 0.001;
const CYLINDER_SEGMENTS = 16;
const SPHERE_WIDTH_SEGMENTS = 16;
const SPHERE_HEIGHT_SEGMENTS = 8;
const TORUS_RADIAL_SEGMENTS = 8;
const TORUS_TUBULAR_SEGMENTS = 16;

/** 去重 warn（每种 primitive 只 warn 一次） */
const _warnedOnce = new Set<string>();

/**
 * 共享 Material 缓存：按 (colorHex, opacity, transparent) 聚类。
 *
 * 修复背景：变电工程约 78000+ Entity，若每个 Entity 独立 new MeshStandardMaterial，
 * GPU 内存累积导致 OOM 崩溃。实证样本中颜色种类有限（数十个），
 * 通过共享缓存可将 Material 数量从 78000+ 降到几十个。
 *
 * 共享 Material 不可在 disposeXmlModGroup 中逐 mesh dispose，
 * 必须由 disposeSharedXmlModMaterials 统一释放（项目切换时调用）。
 */
const _sharedMaterialCache = new Map<string, THREE.MeshStandardMaterial>();

/** 默认 Material（无 color 字段的 Entity 使用） */
let _sharedDefaultMaterial: THREE.MeshStandardMaterial | null = null;

/**
 * 共享 Geometry 缓存：按 (modPath, primitiveType, primitiveParamsSignature) 聚类。
 *
 * 修复背景（方案 A，详见 docs/schema/17-batch-load-schema.md §12）：
 * Material 共享后仍崩溃，根因是每 Entity 独立 new BufferGeometry。
 * 实证 66.2% MOD 文件被多实例引用（09 号 §11.4），同 modPath 多实例
 * 解析同一 XML 得到相同 primitive 参数 → 可共享同一 BufferGeometry。
 *
 * 共享 Geometry 不可在 disposeXmlModGroup 中逐 mesh dispose，
 * 必须由 disposeSharedXmlModGeometries 统一释放（项目切换时调用）。
 *
 * 注意：Entity.TransformMatrix 在 entityToMesh 中烘焙到 Mesh.matrix，
 * 不影响 geometry 顶点数据，因此同 modPath+primitive 实例共享 geometry 是安全的。
 */
const _sharedGeometryCache = new Map<string, THREE.BufferGeometry>();

/**
 * 释放所有共享 Material 缓存。
 *
 * 调用时机：项目切换时（projectCleanupService）。
 * 调用前需确保所有引用这些 Material 的 Mesh 已从 scene 移除。
 */
export function disposeSharedXmlModMaterials(): void {
  for (const mat of _sharedMaterialCache.values()) {
    mat.dispose();
  }
  _sharedMaterialCache.clear();
  if (_sharedDefaultMaterial) {
    _sharedDefaultMaterial.dispose();
    _sharedDefaultMaterial = null;
  }
}

/**
 * 释放所有共享 Geometry 缓存。
 *
 * 调用时机：项目切换时（projectCleanupService），在 disposeSharedXmlModMaterials
 * 之前或之后均可（两者独立）。
 * 调用前需确保所有引用这些 Geometry 的 Mesh 已从 scene 移除。
 */
export function disposeSharedXmlModGeometries(): void {
  for (const geo of _sharedGeometryCache.values()) {
    geo.dispose();
  }
  _sharedGeometryCache.clear();
}

/**
 * 将 primitive 转换为 Three.js BufferGeometry（无缓存版本，内部使用）。
 *
 * 14 类 primitive：
 * - 6 类基础体：Cylinder/Cuboid/Sphere/TruncatedCone/Ring/CircularGasket — 精确几何
 * - 5 类暂停：StretchedBody/PorcelainBushing/TerminalBlock/ChannelSteel/Table — MVP 跳过
 * - 3 类弱 schema：RectangularFixedPlate/OffsetRectangularTable/RectangularRing — 暂停渲染
 */
function primitiveToGeometryUncached(p: XmlModPrimitive): THREE.BufferGeometry | null {
  switch (p.type) {
    case 'Cylinder':
      return new THREE.CylinderGeometry(sanitizeNum(p.r), sanitizeNum(p.r), sanitizeNum(p.h), CYLINDER_SEGMENTS);
    case 'Cuboid':
      return new THREE.BoxGeometry(sanitizeNum(p.l), sanitizeNum(p.w), sanitizeNum(p.h));
    case 'Sphere':
      return new THREE.SphereGeometry(sanitizeNum(p.r), SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS);
    case 'TruncatedCone':
      return new THREE.CylinderGeometry(sanitizeNum(p.tr), sanitizeNum(p.br), sanitizeNum(p.h), CYLINDER_SEGMENTS);
    case 'Ring':
      return new THREE.TorusGeometry(sanitizeNum(p.r), sanitizeNum(p.dr) / 2, TORUS_RADIAL_SEGMENTS, TORUS_TUBULAR_SEGMENTS, sanitizeNum(p.rad));
    case 'CircularGasket':
      return new THREE.TorusGeometry(sanitizeNum(p.or), Math.max(0, (sanitizeNum(p.or) - sanitizeNum(p.ir)) / 2), TORUS_RADIAL_SEGMENTS, TORUS_TUBULAR_SEGMENTS, sanitizeNum(p.rad));
    case 'StretchedBody':
    case 'PorcelainBushing':
    case 'TerminalBlock':
    case 'ChannelSteel':
    case 'Table':
      // MVP 阶段暂停渲染 — 返回 null 避免创建空 Mesh
      if (!_warnedOnce.has(p.type)) {
        _warnedOnce.add(p.type);
        console.warn(`[xmlModGeometry] "${p.type}" MVP 暂停渲染（几何解释待完善）`);
      }
      return null;
    case 'RectangularFixedPlate':
    case 'OffsetRectangularTable':
    case 'RectangularRing':
      if (!_warnedOnce.has(p.type)) {
        _warnedOnce.add(p.type);
        console.warn(`[xmlModGeometry] weak schema primitive "${p.type}" 暂停渲染（字段语义待补充）`);
      }
      return null;
    default:
      {
        const unknownType = (p as { type?: string }).type ?? 'unknown';
        if (!_warnedOnce.has(unknownType)) {
          _warnedOnce.add(unknownType);
          console.warn(`[xmlModGeometry] 未支持 primitive "${unknownType}"，已跳过`);
        }
      }
      return null;
  }
}

/**
 * 构造 primitive 参数签名（用于 Geometry 缓存键）。
 *
 * 仅提取影响几何形状的参数（半径/高度/分段等），不包含 TransformMatrix。
 * 同 modPath + 同 primitive 类型 + 同参数 → 同一 BufferGeometry。
 */
function primitiveSignature(p: XmlModPrimitive): string {
  switch (p.type) {
    case 'Cuboid':
      return `${sanitizeNum(p.l)},${sanitizeNum(p.w)},${sanitizeNum(p.h)}`;
    case 'Cylinder':
      return `r=${sanitizeNum(p.r)},h=${sanitizeNum(p.h)}`;
    case 'TruncatedCone':
      return `br=${sanitizeNum(p.br)},tr=${sanitizeNum(p.tr)},h=${sanitizeNum(p.h)}`;
    case 'Sphere':
      return `r=${sanitizeNum(p.r)}`;
    case 'Ring':
      return `r=${sanitizeNum(p.r)},dr=${sanitizeNum(p.dr)},rad=${sanitizeNum(p.rad)}`;
    case 'CircularGasket':
      return `or=${sanitizeNum(p.or)},ir=${sanitizeNum(p.ir)},rad=${sanitizeNum(p.rad)},h=${sanitizeNum(p.h)}`;
    // 暂停渲染的 primitive 不会进入缓存（primitiveToGeometryUncached 返回 null）
    default:
      return JSON.stringify(p);
  }
}

/**
 * 将 primitive 转换为 Three.js BufferGeometry（共享缓存版本）。
 *
 * 按 (modPath, primitiveType, primitiveParamsSignature) 缓存：
 * - 同 modPath 同参数 primitive 共享同一 BufferGeometry 实例
 * - 66.2% MOD 文件多实例引用时，避免重复构造几何
 * - Entity.TransformMatrix 不影响 geometry 顶点，由 entityToMesh 烘焙到 Mesh.matrix
 *
 * @param p primitive 描述
 * @param modPath MOD 文件路径（用于缓存键，区分不同 MOD 文件的同型 primitive）
 */
export function primitiveToGeometry(p: XmlModPrimitive, modPath: string): THREE.BufferGeometry | null {
  const sig = `${modPath}:${p.type}:${primitiveSignature(p)}`;
  const cached = _sharedGeometryCache.get(sig);
  if (cached) return cached;
  const geo = primitiveToGeometryUncached(p);
  if (geo) _sharedGeometryCache.set(sig, geo);
  return geo;
}

/**
 * GIM TransformMatrix → Three.js Matrix4。
 *
 * 样本研究结论：GIM 矩阵为列主序展开，平移在 m[12]/m[13]/m[14]，
 * 等同于 Three.js Matrix4.elements 数组布局。
 */
export function gimMatrixToMatrix4(arr: number[]): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (!Array.isArray(arr) || arr.length !== 16) return m;
  m.fromArray(arr);
  return m;
}

/**
 * 将 Entity 转换为 Three.Mesh。
 *
 * - primitive → geometry（共享缓存，需传入 modPath）
 * - color → material（共享缓存）
 * - transformMatrix → fromArray（列主序，与 GIM 实测布局一致）
 *
 * @param e entity 描述
 * @param modPath MOD 文件路径（用于 Geometry 共享缓存键）
 */
export function entityToMesh(e: XmlModEntity, modPath: string): THREE.Mesh | null {
  const geometry = primitiveToGeometry(e.primitive, modPath);
  if (!geometry) return null;

  const material = colorToMaterial(e.color);
  const mesh = new THREE.Mesh(geometry, material);

  if (e.transformMatrix.length === 16) {
    mesh.applyMatrix4(gimMatrixToMatrix4(e.transformMatrix));
  }

  return mesh;
}

/**
 * Color → 共享 MeshStandardMaterial。
 *
 * 按 (colorHex, opacity, transparent) 聚类缓存：
 * - 同色同透明度的 Entity 共享同一 Material 实例
 * - Material 不可在 disposeXmlModGroup 中 dispose（共享）
 * - 项目切换时由 disposeSharedXmlModMaterials 统一释放
 */
function colorToMaterial(color: XmlModColor | undefined): THREE.MeshStandardMaterial {
  if (!color) {
    if (!_sharedDefaultMaterial) {
      _sharedDefaultMaterial = new THREE.MeshStandardMaterial({
        color: 0x888888,
        transparent: false,
      });
    }
    return _sharedDefaultMaterial;
  }
  const hex =
    (clamp255(color.r) << 16) |
    (clamp255(color.g) << 8) |
    clamp255(color.b);
  const opacity = clamp100(color.a) / 100;
  const transparent = color.a < 100;
  const key = `${hex}_${opacity}_${transparent}`;
  let material = _sharedMaterialCache.get(key);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      color: hex,
      transparent,
      opacity,
    });
    _sharedMaterialCache.set(key, material);
  }
  return material;
}

function clamp255(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function clamp100(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** 将整个 XmlModDocument 转换为 THREE.Group */
export function xmlModDocumentToGroup(doc: XmlModDocument): THREE.Group {
  const group = new THREE.Group();
  group.name = `xml-mod:${doc.modPath}`;
  if (doc.isEmpty) return group;

  for (const entity of doc.entities) {
    const mesh = entityToMesh(entity, doc.modPath);
    if (!mesh) continue; // 跳过暂停渲染的 primitive
    mesh.visible = entity.visible;
    group.add(mesh);
  }
  group.scale.setScalar(MOD_MM_TO_SCENE_UNIT);
  return group;
}

function sanitizeNum(n: number): number {
  return Number.isNaN(n) ? 0 : n;
}
