/**
 * 方案 C v2：DEV 粒度 → glTF 离线预序列化缓存服务。
 *
 * 在首次打开 GIM 时，遍历 CBM 树收集所有 seed devPath，
 * 对每个 DEV 递归展开所有 MOD + STL，合并为一个 THREE.Group，
 * 使用 GLTFExporter 序列化为 .glb 二进制文件缓存到本地磁盘。
 * 二次打开时可直接用 GLTFLoader 加载 .glb，跳过全部 XML 解析。
 *
 * 关键设计（v2 变更，详见 18c 文档 §10）：
 * - 按 DEV 文件粒度缓存（非按 MOD 文件粒度）
 *   理由：DEV 粒度大幅减少加载次数（5982 → 数百）
 * - 序列化时烘焙 DEV 内部所有 transform（DEV × PHM × SUBDEVICE × Entity + mm→m）
 * - CBM 累积矩阵运行时应用（同一 DEV 可被多 CBM 引用）
 * - 数学等价性：两次 applyPlacementTransformToSceneUnits（各 ×0.001）
 *   等价于一次完整应用（CBM × DEV × PHM，×0.001），详见 18c §10.4
 *
 * 缓存路径：app_data_dir/glbcache/{project_id}/{devPath}.glb
 * 版本化：通过 GEOMETRY_CACHE_VERSION 失效
 *
 * 关联文档：docs/schema/18c-experiment-mod-to-gltf-cache.md
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { discoverGeometriesFromDevPath } from './modGeometryDiscovery.js';
import { DEBUG_GIM_CACHE } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 单例 GLTFLoader（内部无状态，可安全复用） */
let _gltfLoader: GLTFLoader | null = null;
function getGltfLoader(): GLTFLoader {
  if (!_gltfLoader) _gltfLoader = new GLTFLoader();
  return _gltfLoader;
}

/** GLB 缓存结果 */
export interface GlbCacheResult {
  /** 已缓存的 DEV 数量 */
  cachedCount: number;
  /** 序列化跳过的数量（空几何 / 解析失败等） */
  skippedCount: number;
  /** 缓存失败的条目 */
  errors: Array<{
    entryPath: string;
    message: string;
  }>;
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
 * @returns GLB 二进制 bytes；空几何或失败返回 null
 */
export async function serializeDevToGlb(
  devPath: string,
  files: Map<string, File>,
): Promise<Uint8Array | null> {
  // 1. 发现 DEV 内部所有 MOD/STL 几何（parentTransform = IDENTITY，不含 CBM）
  const discovered = await discoverGeometriesFromDevPath(
    devPath,
    files,
    IDENTITY_MATRIX.slice(),
    new Set<string>(),
  );

  if (discovered.mods.length === 0 && discovered.stls.length === 0) {
    return null;
  }

  // 2. 加载所有 MOD + STL，烘焙 placement 到顶点，合并到 devGroup
  const { loadXmlModFromFiles, applyPlacementTransformToSceneUnits } =
    await import('../viewer/xmlModLoader.js');
  const { parseStlBinary } = await import('../viewer/stlLoader.js');

  const devGroup = new THREE.Group();
  devGroup.name = `glb-dev:${devPath}`;
  devGroup.userData.devPath = devPath;

  let modLoaded = 0;
  let stlLoaded = 0;

  // 加载 MOD
  for (const geo of discovered.mods) {
    try {
      const group = await loadXmlModFromFiles(geo.modPath, files);
      if (!group) continue;
      // 烘焙 DEV × PHM placement 到顶点（含 mm→m）
      applyPlacementTransformToSceneUnits(group, geo.placementTransformMatrix);
      devGroup.add(group);
      modLoaded++;
    } catch (err) {
      console.warn(`[glbCache] DEV ${devPath} 内 MOD 加载失败: ${geo.modPath}`, err);
    }
  }

  // 加载 STL
  for (const geo of discovered.stls) {
    try {
      const file = files.get(geo.stlPath);
      if (!file) continue;
      const buffer = await file.arrayBuffer();
      const group = parseStlBinary(buffer, geo.stlPath);
      if (!group) continue;
      // 烘焙 DEV × PHM placement 到顶点（含 mm→m）
      applyPlacementTransformToSceneUnits(group, geo.placementTransformMatrix);
      devGroup.add(group);
      stlLoaded++;
    } catch (err) {
      console.warn(`[glbCache] DEV ${devPath} 内 STL 加载失败: ${geo.stlPath}`, err);
    }
  }

  if (devGroup.children.length === 0) {
    return null;
  }

  debugLog(DEBUG_GIM_CACHE, `[glbCache] DEV ${devPath}: ${modLoaded} MOD + ${stlLoaded} STL 合并完成`);

  // 3. 序列化 devGroup → GLB
  const exporter = new GLTFExporter();
  return new Promise((resolve) => {
    exporter.parse(
      devGroup,
      (gltf) => {
        if (gltf instanceof ArrayBuffer) {
          resolve(new Uint8Array(gltf));
        } else {
          console.warn(`[glbCache] 非预期 GLTFExporter 输出类型: ${devPath}`);
          resolve(null);
        }
      },
      (error) => {
        console.error(`[glbCache] DEV 序列化失败: ${devPath}`, error);
        resolve(null);
      },
      { binary: true },
    );
  });
}

/**
 * 缓存 CBM seed DEV 文件列表为 GLB 二进制（按 DEV 粒度）。
 *
 * 在首次打开 GIM 时（缓存写入流程）调用，遍历 devPaths 列表，
 * 对每个 DEV 递归展开所有 MOD + STL，合并序列化为 .glb 写入本地磁盘。
 *
 * @param projectId 数据库 gim_project.id
 * @param files GIM 解压后的文件集合
 * @param devPaths CBM seed 去重后的 DEV 路径列表（如 ["DEV/abc.dev", ...]）
 */
export async function cacheGlbFiles(
  projectId: number,
  files: Map<string, File>,
  devPaths: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<GlbCacheResult> {
  const { writeGlbFile } = await import('../desktop/database.js');

  const errors: Array<{ entryPath: string; message: string }> = [];
  let cachedCount = 0;
  let skippedCount = 0;

  debugLog(DEBUG_GIM_CACHE, `[glbCache] 开始序列化 ${devPaths.length} 个 DEV → GLB（分批 yield）...`);

  // 分批处理，每批之间 yield 主线程，防止 UI 冻结
  const BATCH_SIZE = 8;
  try {
    for (let i = 0; i < devPaths.length; i += BATCH_SIZE) {
      const batch = devPaths.slice(i, i + BATCH_SIZE);
      for (const devPath of batch) {
        try {
          const glbBytes = await serializeDevToGlb(devPath, files);
          if (!glbBytes) {
            skippedCount++;
            continue;
          }
          await writeGlbFile(projectId, devPath, glbBytes);
          cachedCount++;
        } catch (err) {
          errors.push({
            entryPath: devPath,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // 每批后 yield 主线程，让 UI 有机会更新
      if (i + BATCH_SIZE < devPaths.length) {
        await new Promise((r) => setTimeout(r, 0));
      }
      if ((i + BATCH_SIZE) % (BATCH_SIZE * 5) === 0) {
        debugLog(DEBUG_GIM_CACHE, `[glbCache] 进度: ${Math.min(i + BATCH_SIZE, devPaths.length)}/${devPaths.length}`);
      }
      onProgress?.(Math.min(i + BATCH_SIZE, devPaths.length), devPaths.length);
    }

    debugLog(DEBUG_GIM_CACHE, `[glbCache] 序列化完成: ${cachedCount} DEV 缓存, ${skippedCount} 跳过, ${errors.length} 失败`);
  } finally {
    // 写入版本标记文件（finally 确保即使部分失败也写入，供 validate_gim_cache 校验）
    try {
      const { writeGeometryCacheVersion } = await import('../desktop/database.js');
      await writeGeometryCacheVersion(projectId);
      debugLog(DEBUG_GIM_CACHE, `[glbCache] 版本标记已写入 (projectId=${projectId})`);
    } catch (err) {
      console.warn('[glbCache] 写入版本标记失败:', err);
    }
  }

  return { cachedCount, skippedCount, errors };
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
