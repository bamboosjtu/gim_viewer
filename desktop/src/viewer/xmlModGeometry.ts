/**
 * 变电 XML MOD primitive → Three.js BufferGeometry 转换。
 *
 * 核心八类与 CircularGasket 按源参数生成浏览几何。
 * StretchedBody 兼容单位方向 × L 和完整 Normal 位移，支持凹截面。
 * PorcelainBushing 的伞裙是浏览近似，LOD0 保留锥形主体。
 * 尚未支持的复杂体和弱 schema 保留具体类型诊断。
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
import { stretchedBodyDisplacement } from '../gim/geometry/stretchedBody.js';
import { offsetRectangularTableVertices } from '../gim/geometry/offsetRectangularTable.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
export type DeviceLod = 0 | 1 | 2;
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

/** Worker-only: call after all per-task geometry has been exported and released. */
export function trimSharedXmlModGeometries(budget: number): void {
  let bytes = 0;
  const sizes = new Map<string,number>();
  for (const [key,geo] of _sharedGeometryCache) {
    let size = geo.index?.array.byteLength ?? 0;
    for (const attribute of Object.values(geo.attributes)) size += attribute.array.byteLength;
    sizes.set(key,size); bytes += size;
  }
  for (const [key,geo] of _sharedGeometryCache) {
    if (bytes <= budget) break;
    _sharedGeometryCache.delete(key); bytes -= sizes.get(key)!; geo.dispose();
  }
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
 * - StretchedBody：任意平面多边形沿完整 Normal 位移拉伸
 * - PorcelainBushing/TerminalBlock：组合浏览几何
 * - OffsetRectangularTable：显式七字段编码，下矩形 XY 居中且 Z=0，上矩形按 XOFF/YOFF 偏移
 * - ChannelSteel/Table：语义未完成，保留诊断
 * - 2 类弱 schema：RectangularFixedPlate/RectangularRing — 暂停渲染
 */
function rawNumber(raw: Record<string, string> | undefined, keys: string[], fallback = Number.NaN): number {
  if (!raw) return fallback;
  for (const key of keys) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

function primitiveToGeometryUncached(p: XmlModPrimitive, lod: DeviceLod): THREE.BufferGeometry | null {
  const segments = lod === 0 ? 6 : lod === 1 ? 12 : CYLINDER_SEGMENTS;
  switch (p.type) {
    case 'Cylinder':
      return zCylinder(p.r, p.r, p.h, segments);
    case 'Cuboid':
      return new THREE.BoxGeometry(sanitizeNum(p.l), sanitizeNum(p.w), sanitizeNum(p.h)).translate(0, 0, p.h / 2);
    case 'Sphere':
      return new THREE.SphereGeometry(sanitizeNum(p.r), segments, Math.max(4, segments / 2));
    case 'TruncatedCone':
      // TR in [0,1] is a ratio; larger values retain the observed absolute-radius dialect.
      return zCylinder(coneTopRadius(p.br, p.tr), p.br, p.h, segments);
    case 'Ring':
      return new THREE.TorusGeometry(sanitizeNum(p.r), Math.abs(sanitizeNum(p.dr)), lod === 0 ? 4 : TORUS_RADIAL_SEGMENTS, lod === 0 ? 8 : TORUS_TUBULAR_SEGMENTS, sanitizeNum(p.rad));
    case 'CircularGasket':
      return new THREE.TorusGeometry(sanitizeNum(p.or), Math.max(0, (sanitizeNum(p.or) - sanitizeNum(p.ir)) / 2), TORUS_RADIAL_SEGMENTS, TORUS_TUBULAR_SEGMENTS, sanitizeNum(p.rad));
    case 'Wire': {
      // 变电软母线：拟合点样条管（绝对 mm 坐标，后续烘焙 mm→m）。
      // 远景 LOD0 下真实直径只有几十毫米，几十米外不足一个像素；
      // 用最小可见半径保证连接关系可辨，近景/选中再回到真实直径。
      const pts = p.fitPoints;
      if (pts.length < 6) return null;
      const minRadius = lod === 0 ? 150 : lod === 1 ? 50 : 0;
      const curve = new THREE.CatmullRomCurve3(vec3Array(pts));
      return new THREE.TubeGeometry(curve, Math.min(Math.max(pts.length / 3, 8), 256), Math.max(sanitizeNum(p.d) / 2, minRadius), 6, false);
    }
    case 'Cable': {
      // 电缆敷设路径：拐点折线圆管；远景同样保证最小可见半径
      const pts = p.inflectionPoints;
      if (pts.length < 6) return null;
      const minRadius = lod === 0 ? 150 : lod === 1 ? 50 : 0;
      const curve = new THREE.CatmullRomCurve3(vec3Array(pts));
      return new THREE.TubeGeometry(curve, Math.min(Math.max(pts.length / 3, 8), 256), Math.max(sanitizeNum(p.d) / 2, minRadius), 6, false);
    }
    case 'RotationalEllipsoid': {
      // 近似：单位球按三轴（LR/WR/H 作全长）缩放
      const geo = new THREE.SphereGeometry(0.5, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS);
      geo.scale(Math.max(sanitizeNum(p.lr), 1), Math.max(sanitizeNum(p.wr), 1), Math.max(sanitizeNum(p.h), 1));
      return geo;
    }
    case 'BeamChannelLike':
      // 截面需型号查表，暂用近似盒体（100×L×50），docs/schema/substation-mod.md 已标注近似语义
      return new THREE.BoxGeometry(100, Math.max(sanitizeNum(p.length), 1), 50);
    case 'StretchedBody':
      return createStretchedBodyGeometry(p.array, p.normal, p.l);
    case 'PorcelainBushing': {
      const parts: THREE.BufferGeometry[] = [zCylinder(p.r2, p.r, p.h, segments)];
      // Skirt profiles are a browsing approximation; the tapered core remains at every LOD.
      const n = Math.min(512, Math.max(0, Math.floor(p.n)));
      if (lod > 0) for (let k = 0; k < n; k++) {
        const z = p.h * (k + 0.5) / n;
        parts.push(zCylinder(p.r2, p.r1, p.h * 0.02, segments).translate(0, 0, z));
        parts.push(zCylinder(p.r1, p.r1 * 0.98, p.h * 0.06, segments).translate(0, 0, z - p.h * 0.06));
      }
      return mergeParts(parts);
    }
    case 'TerminalBlock': {
      const parts: THREE.BufferGeometry[] = [new THREE.BoxGeometry(p.l, p.w, p.t).translate(0, 0, p.t / 2)];
      const cn = Math.max(0, Math.min(256, Math.floor(p.cn))), rn = Math.max(0, Math.min(256, Math.floor(p.rn)));
      if (cn * rn > 4096) return null;
      if (lod > 0) for (let c = 0; c < cn; c++) for (let r = 0; r < rn; r++) {
        parts.push(zCylinder(p.r, p.r, p.bl, segments).translate((c - (cn - 1) / 2) * p.cs, (r - (rn - 1) / 2) * p.rs, p.t));
      }
      return mergeParts(parts);
    }
    case 'RectangularFixedPlate': {
      // 弱 schema：L/W/T 直接生成浏览用矩形板；螺栓孔等字段忽略。
      const l = rawNumber(p.raw, ['L', 'L1'], 1);
      const w = rawNumber(p.raw, ['W', 'W1'], 1);
      const t = rawNumber(p.raw, ['T', 'H'], 1);
      return new THREE.BoxGeometry(l, w, t).translate(0, 0, t / 2);
    }
    case 'RectangularRing': {
      // 矩形框近似（垫圈/密封件）：外框 L1×W1、内框 L2×W2、厚度 H，四块板拼合。
      const l1 = rawNumber(p.raw, ['L1'], 1);
      const w1 = rawNumber(p.raw, ['W1'], 1);
      const l2 = Math.min(rawNumber(p.raw, ['L2'], l1 * 0.8), l1);
      const w2 = Math.min(rawNumber(p.raw, ['W2'], w1 * 0.8), w1);
      const h = rawNumber(p.raw, ['H', 'T'], 1);
      const sideL = (l1 - l2) / 2;
      const sideW = (w1 - w2) / 2;
      if (!(sideL > 0 || sideW > 0) || !(h > 0)) return null;
      const parts: THREE.BufferGeometry[] = [];
      if (sideL > 0) {
        parts.push(new THREE.BoxGeometry(sideL, w1, h).translate(-(l1 - sideL) / 2, 0, h / 2));
        parts.push(new THREE.BoxGeometry(sideL, w1, h).translate((l1 - sideL) / 2, 0, h / 2));
      }
      if (sideW > 0) {
        parts.push(new THREE.BoxGeometry(l2, sideW, h).translate(0, -(w1 - sideW) / 2, h / 2));
        parts.push(new THREE.BoxGeometry(l2, sideW, h).translate(0, (w1 - sideW) / 2, h / 2));
      }
      return mergeParts(parts);
    }
    case 'ChannelSteel': {
      // 无截面型号表：按外廓盒体近似（宽 B/D、长 L、高 H/T）。
      const width = p.b ?? p.d ?? 100;
      const height = p.h ?? p.t ?? 50;
      if (!(p.l > 0) || !(width > 0) || !(height > 0)) return null;
      return new THREE.BoxGeometry(width, p.l, height);
    }
    case 'Table': {
      // 桌面/台架类：按长宽高外廓盒体近似，忽略孔洞与栏栅。
      if (!(p.ll1 > 0) || !(p.ll2 > 0) || !(p.h > 0)) return null;
      return new THREE.BoxGeometry(p.ll1, p.ll2, p.h);
    }
    case 'OffsetRectangularTable': {
      const vertices = offsetRectangularTableVertices(p.raw);
      if (!vertices) return null;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(16).fill(0), 2));
      geometry.setIndex([0,2,1,0,3,2, 4,5,6,4,6,7, 0,1,5,0,5,4, 1,2,6,1,6,5, 2,3,7,2,7,6, 3,0,4,3,4,7]);
      const flat = geometry.toNonIndexed(); geometry.dispose();
      flat.computeVertexNormals();
      flat.setIndex(Array.from({ length: flat.getAttribute('position').count }, (_, index) => index));
      return flat;
    }

    case 'Unsupported':
      if (!_warnedOnce.has(`unsupported:${p.sourceType}`)) {
        _warnedOnce.add(`unsupported:${p.sourceType}`);
        console.warn(`[xmlModGeometry] 未支持 primitive "${p.sourceType}"，已跳过`);
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

/**
 * 构造任意平面截面的拉伸体。
 *
 * Array 中的点已经位于 MOD 局部三维坐标，不能先压成 XY 再靠旋转猜回位置。
 * 这里仅把点投影到与 Normal 正交的二维基底以完成凹多边形三角剖分，最终顶点仍
 * 直接使用原始三维点，并加上统一解释的有符号拉伸位移。
 */
function createStretchedBodyGeometry(array: string, normalRaw: string, lengthRaw: number): THREE.BufferGeometry | null {
  let points = parseStretchedBodyPoints(array);
  const resolved = stretchedBodyDisplacement(normalRaw, lengthRaw);
  const normal = resolved ? new THREE.Vector3(...resolved.vector) : null;
  if (points.length < 3 || !normal) return null;
  const extrusion = normal.clone();
  normal.normalize();

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
export function primitiveToGeometry(p: XmlModPrimitive, modPath?: string, lod: DeviceLod = 2): THREE.BufferGeometry | null {
  // v3（A.1）：modPath 不再参与缓存键，跨 modPath 全局共享
  void modPath; // 标记参数已废弃，保留兼容性
  const sig = `${lod}:${p.type}:${primitiveSignature(p)}`;
  const cached = _sharedGeometryCache.get(sig);
  if (cached) return cached;
  const geo = primitiveToGeometryUncached(p, lod);
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
 * 规则（docs/schema/substation-mod.md 实测四工具）：
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
  doc: XmlModDocument, lod: DeviceLod = 2, timings?: Record<string, number>,
): BakedGeometries {
  const steps = bakeGeometrySteps(doc, lod, timings);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Keep exactly the synchronous operation order, yielding between completed
 * operations (including recursive Boolean operands). A single CSG evaluation
 * is still synchronous; this bounds chains, not the cost of an individual CSG.
 */
export async function collectBakedGeometriesByMaterialAsync(
  doc: XmlModDocument, lod: DeviceLod = 2, timings?: Record<string, number>,
): Promise<BakedGeometries> {
  const steps = bakeGeometrySteps(doc, lod, timings);
  let sliceStarted = performance.now();
  let step = steps.next();
  while (!step.done) {
    if (performance.now() - sliceStarted >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      sliceStarted = performance.now();
    }
    step = steps.next();
  }
  return step.value;
}

export interface BakedGeometryFailure { rootId: number; dependencies: { id: number; reason: string }[] }
export type BakedGeometries = Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]> & {
  failures: BakedGeometryFailure[]; simplifiedBooleans: number;
};
function* bakeGeometrySteps(
  doc: XmlModDocument, lod: DeviceLod, timings?: Record<string, number>,
): Generator<void, BakedGeometries, void> {
  const byMaterial = Object.assign(new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>(), { failures: [] as BakedGeometryFailure[], simplifiedBooleans: 0 });
  const build = (p: XmlModPrimitive) => { const started = performance.now(); const geometry = primitiveToGeometry(p, doc.modPath, lod);
    if (timings) timings.primitiveMs = (timings.primitiveMs ?? 0) + performance.now() - started; return geometry; };
  if (doc.isEmpty) return byMaterial;

  // mm → m 缩放矩阵：烘焙到顶点，避免 group.scale + Object3D.applyMatrix4 decompose 精度损失
  const mmToScene = new THREE.Matrix4().makeScale(MOD_MM_TO_SCENE_UNIT, MOD_MM_TO_SCENE_UNIT, MOD_MM_TO_SCENE_UNIT);

  const entities = new Map(doc.entities.map(entity => [entity.id, entity]));
  const memo = new Map<number, THREE.BufferGeometry | null>();
  const visiting = new Set<number>();
  const owned = new Set<THREE.BufferGeometry>();
  const failures = new Map<number, string>();
  const own = (geometry: THREE.BufferGeometry) => { owned.add(geometry); return geometry; };
  const transform = (geometry: THREE.BufferGeometry, matrix: THREE.Matrix4) => {
    geometry.applyMatrix4(matrix);
    // Reflection reverses triangle winding. Keep outward normals and CSG's
    // inside/outside classification consistent without touching cached leaves.
    if (matrix.determinant() < 0) {
      if (!geometry.index) geometry.setIndex(Array.from({ length: geometry.getAttribute('position').count }, (_, i) => i));
      const index = geometry.index!;
      for (let i = 0; i < index.count; i += 3) {
        const b = index.getX(i + 1); index.setX(i + 1, index.getX(i + 2)); index.setX(i + 2, b);
      }
    }
    return geometry;
  };
  const fail = (id: number, reason: string) => { failures.set(id, reason); return null; };
  // Every cached result is in its parent's frame, including this Entity's
  // transform. Root output therefore applies only mm -> m, never that matrix twice.
  function* evaluate(id: number): Generator<void, THREE.BufferGeometry | null, void> {
    const key = id;
    if (memo.has(key)) return memo.get(key)!;
    const entity = entities.get(id);
    if (!entity) return fail(id, 'missing-reference');
    if (visiting.has(id)) return fail(id, 'cycle');
    visiting.add(id);
    let result: THREE.BufferGeometry | null = null;
    try {
      const p = entity.primitive;
      if (p.type !== 'Boolean') {
        const base = build(p);
        if (base) result = own(base.clone());
        else return fail(id, `unsupported-or-invalid:${p.type}`);
      } else {
        const a = yield* evaluate(p.entity1);
        const b = yield* evaluate(p.entity2);
        if (!a || !b) return fail(id, 'operand-unavailable');
        else if (!a.getAttribute('position').count || !b.getAttribute('position').count) {
          result = own((p.op === 'Intersection' ? (!a.getAttribute('position').count ? a : b)
            : p.op === 'Difference' ? a : a.getAttribute('position').count ? a : b).clone());
        } else {
          const started = performance.now();
          try {
            result = own(getSharedCsgEvaluator().evaluate(new Brush(a), new Brush(b),
              p.op === 'Union' ? ADDITION : p.op === 'Intersection' ? INTERSECTION : SUBTRACTION).geometry);
          } catch (error) { return fail(id, `csg-failed:${String(error)}`); }
          finally { if (timings) { timings.booleanMs = (timings.booleanMs ?? 0) + performance.now() - started;
            timings.booleanEvaluations = (timings.booleanEvaluations ?? 0) + 1; } }
        }
      }
      if (result) transform(result, gimMatrixToMatrix4(entity.transformMatrix));
      memo.set(key, result);
      yield;
      return result;
    } finally { visiting.delete(id); }
  }
  // Keep LOD0 Union as surfaces of solid pieces. Set identities distribute
  // difference/intersection over those pieces; disjoint pairs need no CSG.
  const surfaces = new Map<number, THREE.BufferGeometry[] | null>();
  const surfaceStack = new Set<number>();
  const bounds = new WeakMap<THREE.BufferGeometry, THREE.Box3>();
  const boxOf = (g: THREE.BufferGeometry) => {
    let box = bounds.get(g);
    if (!box) { g.computeBoundingBox(); box = g.boundingBox!.clone(); bounds.set(g, box); }
    return box;
  };
  function* surface(id: number): Generator<void, THREE.BufferGeometry[] | null, void> {
    if (surfaces.has(id)) return surfaces.get(id)!;
    const e = entities.get(id);
    if (!e) { fail(id, 'missing-reference'); return null; }
    if (surfaceStack.has(id)) { fail(id, 'cycle'); return null; }
    if (e.primitive.type !== 'Boolean') {
      const geometry = yield* evaluate(id);
      const result = geometry ? [geometry] : null; surfaces.set(id, result); return result;
    }
    surfaceStack.add(id);
    try {
      const p = e.primitive, a = yield* surface(p.entity1), b = yield* surface(p.entity2);
      let pieces: THREE.BufferGeometry[] = [];
      if (!a || !b) {
        fail(id, 'operand-unavailable');
        // Retain supported surfaces as an explicit partial approximation.
        // Never invent an intersection from an absent operand.
        pieces = p.op === 'Union' ? [...a ?? [], ...b ?? []] : p.op === 'Difference' ? a ?? [] : [];
      } else if (p.op === 'Union') { pieces = [...a, ...b]; byMaterial.simplifiedBooleans++; }
      else {
        for (const left of a) {
          let remaining = [left];
          for (const right of b) {
            const next: THREE.BufferGeometry[] = [];
            const size = boxOf(right).getSize(new THREE.Vector3()).toArray().sort((x,y) => x-y);
            const smallCut = p.op === 'Difference' && size[0] > 0 && size[1] <= 50;
            for (const part of p.op === 'Intersection' ? [left] : remaining) {
              if (smallCut) { next.push(part); byMaterial.simplifiedBooleans++; continue; }
              if (!boxOf(part).intersectsBox(boxOf(right))) {
                if (p.op === 'Difference') next.push(part);
                if (timings) timings.disjointBooleanPairs = (timings.disjointBooleanPairs ?? 0) + 1;
                continue;
              }
              if (!part.getAttribute('position').count || !right.getAttribute('position').count) continue;
              const started = performance.now();
              try {
                const cut = own(getSharedCsgEvaluator().evaluate(new Brush(part), new Brush(right),
                  p.op === 'Difference' ? SUBTRACTION : INTERSECTION).geometry);
                if (cut.getAttribute('position').count) next.push(cut);
              } catch (error) {
                fail(id, `csg-failed:${String(error)}`);
                if (p.op === 'Difference') next.push(part);
              } finally { if (timings) {
                timings.booleanMs = (timings.booleanMs ?? 0) + performance.now() - started;
                timings.booleanEvaluations = (timings.booleanEvaluations ?? 0) + 1;
              } }
              yield;
            }
            if (p.op === 'Intersection') pieces.push(...next); else remaining = next;
          }
          if (p.op === 'Difference') pieces.push(...remaining);
        }
      }
      const matrix = gimMatrixToMatrix4(e.transformMatrix);
      if (!matrix.equals(new THREE.Matrix4())) pieces = pieces.map(piece => own(transform(piece.clone(), matrix)));
      surfaces.set(id, pieces); yield; return pieces;
    } finally { surfaceStack.delete(id); }
  }
  try {
    for (const entity of doc.entities) {
      if (!entity.visible) continue;
      let pieces = lod === 0 ? yield* surface(entity.id) : null;
      const base = lod === 0 ? null : yield* evaluate(entity.id);
      const reachable = new Set<number>();
      const visit = (id: number) => {
        if (reachable.has(id)) return;
        reachable.add(id);
        const p = entities.get(id)?.primitive;
        if (p?.type === 'Boolean') { visit(p.entity1); visit(p.entity2); }
      };
      visit(entity.id);
      const dependencies: { id: number; reason: string }[] = [];
      for (const id of reachable) { const reason = failures.get(id); if (reason !== undefined) dependencies.push({ id, reason }); }
      if (dependencies.length) byMaterial.failures.push({ rootId: entity.id, dependencies });
      // A failed detailed Union can still provide its supported browser
      // outline. Keep the root diagnostic and never label it complete.
      if (dependencies.length && lod > 0 && entity.primitive.type === 'Boolean')
        pieces = yield* surface(entity.id);
      pieces ??= base ? [base] : [];
      const material = colorToMaterial(entity.color, doc.colorMaxA);
      for (const piece of pieces) {
        if (piece.getAttribute('position').count === 0) continue;
        const baked = piece.clone().applyMatrix4(mmToScene);
        const bucket = byMaterial.get(material) ?? []; bucket.push(baked); byMaterial.set(material, bucket);
      }
      yield;
    }
  } finally { for (const geometry of owned) geometry.dispose(); }
  if (timings) {
    timings.simplifiedBooleans = (timings.simplifiedBooleans ?? 0) + byMaterial.simplifiedBooleans;
    timings.failedVisibleRoots = (timings.failedVisibleRoots ?? 0) + byMaterial.failures.length;
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

/** GIM cylinders have their base at Z=0 and their axis along +Z. */
function zCylinder(top: number, bottom: number, height: number, segments: number): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(sanitizeNum(top), sanitizeNum(bottom), sanitizeNum(height), segments)
    .rotateX(Math.PI / 2).translate(0, 0, height / 2);
}
export function coneTopRadius(br: number, tr: number): number {
  return tr >= 0 && tr <= 1 ? br * tr : tr;
}
function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  return merged;
}
