/**
 * 变电 XML MOD primitive → Three.js BufferGeometry 转换。
 *
 * 14 类 primitive 转换策略（详见 docs/plans/substation-geometry-impl.md §6.2）：
 * - 11 类强类型：精确几何（Cylinder/Cuboid/Sphere 等基础几何 + ExtrudeGeometry/LatheGeometry 复合）
 * - 3 类弱 schema：BoxGeometry 占位 + console.warn
 *
 * TransformMatrix 应用：
 * - GIM 矩阵按行主序展开（详见 docs/schema/dev.md §变换矩阵格式 / docs/schema/mod.md）
 * - Three.js Matrix4.set() 接收行主序参数，可直接使用
 * - 注：实测 PHM TRANSFORMMATRIX 100% IDENTITY，但保留应用逻辑以应对未来样本
 *
 * Color 应用：
 * - R/G/B 范围 0-255 → setRGB(r/255, g/255, b/255)
 * - A 范围 0-100（透明度百分比）→ opacity = a/100
 *
 * 单位：毫米（与 IFC 渲染保持一致，不做单位换算）
 */

import * as THREE from 'three';
import type {
  XmlModColor,
  XmlModEntity,
  XmlModPrimitive,
} from '../gim/geometry/ir.js';
import type { XmlModDocument } from '../gim/geometry/xmlModParser.js';

/**
 * 将 primitive 转换为 Three.js BufferGeometry。
 *
 * 强类型 11 类使用精确几何；弱 schema 3 类使用 BoxGeometry 占位并 console.warn。
 * 数值字段为 NaN 时按 0 处理（避免几何异常）。
 */
export function primitiveToGeometry(p: XmlModPrimitive): THREE.BufferGeometry {
  switch (p.type) {
    case 'Cylinder':
      return new THREE.CylinderGeometry(
        sanitizeNum(p.r),
        sanitizeNum(p.r),
        sanitizeNum(p.h),
        32,
      );
    case 'Cuboid':
      return new THREE.BoxGeometry(
        sanitizeNum(p.l),
        sanitizeNum(p.w),
        sanitizeNum(p.h),
      );
    case 'Sphere':
      return new THREE.SphereGeometry(sanitizeNum(p.r), 32, 16);
    case 'TruncatedCone':
      // CylinderGeometry(radiusTop, radiusBottom, height, radialSegments)
      return new THREE.CylinderGeometry(
        sanitizeNum(p.tr),
        sanitizeNum(p.br),
        sanitizeNum(p.h),
        32,
      );
    case 'Ring':
      // TorusGeometry(radius, tube, radialSegments, tubularSegments, arc)
      return new THREE.TorusGeometry(
        sanitizeNum(p.r),
        sanitizeNum(p.dr) / 2,
        16,
        32,
        sanitizeNum(p.rad),
      );
    case 'CircularGasket':
      // 外环半径 OR，管半径 = (OR - IR) / 2
      return new THREE.TorusGeometry(
        sanitizeNum(p.or),
        Math.max(0, (sanitizeNum(p.or) - sanitizeNum(p.ir)) / 2),
        16,
        32,
        sanitizeNum(p.rad),
      );
    case 'PorcelainBushing':
      // 简化为圆柱（中段半径 R1），伞裙结构待 P1 实现
      return new THREE.CylinderGeometry(
        sanitizeNum(p.r1),
        sanitizeNum(p.r),
        sanitizeNum(p.h),
        32,
      );
    case 'StretchedBody':
      return stretchedBodyToGeometry(p);
    case 'TerminalBlock':
      // 简化为长方体（端子细节待 P1）
      return new THREE.BoxGeometry(
        sanitizeNum(p.l),
        sanitizeNum(p.w),
        p.h !== undefined ? sanitizeNum(p.h) : sanitizeNum(p.t) * 2 || 10,
      );
    case 'ChannelSteel':
      // 简化为长方体（型号表查表待 P1）
      return new THREE.BoxGeometry(
        sanitizeNum(p.l),
        p.h !== undefined ? sanitizeNum(p.h) : 100,
        p.b !== undefined ? sanitizeNum(p.b) : 50,
      );
    case 'Table':
      // 简化为台面（4 腿组合待 P1）
      return new THREE.BoxGeometry(
        sanitizeNum(p.ll1),
        sanitizeNum(p.h),
        sanitizeNum(p.ll2),
      );
    case 'RectangularFixedPlate':
    case 'OffsetRectangularTable':
    case 'RectangularRing':
      console.warn(
        `[xmlModGeometry] weak schema primitive "${p.type}" 使用 BoxGeometry 占位，raw 属性：`,
        p.raw,
      );
      return new THREE.BoxGeometry(1, 1, 1);
    default: {
      // 满足穷尽性检查（联合类型若有新增会编译报错）
      const _exhaustive: never = p;
      void _exhaustive;
      return new THREE.BoxGeometry(1, 1, 1);
    }
  }
}

/**
 * StretchedBody 转换为 ExtrudeGeometry。
 *
 * Array 格式："x,y;x,y;..." 或 "x,y,z;x,y,z;..."
 * Normal 格式："x,y,z"（长度恒为 304.8，需归一化为单位向量）
 * L：拉伸长度
 *
 * 步骤：
 * 1. 解析 Array 为 2D 点（取前两个分量）
 * 2. 创建 THREE.Shape
 * 3. ExtrudeGeometry 沿 Z 轴拉伸 L
 * 4. 计算从 (0,0,1) 到归一化 Normal 的四元数
 * 5. 应用四元数到几何
 */
function stretchedBodyToGeometry(p: Extract<XmlModPrimitive, { type: 'StretchedBody' }>): THREE.BufferGeometry {
  const L = sanitizeNum(p.l);

  // 解析 Array 为 2D 点
  const points2d = parseArrayPoints(p.array);
  if (points2d.length < 3) {
    // 不足 3 点无法构成多边形，返回退化几何
    return new THREE.BoxGeometry(0, 0, L);
  }

  // 创建 Shape
  const shape = new THREE.Shape();
  shape.moveTo(points2d[0][0], points2d[0][1]);
  for (let i = 1; i < points2d.length; i++) {
    shape.lineTo(points2d[i][0], points2d[i][1]);
  }
  shape.closePath();

  // 沿 Z 轴拉伸 L
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: L,
    bevelEnabled: false,
  });

  // 计算从 (0,0,1) 到归一化 Normal 的四元数，应用到几何
  const normalUnit = parseNormalUnit(p.normal);
  if (normalUnit) {
    const zAxis = new THREE.Vector3(0, 0, 1);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(zAxis, normalUnit);
    geometry.applyQuaternion(quaternion);
  }

  return geometry;
}

/** 解析 Array 字段为 2D 点数组（取每个点的前两个分量） */
function parseArrayPoints(arrayStr: string): Array<[number, number]> {
  if (!arrayStr) return [];
  return arrayStr
    .split(';')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const parts = segment.split(',').map((s) => parseFloat(s.trim()));
      return [parts[0] ?? 0, parts[1] ?? 0] as [number, number];
    });
}

/** 解析 Normal 字段并归一化为单位向量（长度 0 或解析失败返回 null） */
function parseNormalUnit(normalStr: string): THREE.Vector3 | null {
  if (!normalStr) return null;
  const parts = normalStr.split(',').map((s) => parseFloat(s.trim()));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  const v = new THREE.Vector3(parts[0], parts[1], parts[2]);
  if (v.lengthSq() === 0) return null;
  return v.normalize();
}

/**
 * 将 Entity 转换为 Three.Mesh。
 *
 * - primitive → geometry
 * - color → material（缺失时使用默认灰色材质）
 * - transformMatrix → applyMatrix4（行主序）
 */
export function entityToMesh(e: XmlModEntity): THREE.Mesh {
  const geometry = primitiveToGeometry(e.primitive);
  const material = colorToMaterial(e.color);
  const mesh = new THREE.Mesh(geometry, material);

  // 应用 TransformMatrix（行主序，使用 Matrix4.set）
  const arr = e.transformMatrix;
  if (arr.length === 16) {
    const m = new THREE.Matrix4();
    m.set(
      arr[0], arr[1], arr[2], arr[3],
      arr[4], arr[5], arr[6], arr[7],
      arr[8], arr[9], arr[10], arr[11],
      arr[12], arr[13], arr[14], arr[15],
    );
    mesh.applyMatrix4(m);
  }

  return mesh;
}

/** Color → MeshStandardMaterial（缺失时返回默认灰色不透明材质） */
function colorToMaterial(color: XmlModColor | undefined): THREE.MeshStandardMaterial {
  if (!color) {
    return new THREE.MeshStandardMaterial({
      color: 0x888888,
      transparent: false,
    });
  }
  // XML 中 R/G/B 为 0-255 sRGB 整数 → 拼为 hex，由 THREE.Color 按 sRGB 解释
  const hex =
    (clamp255(color.r) << 16) |
    (clamp255(color.g) << 8) |
    clamp255(color.b);
  const material = new THREE.MeshStandardMaterial({
    color: hex,
    transparent: color.a < 100,
    opacity: clamp100(color.a) / 100,
  });
  return material;
}

/** 限制 0-255 范围（Color 已通过 parseColor 校验，此处为防御性 clamp） */
function clamp255(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** 限制 0-100 范围 */
function clamp100(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** 将整个 XmlModDocument 转换为 THREE.Group（包含所有可见 Entity 的 Mesh） */
export function xmlModDocumentToGroup(doc: XmlModDocument): THREE.Group {
  const group = new THREE.Group();
  group.name = `xml-mod:${doc.modPath}`;
  if (doc.isEmpty) return group;

  for (const entity of doc.entities) {
    // Visible=False 的 Entity 仍加入 Group，但 mesh.visible = false
    // 这样切换可见性时无需重建 Group
    const mesh = entityToMesh(entity);
    mesh.visible = entity.visible;
    group.add(mesh);
  }
  return group;
}

/**
 * 把 NaN 数值安全化为 0（避免 Three.js 几何异常）。
 * 非 NaN 数值原样返回。
 */
function sanitizeNum(n: number): number {
  return Number.isNaN(n) ? 0 : n;
}
