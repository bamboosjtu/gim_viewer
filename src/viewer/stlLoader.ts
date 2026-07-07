/**
 * 变电 STL 二进制文件加载器。
 *
 * 与 MOD 加载器（xmlModLoader）互补：
 * - xmlModLoader：解析 XML MOD 文件 → Three.js Group
 * - stlLoader：解析二进制 STL 文件 → Three.js Group
 *
 * 格式：Binary STL（CAD 导出标准格式）
 * - 80 字节头（忽略）
 * - 4 字节 uint32 LE：三角形数量
 * - N × 50 字节/三角形：
 *     - 12 字节：法向量（3 × float32 LE）
 *     - 12 字节：顶点 1（3 × float32 LE）
 *     - 12 字节：顶点 2（3 × float32 LE）
 *     - 12 字节：顶点 3（3 × float32 LE）
 *     - 2 字节：属性计数（忽略）
 *
 * 外部变换矩阵（DEV/PHM）由调用方通过 applyPlacementTransformToSceneUnits 应用。
 *
 * 单位处理：STL 顶点原始单位为毫米（与 MOD 一致，源自 CAD 导出）。
 * 这里把 mm→m 缩放烘焙到顶点，使 group.scale 保持 1，与 MOD 加载器
 * （collectBakedGeometriesByMaterial）保持一致。
 * 这样 applyPlacementTransformToSceneUnits 的顶点烘焙不会因 group.scale≠1
 * 触发 Object3D.applyMatrix4 + decompose 链路 corrupt scale。
 */

import * as THREE from 'three';

/** STL 原始顶点单位（毫米）→ 场景单位（米）的缩放系数，与 MOD 保持一致。 */
const STL_MM_TO_SCENE_UNIT = 0.001;

/**
 * 从 ArrayBuffer 解析二进制 STL 文件。
 *
 * @param buffer STL 文件二进制数据
 * @param stlPath STL 文件路径（用于 Group.name 和错误消息）
 * @returns THREE.Group（含 Mesh）；顶点已烘焙 mm→m 缩放；格式无效或解析失败返回 null
 */
export function parseStlBinary(buffer: ArrayBuffer, stlPath: string): THREE.Group | null {
  if (buffer.byteLength < 84) {
    console.warn(`[stlLoader] STL 文件过小（${buffer.byteLength} bytes），跳过: ${stlPath}`);
    return null;
  }

  // 检测是否为 ASCII STL（以 "solid" 开头且第 5 字节为空格）
  const head = new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength));
  if (head[0] === 0x73 && head[1] === 0x6f && head[2] === 0x6c && head[3] === 0x69 && head[4] === 0x64) {
    // ASCII STL：跳过（GIM 工程中极少见，P1 支持）
    console.warn(`[stlLoader] ASCII STL 暂不支持（P1），跳过: ${stlPath}`);
    return null;
  }

  const triangleCount = new DataView(buffer).getUint32(80, true);

  // 校验文件大小：80 + 4 + N × 50
  const expectedSize = 84 + triangleCount * 50;
  if (buffer.byteLength < expectedSize) {
    console.warn(
      `[stlLoader] STL 文件大小不符（期望 ≥${expectedSize}，实际 ${buffer.byteLength}），跳过: ${stlPath}`,
    );
    return null;
  }

  // 限制面数，防止恶意/异常文件 OOM（单 STL 上限 500 万三角面 ≈ 250 MB）
  const MAX_TRIANGLES = 5_000_000;
  if (triangleCount > MAX_TRIANGLES) {
    console.warn(
      `[stlLoader] STL 三角形数量过多（${triangleCount} > ${MAX_TRIANGLES}），跳过: ${stlPath}`,
    );
    return null;
  }

  const positions = new Float32Array(triangleCount * 9); // 3 vertices × 3 coords
  const normals = new Float32Array(triangleCount * 9);   // per-face normals repeated per vertex

  const dv = new DataView(buffer);
  let offset = 84;

  for (let i = 0; i < triangleCount; i++) {
    // 法向量（3 × float32 LE）
    const nx = dv.getFloat32(offset, true);
    const ny = dv.getFloat32(offset + 4, true);
    const nz = dv.getFloat32(offset + 8, true);
    offset += 12;

    // 3 个顶点（各 3 × float32 LE）
    const pi = i * 9;
    for (let v = 0; v < 3; v++) {
      positions[pi + v * 3] = dv.getFloat32(offset, true);
      positions[pi + v * 3 + 1] = dv.getFloat32(offset + 4, true);
      positions[pi + v * 3 + 2] = dv.getFloat32(offset + 8, true);
      // 每顶点复制法向量（非索引几何体，逐顶点法线）
      normals[pi + v * 3] = nx;
      normals[pi + v * 3 + 1] = ny;
      normals[pi + v * 3 + 2] = nz;
      offset += 12;
    }

    // 属性计数（2 字节，忽略）
    offset += 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

  // 烘焙 mm→m 缩放到顶点：与 MOD 加载器（collectBakedGeometriesByMaterial）一致，
  // 使顶点直接以场景单位（米）表达，group.scale 保持 1。
  // 这样 applyPlacementTransformToSceneUnits 的顶点烘焙不会触发
  // Object3D.applyMatrix4 + decompose 链路 corrupt scale。
  // 对法向量无影响：均匀缩放的逆变换矩阵仍为单位矩阵（法向量方向不变）。
  geometry.scale(STL_MM_TO_SCENE_UNIT, STL_MM_TO_SCENE_UNIT, STL_MM_TO_SCENE_UNIT);

  // 默认材质：浅灰色，与 MOD primitive 默认材质一致
  const material = new THREE.MeshPhongMaterial({
    color: 0xcccccc,
    specular: 0x111111,
    shininess: 30,
    side: THREE.DoubleSide,
    flatShading: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  const group = new THREE.Group();
  group.name = stlPath;
  group.add(mesh);

  return group;
}

/**
 * 释放 STL Group 的 GPU 资源（geometry + material）。
 *
 * 由 projectCleanupService 在切换项目时调用。
 * 调用前需已从 scene 移除（scene.remove(group)）。
 */
export function disposeStlGroup(group: THREE.Group): void {
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
