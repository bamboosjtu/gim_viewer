/**
 * 变电 XML MOD primitive → Three.js BufferGeometry 转换。
 *
 * 14 类 primitive 转换策略：
 * - 基础体（SAFE_PRIMITIVES）：精确几何，经样本验证渲染正确
 * - StretchedBody：按任意平面截面 + 法向拉伸构造精确棱柱
 * - 其余复杂体（PorcelainBushing / TerminalBlock / ChannelSteel / Table）：
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
import { Brush, Evaluator, ADDITION, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import type {
  XmlModColor,
  XmlModEntity,
  XmlModPrimitive,
} from '../gim/geometry/ir.js';
import type { XmlModDocument } from '../gim/geometry/xmlModParser.js';

const MOD_MM_TO_SCENE_UNIT = 0.001;
export { MOD_MM_TO_SCENE_UNIT };
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
 * 共享 Geometry 缓存：按 (primitiveType, primitiveParamsSignature) 全局聚类。
 *
 * 演进历程：
 * - v1（FIX-3 后续）：每 Entity 独立 new BufferGeometry → 78000+ Geometry，OOM
 * - v2（方案 A.0）：按 (modPath, type, params) 缓存 → 同 modPath 多实例共享，-40%
 * - v3（方案 A.1，当前）：移除 modPath，全局共享 → 跨 modPath 同参数 primitive 共享，-80%+
 *
 * 安全性：BufferGeometry 仅含顶点数据（position/normal/uv），由 primitive 参数决定。
 * Entity.TransformMatrix 烘焙到 mesh.matrix，不影响 geometry 顶点。
 * 因此"同参数 → 同顶点数据"无论来自哪个 modPath，共享都安全。
 *
 * 实证收益：变电站工程中 Cylinder/Cuboid 等基础体在多个 MOD 文件中重复出现，
 * 全局共享后 Geometry 数从 ~46000 降到几千个。
 */
const _sharedGeometryCache = new Map<string, THREE.BufferGeometry>();

/** 标记 PHM 颜色覆盖创建的实例材质，便于项目切换时安全释放。 */
const INSTANCE_MATERIAL_FLAG = '__gimOwnedInstanceMaterial';
const INSTANCE_COLOR_KEY = '__gimPhmColorKey';

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
 * 释放 Group 内由 PHM 颜色覆盖创建的实例材质。
 *
 * MOD 原始材质来自共享缓存，不能在 Group 清理时逐个 dispose；只有带有
 * INSTANCE_MATERIAL_FLAG 的 clone 才由该函数负责释放。
 */
export function disposeOwnedXmlModMaterials(group: THREE.Object3D): void {
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      if ((material.userData as Record<string, unknown> | undefined)?.[INSTANCE_MATERIAL_FLAG] === true) {
        material.dispose();
      }
    }
  });
}

/**
 * 将 primitive 转换为 Three.js BufferGeometry（无缓存版本，内部使用）。
 *
 * 14 类 primitive：
 * - 6 类基础体：Cylinder/Cuboid/Sphere/TruncatedCone/Ring/CircularGasket — 精确几何
 * - StretchedBody：任意平面多边形沿 Normal 拉伸 L
 * - 4 类暂停：PorcelainBushing/TerminalBlock/ChannelSteel/Table — MVP 跳过
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
    case 'Wire': {
      // 变电软母线：拟合点样条管（绝对 mm 坐标，后续烘焙 mm→m）
      const pts = p.fitPoints;
      if (pts.length < 6) return null;
      const curve = new THREE.CatmullRomCurve3(vec3Array(pts));
      return new THREE.TubeGeometry(curve, Math.min(Math.max(pts.length / 3, 8), 256), Math.max(sanitizeNum(p.d) / 2, 1), 6, false);
    }
    case 'Cable': {
      // 电缆敷设路径：拐点折线圆管
      const pts = p.inflectionPoints;
      if (pts.length < 6) return null;
      const curve = new THREE.CatmullRomCurve3(vec3Array(pts));
      return new THREE.TubeGeometry(curve, Math.min(Math.max(pts.length / 3, 8), 256), Math.max(sanitizeNum(p.d) / 2, 1), 6, false);
    }
    case 'RotationalEllipsoid': {
      // 近似：单位球按三轴（LR/WR/H 作全长）缩放
      const geo = new THREE.SphereGeometry(0.5, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS);
      geo.scale(Math.max(sanitizeNum(p.lr), 1), Math.max(sanitizeNum(p.wr), 1), Math.max(sanitizeNum(p.h), 1));
      return geo;
    }
    case 'BeamChannelLike':
      // 截面需型号查表，暂用近似盒体（100×L×50），docs/schema/08 §P0-3 已标注近似语义
      return new THREE.BoxGeometry(100, Math.max(sanitizeNum(p.length), 1), 50);
    case 'StretchedBody':
      return createStretchedBodyGeometry(p.array, p.normal, p.l);
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
    case 'StretchedBody':
      return `l=${sanitizeNum(p.l)},array=${p.array},normal=${p.normal}`;
    // 暂停渲染的 primitive 不会进入缓存（primitiveToGeometryUncached 返回 null）
    default:
      return JSON.stringify(p);
  }
}

/**
 * 将 StretchedBody.Array 解析为三维截面点。
 *
 * 真实样例使用 `x,y,z;...;`，早期文档示例也出现过 `x,y;...;`；
 * 二维点按 z=0 兼容。连续重复点和闭合尾点会被移除，避免 Earcut 退化。
 */
function parseStretchedBodyPoints(raw: string): THREE.Vector3[] {
  const parsed = raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(',').map((value) => Number(value.trim())))
    .filter((values) => (values.length === 2 || values.length === 3) && values.every(Number.isFinite))
    .map((values) => new THREE.Vector3(values[0], values[1], values[2] ?? 0));

  const points: THREE.Vector3[] = [];
  for (const point of parsed) {
    if (points.length === 0 || !point.equals(points[points.length - 1])) points.push(point);
  }
  if (points.length > 2 && points[0].equals(points[points.length - 1])) points.pop();
  return points;
}

function parseStretchedBodyNormal(raw: string): THREE.Vector3 | null {
  const values = raw.split(',').map((value) => Number(value.trim()));
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) return null;
  const normal = new THREE.Vector3(values[0], values[1], values[2]);
  return normal.lengthSq() > Number.EPSILON ? normal.normalize() : null;
}

/**
 * 构造任意平面截面的拉伸体。
 *
 * Array 中的点已经位于 MOD 局部三维坐标，不能先压成 XY 再靠旋转猜回位置。
 * 这里仅把点投影到与 Normal 正交的二维基底以完成凹多边形三角剖分，最终顶点仍
 * 直接使用原始三维点，并沿归一化 Normal 拉伸 L。
 */
function createStretchedBodyGeometry(array: string, normalRaw: string, lengthRaw: number): THREE.BufferGeometry | null {
  let points = parseStretchedBodyPoints(array);
  const normal = parseStretchedBodyNormal(normalRaw);
  const length = Math.abs(sanitizeNum(lengthRaw));
  if (points.length < 3 || !normal || length <= Number.EPSILON) return null;

  const reference = Math.abs(normal.z) < 0.9
    ? new THREE.Vector3(0, 0, 1)
    : new THREE.Vector3(0, 1, 0);
  const axisU = new THREE.Vector3().crossVectors(reference, normal).normalize();
  const axisV = new THREE.Vector3().crossVectors(normal, axisU).normalize();

  let contour = points.map((point) => new THREE.Vector2(point.dot(axisU), point.dot(axisV)));
  // 统一为从 +Normal 方向观察时逆时针，便于侧面法向稳定朝外。
  if (THREE.ShapeUtils.isClockWise(contour)) {
    points = points.slice().reverse();
    contour = contour.slice().reverse();
  }

  const capTriangles = THREE.ShapeUtils.triangulateShape(contour, []);
  if (capTriangles.length === 0) return null;

  const extrusion = normal.clone().multiplyScalar(length);
  const positions: number[] = [];
  const pushTriangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, expectedNormal: THREE.Vector3) => {
    const actual = new THREE.Vector3().crossVectors(
      new THREE.Vector3().subVectors(b, a),
      new THREE.Vector3().subVectors(c, a),
    );
    if (actual.dot(expectedNormal) < 0) [b, c] = [c, b];
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };

  for (const [ia, ib, ic] of capTriangles) {
    const a = points[ia];
    const b = points[ib];
    const c = points[ic];
    pushTriangle(a, b, c, normal.clone().negate());
    pushTriangle(a.clone().add(extrusion), b.clone().add(extrusion), c.clone().add(extrusion), normal);
  }

  for (let i = 0; i < points.length; i++) {
    const next = (i + 1) % points.length;
    const a = points[i];
    const b = points[next];
    const topA = a.clone().add(extrusion);
    const topB = b.clone().add(extrusion);
    const outward = new THREE.Vector3().crossVectors(
      new THREE.Vector3().subVectors(b, a),
      normal,
    ).normalize();
    pushTriangle(a, b, topB, outward);
    pushTriangle(a, topB, topA, outward);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  // 与 Three.js 内置几何保持 indexed + position/normal/uv 属性布局一致，
  // 否则同材质的 StretchedBody 与 Cylinder/Cuboid 在 mergeGeometries 时会整体回退。
  geometry.setIndex(Array.from({ length: positions.length / 3 }, (_, index) => index));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((positions.length / 3) * 2).fill(0), 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * 将 primitive 转换为 Three.js BufferGeometry（全局共享缓存版本，A.1）。
 *
 * 按 (primitiveType, primitiveParamsSignature) 全局缓存：
 * - 同参数 primitive 全局共享同一 BufferGeometry 实例（跨 modPath）
 * - 变电站工程中基础体参数重复率高，全局共享后 Geometry 数 -80%+
 * - Entity.TransformMatrix 不影响 geometry 顶点，由 entityToMesh 烘焙到 Mesh.matrix
 *
 * v3（A.1）变更：移除 modPath 缓存键，跨 modPath 共享。
 * 安全性：BufferGeometry 仅含顶点数据，由 primitive 参数决定，与 modPath 无关。
 *
 * @param p primitive 描述
 * @param modPath MOD 文件路径（保留参数兼容性，A.1 起不再参与缓存键）
 */
export function primitiveToGeometry(p: XmlModPrimitive, modPath?: string): THREE.BufferGeometry | null {
  // v3（A.1）：modPath 不再参与缓存键，跨 modPath 全局共享
  void modPath; // 标记参数已废弃，保留兼容性
  const sig = `${p.type}:${primitiveSignature(p)}`;
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
export function entityToMesh(
  e: XmlModEntity,
  modPath: string,
  colorMaxA = 100,
): THREE.Mesh | null {
  const geometry = primitiveToGeometry(e.primitive, modPath);
  if (!geometry) return null;

  const material = colorToMaterial(e.color, colorMaxA);
  const mesh = new THREE.Mesh(geometry, material);

  if (e.transformMatrix.length === 16) {
    mesh.applyMatrix4(gimMatrixToMatrix4(e.transformMatrix));
  }

  return mesh;
}

/**
 * A 原始值 → 不透明度。
 *
 * 规则（docs/schema/10 §P3-2 实测四工具）：
 * - A=0 是 Bentley/BIMBase 的「不透明哨兵」（占绝对主导），不是全透明
 * - 刻度按文件级 maxA 判定：maxA > 100 → 字节制(/255)，否则百分制(/100)
 */
function resolveOpacity(a: number, maxA: number): { opacity: number; transparent: boolean } {
  if (a <= 0) return { opacity: 1, transparent: false };
  const scale = maxA > 100 ? 255 : 100;
  const opacity = Math.min(a / scale, 1);
  return { opacity, transparent: opacity < 1 };
}

/**
 * Color → 共享 MeshStandardMaterial。
 *
 * 按 (colorHex, opacity, transparent) 聚类缓存：
 * - 同色同透明度的 Entity 共享同一 Material 实例
 * - Material 不可在 disposeXmlModGroup 中 dispose（共享）
 * - 项目切换时由 disposeSharedXmlModMaterials 统一释放
 */
function colorToMaterial(color: XmlModColor | undefined, colorMaxA = 100): THREE.MeshStandardMaterial {
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
  const { opacity, transparent } = resolveOpacity(clamp255(color.a), colorMaxA);
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

/**
 * 将 PHM COLORn 覆盖应用到一个已加载的 MOD/STL Group。
 *
 * PHM 颜色是实例级属性，不能直接修改 XML MOD 的共享材质；这里为每个
 * Mesh 材质创建 clone，再写入 RGB/opacity。A=0 按不透明哨兵处理，
 * `colorMaxA > 100` 时按字节制（/255），否则按百分制（/100）。
 *
 * @returns 实际被覆盖的 Mesh 数量
 */
export function applyPhmColorOverride(
  group: THREE.Object3D,
  color?: XmlModColor,
  colorMaxA?: number,
): number {
  if (!color) return 0;
  const maxA = Number.isFinite(colorMaxA) && (colorMaxA as number) > 0
    ? (colorMaxA as number)
    : color.a;
  const hex = (clamp255(color.r) << 16) | (clamp255(color.g) << 8) | clamp255(color.b);
  const { opacity, transparent } = resolveOpacity(clamp255(color.a), maxA);
  const colorKey = `${hex}_${opacity}_${transparent}`;
  let affected = 0;

  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const applyOne = (source: THREE.Material): THREE.Material => {
      const sourceData = source.userData as Record<string, unknown> | undefined;
      if (sourceData?.[INSTANCE_MATERIAL_FLAG] === true && sourceData[INSTANCE_COLOR_KEY] === colorKey) {
        return source;
      }
      const material = source.clone();
      const materialData = { ...(material.userData ?? {}) } as Record<string, unknown>;
      materialData[INSTANCE_MATERIAL_FLAG] = true;
      materialData[INSTANCE_COLOR_KEY] = colorKey;
      material.userData = materialData;
      const colorTarget = (material as THREE.Material & { color?: THREE.Color }).color;
      if (colorTarget) colorTarget.setHex(hex);
      material.opacity = opacity;
      material.transparent = transparent;
      material.needsUpdate = true;
      // Re-applying a different override must not leak the previous clone.
      if (sourceData?.[INSTANCE_MATERIAL_FLAG] === true) source.dispose();
      return material;
    };
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map(applyOne);
    } else {
      mesh.material = applyOne(mesh.material);
    }
    affected++;
  });
  return affected;
}

function clamp255(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** 将整个 XmlModDocument 转换为 THREE.Group */
export function xmlModDocumentToGroup(doc: XmlModDocument): THREE.Group {
  const group = new THREE.Group();
  group.name = `xml-mod:${doc.modPath}`;
  if (doc.isEmpty) return group;

  for (const entity of doc.entities) {
    const mesh = entityToMesh(entity, doc.modPath, doc.colorMaxA);
    if (!mesh) continue; // 跳过暂停渲染的 primitive
    mesh.visible = entity.visible;
    group.add(mesh);
  }
  group.scale.setScalar(MOD_MM_TO_SCENE_UNIT);
  return group;
}

/**
 * 收集文档中所有可见 entity 的 baked geometry（已烘焙 TransformMatrix + mm→m 缩放），按 Material 分组。
 *
 * 方案 B 专用：直接从 entity 数据烘焙 transform 到 geometry 顶点，
 * 不经过 Mesh.applyMatrix4 → decompose → compose 链路，避免精度损失。
 *
 * 单位处理：MOD 原始尺寸为毫米，这里把 Scale(0.001) 也烘焙到顶点（mm → m），
 * 使 merged geometry 顶点直接以场景单位（米）表达。
 * 这样 group.scale 保持 1，后续 applyPlacementTransformToSceneUnits 的顶点烘焙
 * 不会再触发 Object3D.applyMatrix4 + decompose 链路 corrupt group.scale。
 *
 * @param doc 解析后的 XmlModDocument
 * @returns Map<共享Material, baked BufferGeometry[]>，调用方负责 dispose baked geometry
 */
export function collectBakedGeometriesByMaterial(
  doc: XmlModDocument,
): Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]> {
  const byMaterial = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>();
  if (doc.isEmpty) return byMaterial;

  // mm → m 缩放矩阵：烘焙到顶点，避免 group.scale + Object3D.applyMatrix4 decompose 精度损失
  const mmToScene = new THREE.Matrix4().makeScale(MOD_MM_TO_SCENE_UNIT, MOD_MM_TO_SCENE_UNIT, MOD_MM_TO_SCENE_UNIT);

  // Boolean 实体需要同文件内其它 Entity 的局部几何做 CSG 运算：
  // 仅当存在 Boolean 时才构建 id → 局部几何（含自身 transform、不含 mmToScene）索引
  // 关键：必须 clone 共享缓存几何后再烘焙 transform。
  // 直接对 primitiveToGeometry 返回的共享实例 applyMatrix4 会污染全局缓存，
  // 后续每次加载同参数 primitive 都会在已变换的几何上再叠一次变换，
  // 形成逐实例累加的"楼梯"错位（substation02 路灯 +9m/实例实证）。
  const booleanEntities = doc.entities.filter((e) => e.primitive.type === 'Boolean');
  const localGeoById = new Map<number, THREE.BufferGeometry>();
  if (booleanEntities.length > 0) {
    for (const entity of doc.entities) {
      if (entity.primitive.type === 'Boolean') continue;
      const geo = primitiveToGeometry(entity.primitive, doc.modPath);
      if (!geo) continue;
      const local = geo.clone();
      if (entity.transformMatrix.length === 16) {
        local.applyMatrix4(gimMatrixToMatrix4(entity.transformMatrix));
      }
      localGeoById.set(entity.id, local);
    }
  }
  const boolMemo = new Map<number, THREE.BufferGeometry | null>();
  const boolStack = new Set<number>();

  /** 求值 Boolean 实体（递归、防环）；操作数缺失返回 null */
  function evalBoolean(id: number, prim: Extract<XmlModPrimitive, { type: 'Boolean' }>): THREE.BufferGeometry | null {
    if (boolMemo.has(id)) return boolMemo.get(id) ?? null;
    if (boolStack.has(id)) {
      console.warn(`[xmlModGeometry] Boolean 循环引用（id=${id}），跳过`);
      return null;
    }
    boolStack.add(id);
    try {
      let geoA = localGeoById.get(prim.entity1) ?? null;
      let geoB = localGeoById.get(prim.entity2) ?? null;
      // 操作数若本身是 Boolean，先递归求值并回填索引
      if (!geoA) {
        const ref1 = doc.entities.find((e) => e.id === prim.entity1);
        if (ref1?.primitive.type === 'Boolean') geoA = evalBoolean(ref1.id, ref1.primitive);
      }
      if (!geoB) {
        const ref2 = doc.entities.find((e) => e.id === prim.entity2);
        if (ref2?.primitive.type === 'Boolean') geoB = evalBoolean(ref2.id, ref2.primitive);
      }
      if (!geoA || !geoB) {
        console.warn(`[xmlModGeometry] Boolean(id=${id}) 操作数缺失（e1=${prim.entity1}, e2=${prim.entity2}），跳过`);
        boolMemo.set(id, null);
        return null;
      }
      const op =
        prim.op === 'Union' ? ADDITION : prim.op === 'Intersection' ? INTERSECTION : SUBTRACTION;
      const evaluator = getSharedCsgEvaluator();
      const result = evaluator.evaluate(new Brush(geoA), new Brush(geoB), op);
      boolMemo.set(id, result.geometry);
      return result.geometry;
    } finally {
      boolStack.delete(id);
    }
  }

  for (const entity of doc.entities) {
    if (!entity.visible) continue;

    let baseGeo: THREE.BufferGeometry | null;
    if (entity.primitive.type === 'Boolean') {
      baseGeo =
        entity.primitive.type === 'Boolean'
          ? evalBoolean(entity.id, entity.primitive)
          : null;
    } else {
      baseGeo = primitiveToGeometry(entity.primitive, doc.modPath);
    }
    if (!baseGeo) continue; // 跳过暂停渲染/求值失败的 primitive

    const material = colorToMaterial(entity.color, doc.colorMaxA);

    // clone base geometry 并直接烘焙 entity transform + mm→m 缩放
    // 关键：使用 BufferGeometry.applyMatrix4 直接变换顶点，不经过 Object3D.applyMatrix4/decompose
    // （Boolean 结果已在 MOD 局部空间，其自身 transform 在此统一烘焙）
    const baked = baseGeo.clone();
    if (entity.transformMatrix.length === 16) {
      baked.applyMatrix4(gimMatrixToMatrix4(entity.transformMatrix));
    }
    baked.applyMatrix4(mmToScene);

    const arr = byMaterial.get(material) ?? [];
    arr.push(baked);
    byMaterial.set(material, arr);
  }

  return byMaterial;
}

/** 共享 CSG Evaluator（three-bvh-csg） */
let _sharedCsgEvaluator: Evaluator | null = null;
function getSharedCsgEvaluator(): Evaluator {
  if (!_sharedCsgEvaluator) _sharedCsgEvaluator = new Evaluator();
  return _sharedCsgEvaluator;
}

/** 展平坐标数组 [x,y,z,...] → THREE.Vector3[] */
function vec3Array(flat: number[]): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) {
    out.push(new THREE.Vector3(flat[i], flat[i + 1], flat[i + 2]));
  }
  return out;
}

function sanitizeNum(n: number): number {
  return Number.isNaN(n) ? 0 : n;
}
