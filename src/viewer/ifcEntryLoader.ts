import * as OBC from '@thatopen/components';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState } from '../app/state.js';
import { isTauri } from '../desktop/runtime.js';
import { ENABLE_FRAGMENTS_CACHE } from '../config/features.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import {
  validateFragmentCache,
  readFragmentCacheFile,
  writeFragmentCacheFile,
  upsertFragmentCacheRecord,
} from '../desktop/database.js';

/**
 * 面向 GIM IFC entry 的加载器。
 *
 * 核心改进：Fragments 缓存命中时不读取 IFC buffer（lazy getIfcBuffer）。
 *
 * 流程：
 * 1. modelId 已加载 → return
 * 2. ENABLE_FRAGMENTS_CACHE=true 且 Tauri 且 currentProjectId 存在：
 *    a. validateFragmentCache（不读 IFC）
 *    b. valid → readFragmentCacheFile → ctx.fragments.core.load
 *    c. 加载后校验 loadedModels / fragments.list，失败则回退
 * 3. 缓存无效或加载失败 → 调用 getIfcBuffer() → ctx.ifcLoader.load
 * 4. IFC 加载成功且 ENABLE_FRAGMENTS_CACHE=true → 写 .frag
 * 5. 任何 Fragments 失败回退 IFC；IFC 失败才抛出
 *
 * 日志策略（M3-Final 降噪）：
 * - [Perf] / [IFC Loader] / [Fragments Cache] 命中/未命中 → debugLog（仅开发环境）
 * - 缓存损坏 / 读取失败 / 校验失败 → console.warn（始终输出）
 * - 错误抛出 → 上层 try/catch 捕获并 console.error
 */

export interface IfcEntryLike {
  name: string;
  path: string;
  modelId: string;
}

/**
 * 加载 GIM IFC entry，优先 Fragments 缓存（命中时不读 IFC buffer）。
 *
 * @param ctx Viewer 上下文
 * @param state 应用状态
 * @param entry IFC entry（含 name/path/modelId）
 * @param getIfcBuffer lazy 函数，仅在 Fragments 缓存未命中时调用
 * @param onProgress IFC 转换进度回调
 */
export async function loadIfcEntry(
  ctx: ViewerContext,
  state: AppState,
  entry: IfcEntryLike,
  getIfcBuffer: () => Promise<Uint8Array | null>,
  onProgress?: (progress: number) => void,
): Promise<void> {
  const { modelId, name, path: entryPath } = entry;

  // 1. 防御性短路
  if (state.loadedModels.has(modelId)) {
    debugLog(DEBUG_IFC_LOAD, `[IFC Loader] 模型已加载，跳过: ${modelId}`);
    return;
  }

  const projectId = state.currentProjectId;
  const canUseCache = ENABLE_FRAGMENTS_CACHE && isTauri() && projectId != null && !!entryPath;

  if (!ENABLE_FRAGMENTS_CACHE) {
    debugLog(DEBUG_IFC_LOAD, '[Fragments Cache] disabled, using IFC loader');
  }

  // 2. 尝试 Fragments 缓存（不读 IFC buffer）
  if (canUseCache && entryPath) {
    const cacheHit = await tryLoadFromFragmentsCache(ctx, state, modelId, entryPath);
    if (cacheHit) {
      debugLog(DEBUG_IFC_LOAD, `[Fragments Cache] 命中: ${entryPath} (modelId=${modelId})`);
      return;
    }
  }

  // 3. 缓存无效或未启用 → lazy 读取 IFC buffer
  debugLog(DEBUG_IFC_LOAD, `[Fragments Cache] 未命中: ${entryPath ?? '(无 entryPath)'} (modelId=${modelId})`);

  const tIfcRead = performance.now();
  const ifcBuffer = await getIfcBuffer();
  debugLog(DEBUG_IFC_LOAD, `[Perf] ifc read: ${Math.round(performance.now() - tIfcRead)} ms`);

  if (!ifcBuffer) {
    throw new Error(`IFC buffer 不可用: ${name} (${entryPath})`);
  }

  // 4. IFC 转换
  const tIfcLoad = performance.now();
  const model = await ctx.ifcLoader.load(ifcBuffer, true, modelId, {
    processData: { progressCallback: (progress) => { onProgress?.(progress); } },
  });
  debugLog(DEBUG_IFC_LOAD, `[Perf] ifc load: ${Math.round(performance.now() - tIfcLoad)} ms`);

  // onItemSet 事件已更新 loadedModels，此处不重复设置

  // 4b. 后置校验：等待一帧让 onItemSet 完成（state.loadedModels + ctx.fragments.list 更新）
  // 即使 onItemSet 内部 safeFragmentsUpdate 报了 "Malformed tile"（被 catch），
  // 模型对象本身应该已经进入 scene + fragments.list + loadedModels
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const inFragments = ctx.fragments.list.has(modelId);
  const loaded = state.loadedModels.has(modelId);
  const fragModel = ctx.fragments.list.get(modelId);
  const childCount = fragModel?.object?.children?.length ?? 0;

  debugLog(DEBUG_IFC_LOAD, '[IFC Loader] post-load validation', {
    modelId,
    inFragments,
    loaded,
    childCount,
  });

  // 不强制要求 childCount > 0：部分 Fragments 模型可能通过 virtual tiles 延迟显示
  // 但模型必须进入 fragments.list，否则后续 update / dispose / 高亮都无效
  if (!inFragments) {
    throw new Error(`IFC 加载后未进入 fragments.list: ${modelId} (${name})`);
  }

  // 5. 写 .frag 缓存（失败不影响主流程）
  if (canUseCache && entryPath) {
    await tryWriteFragmentsCache(model, projectId as number, entryPath, modelId, ifcBuffer.byteLength).catch((err) => {
      console.warn(`[Fragments Cache] 写入失败，不影响当前加载: ${entryPath}`, err);
    });
  }
}

/**
 * 尝试从 Fragments 缓存加载模型（不读 IFC buffer）。
 * @returns true 表示加载成功且通过运行时校验；false 表示未命中或加载失败
 */
async function tryLoadFromFragmentsCache(
  ctx: ViewerContext,
  state: AppState,
  modelId: string,
  entryPath: string,
): Promise<boolean> {
  const projectId = state.currentProjectId;
  if (projectId == null) return false;

  // 2a. 校验缓存（不读 IFC）
  const tValidate = performance.now();
  let validation;
  try {
    validation = await validateFragmentCache(projectId, entryPath, 0);
  } catch (err) {
    console.warn(`[Fragments Cache] 校验失败，回退 IFC: ${entryPath}`, err);
    return false;
  }
  debugLog(DEBUG_IFC_LOAD, `[Perf] fragment validate: ${Math.round(performance.now() - tValidate)} ms`);

  // 注意：sourceIfcSize 传 0 表示不校验 IFC 大小（因为不读 IFC buffer）
  // 仅校验：记录存在 + 版本匹配 + .frag 文件存在 + size > 0
  if (!validation.valid) {
    if (validation.has_record && !validation.fragments_version_match) {
      console.warn(`[Fragments Cache] 版本不匹配: ${entryPath} (stored=${validation.stored_fragments_version}, current=${validation.current_fragments_version})`);
    }
    return false;
  }

  // 2b. 读取 .frag
  const tRead = performance.now();
  let fragBytes: Uint8Array;
  try {
    fragBytes = await readFragmentCacheFile(projectId, entryPath);
  } catch (err) {
    console.warn(`[Fragments Cache] 读取失败，回退 IFC: ${entryPath}`, err);
    return false;
  }
  debugLog(DEBUG_IFC_LOAD, `[Perf] fragment read: ${Math.round(performance.now() - tRead)} ms`);

  if (fragBytes.byteLength === 0) {
    console.warn(`[Fragments Cache] 缓存文件为空，回退 IFC: ${entryPath}`);
    return false;
  }

  // 2c. 反序列化加载
  const tLoad = performance.now();
  try {
    const camera = (ctx.world.camera as unknown as OBC.SimpleCamera).three;
    await ctx.fragments.core.load(fragBytes, { modelId, camera });
    const loadMs = Math.round(performance.now() - tLoad);
    debugLog(DEBUG_IFC_LOAD, `[Perf] fragment load: ${loadMs} ms`);

    // 2d. 运行时校验：确认模型确实进入 loadedModels 和 fragments.list
    const inLoadedModels = state.loadedModels.has(modelId);
    const inFragmentsList = ctx.fragments.list.has(modelId);
    let childCount = 0;
    const model = ctx.fragments.list.get(modelId);
    if (model) {
      childCount = model.object.children.length;
    }

    debugLog(DEBUG_IFC_LOAD, `[Fragments Cache] 运行时校验: modelId=${modelId}, fragBytes=${fragBytes.byteLength}, inLoadedModels=${inLoadedModels}, inFragmentsList=${inFragmentsList}, children=${childCount}, loadMs=${loadMs}`);

    if (!inLoadedModels || !inFragmentsList) {
      console.warn(`[Fragments Cache] 运行时校验失败：模型未进入 loadedModels 或 fragments.list，回退 IFC: ${entryPath}`);
      // 尝试清理失败的加载
      try {
        if (inFragmentsList) {
          await ctx.fragments.list.delete(modelId);
        }
      } catch {
        // 忽略清理失败
      }
      return false;
    }

    return true;
  } catch (err) {
    console.warn(`[Fragments Cache] 反序列化失败，回退 IFC: ${entryPath}`, err);
    debugLog(DEBUG_IFC_LOAD, `[Perf] fragment load: ${Math.round(performance.now() - tLoad)} ms (failed)`);
    return false;
  }
}

/**
 * 尝试将已加载的 Fragments 模型写入缓存。
 * 任何步骤失败均 console.warn 并返回，不抛出。
 */
async function tryWriteFragmentsCache(
  model: { getBuffer(raw?: boolean): Promise<ArrayBuffer> },
  projectId: number,
  entryPath: string,
  modelId: string,
  sourceIfcSize: number,
): Promise<void> {
  // 序列化
  const tSerialize = performance.now();
  let buffer: ArrayBuffer;
  try {
    buffer = await model.getBuffer();
  } catch (err) {
    console.warn(`[Fragments Cache] 序列化失败，跳过缓存写入: ${entryPath}`, err);
    return;
  }
  debugLog(DEBUG_IFC_LOAD, `[Perf] fragment serialize: ${Math.round(performance.now() - tSerialize)} ms`);

  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength === 0) {
    console.warn(`[Fragments Cache] 序列化结果为空，跳过缓存写入: ${entryPath}`);
    return;
  }

  // 写文件
  const tWrite = performance.now();
  let writeResult: { path: string; size: number };
  try {
    writeResult = await writeFragmentCacheFile(projectId, entryPath, bytes);
  } catch (err) {
    console.warn(`[Fragments Cache] 写入文件失败，不影响当前加载: ${entryPath}`, err);
    return;
  }
  debugLog(DEBUG_IFC_LOAD, `[Perf] fragment write: ${Math.round(performance.now() - tWrite)} ms`);

  // 写记录
  const tUpsert = performance.now();
  try {
    await upsertFragmentCacheRecord(projectId, entryPath, modelId, sourceIfcSize, writeResult.size);
    debugLog(DEBUG_IFC_LOAD, `[Fragments Cache] 写入成功: ${entryPath} (size=${writeResult.size})`);
  } catch (err) {
    console.warn(`[Fragments Cache] 写入记录失败，不影响当前加载: ${entryPath}`, err);
  }
  debugLog(DEBUG_IFC_LOAD, `[Perf] fragment upsert: ${Math.round(performance.now() - tUpsert)} ms`);
}
