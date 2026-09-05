/**
 * 方案 C v2：DEV 粒度 → glTF 离线预序列化缓存服务。
 *
 * serializeDevToGlb 由渐进式几何管线（progressiveGeometryService）在首次打开时
 * 逐 DEV 调用：序列化 → 落盘 → 逐 CBM 实例渲染一体化。
 * 二次打开时可直接用 GLTFLoader 加载 .glb，跳过全部 XML 解析。
 *
 * 关键设计（当前 DEV 粒度缓存契约见 docs/schema/17-batch-load-schema.md）：
 * - 按 DEV 文件粒度缓存（非按 MOD 文件粒度）
 *   理由：DEV 粒度大幅减少加载次数（5982 → 数百）
 * - 序列化时烘焙 DEV 内部所有 transform（DEV × PHM × SUBDEVICE × Entity + mm→m）
 * - CBM 累积矩阵运行时应用（同一 DEV 可被多 CBM 引用）
 * - 数学等价性：两次 applyPlacementTransformToSceneUnits（各 ×0.001）
 *   等价于一次完整应用（CBM × DEV × PHM，×0.001）
 *
 * 缓存路径：app_data_dir/glbcache/{project_id}/{devPath}.glb
 * 版本化：通过 GEOMETRY_CACHE_VERSION 失效
 *
 * 关联文档：docs/schema/17-batch-load-schema.md、docs/gim_substation.md
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { discoverGeometriesFromDevPath } from './modGeometryDiscovery.js';
import { DEBUG_GIM_CACHE } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { getFileByPath } from '../gim/fileLookup.js';

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 单例 GLTFLoader（内部无状态，可安全复用） */
let _gltfLoader: GLTFLoader | null = null;
function getGltfLoader(): GLTFLoader {
  if (!_gltfLoader) _gltfLoader = new GLTFLoader();
  return _gltfLoader;
}

/**
 * 把单个 DEV 文件引用的所有 MOD + STL 序列化为一个 GLB 二进制。
 *
 * 流程：
 * 1. discoverGeometriesFromDevPath（parentTransform=IDENTITY）获取 DEV 内部几何
 *    - 返回的 placementTransformMatrix = DEV × PHM（不含 CBM）
 * 2. 对每个 MOD/STL 加载 Group，applyPlacementTransformToSceneUnits 烘焙到顶点
 * 3. 所有 Group 合并到 devGroup
 * 4. GLTFExporter 序列化 devGroup → GLB bytes
 *
 * placement 烘焙策略：
 * - 烘焙到 .glb：Entity.TransformMatrix + mm→m + DEV × PHM × SUBDEVICE
 * - 不烘焙：CBM 累积矩阵（运行时由加载方应用）
 *
 * @param devPath DEV 文件路径（如 "DEV/abc.dev"）
 * @param files GIM 解压后的文件集合
 * @returns GLB 二进制 bytes；无几何引用返回 null；缺失/序列化失败抛错
 */
export async function serializeDevToGlb(
  devPath: string,
  files: Map<string, File>,
): Promise<Uint8Array | null> {
  // A missing DEV is a cache failure, not a deterministic empty result. The
  // discovery helper intentionally treats missing references as empty for the
  // interactive XML fallback, but the geometry manifest must not record that
  // failure as `empty`.
  const normalizedDevPath = devPath.replace(/\\/g, '/');
  const canonicalDevPath = normalizedDevPath.toLowerCase().startsWith('dev/')
    ? normalizedDevPath
    : `DEV/${normalizedDevPath}`;
  if (!getFileByPath(files, canonicalDevPath)) {
    throw new Error(`DEV 文件不存在，无法生成 GLB: ${canonicalDevPath}`);
  }

  // 1. 发现 DEV 内部所有 MOD/STL 几何（parentTransform = IDENTITY，不含 CBM）
  const discovered = await discoverGeometriesFromDevPath(
    canonicalDevPath,
    files,
    IDENTITY_MATRIX.slice(),
    new Set<string>(),
    0,
    { instances: 0 },
    { strictDependencies: true },
  );

  if (discovered.mods.length === 0 && discovered.stls.length === 0) {
    return null;
  }

  // 2. 加载所有 MOD + STL，烘焙 placement 到顶点，合并到 devGroup
  const { loadXmlModFromFiles, applyPlacementTransformToSceneUnits } =
    await import('../viewer/xmlModLoader.js');
  const { parseStlBinary } = await import('../viewer/stlLoader.js');
  const { applyPhmColorOverride } = await import('../viewer/xmlModGeometry.js');

  const devGroup = new THREE.Group();
  devGroup.name = `glb-dev:${canonicalDevPath}`;
  devGroup.userData.devPath = canonicalDevPath;

  let modLoaded = 0;
  let stlLoaded = 0;
  const hasRenderableGeometry = (group: THREE.Group): boolean => {
    let found = false;
    group.traverse((object) => {
      if (found) return;
      const mesh = object as THREE.Mesh;
      const position = mesh.geometry?.getAttribute?.('position');
      if (mesh.isMesh && position && position.count > 0) found = true;
    });
    return found;
  };

  // 加载 MOD
  for (const geo of discovered.mods) {
    try {
      const group = await loadXmlModFromFiles(
        geo.modPath,
        files,
        geo.phmColor,
        geo.phmColorMaxA,
        { strict: true },
      );
      if (!group) continue;
      // EMPTY_DEVICE_XML and MODs whose parsed entities have no supported
      // renderable primitive are deterministic empty geometry. Do not add an
      // empty Group to the exported scene: an otherwise-empty DEV must become
      // the explicit `empty` manifest state, while mixed DEV content keeps its
      // real meshes only.
      if (!hasRenderableGeometry(group)) {
        group.traverse((object) => {
          const mesh = object as THREE.Mesh;
          mesh.geometry?.dispose?.();
          const materials = Array.isArray(mesh.material)
            ? mesh.material
            : mesh.material ? [mesh.material] : [];
          for (const material of materials) material?.dispose?.();
        });
        continue;
      }
      // 烘焙 DEV × PHM placement 到顶点（含 mm→m）
      applyPlacementTransformToSceneUnits(group, geo.placementTransformMatrix);
      devGroup.add(group);
      modLoaded++;
    } catch (err) {
      const strictError = new Error(`DEV ${canonicalDevPath} 内 MOD 加载失败: ${geo.modPath}`);
      (strictError as Error & { cause?: unknown }).cause = err;
      throw strictError;
    }
  }

  // 加载 STL
  for (const geo of discovered.stls) {
    try {
      const file = getFileByPath(files, geo.stlPath);
      if (!file) throw new Error(`STL 文件不存在: ${geo.stlPath}`);
      const buffer = await file.arrayBuffer();
      const group = parseStlBinary(buffer, geo.stlPath);
      if (!group) throw new Error(`STL 解析失败: ${geo.stlPath}`);
      if (!hasRenderableGeometry(group)) {
        group.traverse((object) => {
          const mesh = object as THREE.Mesh;
          mesh.geometry?.dispose?.();
          const materials = Array.isArray(mesh.material)
            ? mesh.material
            : mesh.material ? [mesh.material] : [];
          for (const material of materials) material?.dispose?.();
        });
        continue;
      }
      applyPhmColorOverride(group, geo.phmColor, geo.phmColorMaxA);
      // 烘焙 DEV × PHM placement 到顶点（含 mm→m）
      applyPlacementTransformToSceneUnits(group, geo.placementTransformMatrix);
      devGroup.add(group);
      stlLoaded++;
    } catch (err) {
      const strictError = new Error(`DEV ${canonicalDevPath} 内 STL 加载失败: ${geo.stlPath}`);
      (strictError as Error & { cause?: unknown }).cause = err;
      throw strictError;
    }
  }

  if (devGroup.children.length === 0) {
    // All referenced files were present and parsed, but none contained a
    // renderable primitive (for example EMPTY_DEVICE_XML or an intentionally
    // empty placeholder MOD).  This is a deterministic empty DEV, not a
    // dependency/parse failure; persist it as the manifest `empty` tombstone.
    return null;
  }

  debugLog(DEBUG_GIM_CACHE, `[glbCache] DEV ${canonicalDevPath}: ${modLoaded} MOD + ${stlLoaded} STL 合并完成`);

  // 3. 序列化 devGroup → GLB
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      devGroup,
      (gltf) => {
        if (gltf instanceof ArrayBuffer) {
          resolve(new Uint8Array(gltf));
        } else {
          reject(new Error(`GLTFExporter 输出类型无效: ${canonicalDevPath}`));
        }
      },
      (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        reject(new Error(`DEV 序列化失败: ${canonicalDevPath}: ${detail}`));
      },
      { binary: true },
    );
  });
}

// ===== GLB 加载（方案 C v2：DEV 粒度缓存命中路径） =====

/**
 * 从 GLB 二进制加载 DEV Group。
 *
 * 加载后的 Group 包含 DEV 内部所有 MOD + STL（placement 已烘焙）。
 * 调用方需额外应用 CBM 累积矩阵（applyPlacementTransformToSceneUnits）。
 *
 * @param devPath DEV 文件路径（用于日志）
 * @param glbBytes GLB 二进制字节
 * @returns THREE.Group；加载失败返回 null
 */
export function loadDevGlb(
  devPath: string,
  glbBytes: Uint8Array,
): Promise<THREE.Group | null> {
  const loader = getGltfLoader();
  const ab = glbBytes.buffer.slice(
    glbBytes.byteOffset,
    glbBytes.byteOffset + glbBytes.byteLength,
  ) as ArrayBuffer;

  return new Promise((resolve) => {
    loader.parse(
      ab,
      '',
      (gltf) => {
        const group = gltf.scene as THREE.Group;
        group.name = `glb-dev:${devPath}`;
        group.userData.devPath = devPath;
        resolve(group);
      },
      (error) => {
        console.error(`[glbCache] DEV GLB 加载失败: ${devPath}`, error);
        resolve(null);
      },
    );
  });
}
