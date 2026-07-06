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
 * 将 primitive 转换为 Three.js BufferGeometry。
 *
 * 14 类 primitive：
 * - 6 类基础体：Cylinder/Cuboid/Sphere/TruncatedCone/Ring/CircularGasket — 精确几何
 * - 5 类暂停：StretchedBody/PorcelainBushing/TerminalBlock/ChannelSteel/Table — MVP 跳过
 * - 3 类弱 schema：RectangularFixedPlate/OffsetRectangularTable/RectangularRing — 暂停渲染
 */
export function primitiveToGeometry(p: XmlModPrimitive): THREE.BufferGeometry | null {
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
 * - primitive → geometry
 * - color → material
 * - transformMatrix → fromArray（列主序，与 GIM 实测布局一致）
 */
export function entityToMesh(e: XmlModEntity): THREE.Mesh | null {
  const geometry = primitiveToGeometry(e.primitive);
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
    const mesh = entityToMesh(entity);
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
