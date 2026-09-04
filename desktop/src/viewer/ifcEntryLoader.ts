import * as OBC from '@thatopen/components';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import { isTauri } from '@desktop/runtime.js';
import { isFragmentsCacheEnabled, FRAGMENTS_CACHE_COMPOSED_KEY } from '../config/features.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import {
  validateFragmentCache,
  readFragmentCacheFile,
  writeFragmentCacheFile,
  upsertFragmentCacheRecord,
  deleteFragmentCacheRecord,
} from '@desktop/database.js';
import {
  perfCurrentSession,
  perfRecordFragmentsCacheOperation,
  perfRecordFragmentsCacheOutcome,
  perfSetFragmentsCacheEnabled,
} from '../utils/perfTimings.js';

/**
 * Fragments 缓存版本键（P0-3）：绑定 @thatopen/fragments 与 web-ifc 包版本，
 * 任一依赖升级自动失效全部 .frag 缓存，避免跨版本加载旧格式。
 */
const FRAG_CACHE_VERSION = FRAGMENTS_CACHE_COMPOSED_KEY;

/**
 * 输出 IFC 模型的位置诊断日志（仅 debug 模式）。
 *
 * 用于与 MOD/STL 的 bbox 对比，估算 projectSourceToViewer offset。
 *
 * 注意：不调用 THREE.Box3.setFromObject —— 该方法会递归遍历整个 Fragments
 * 模型的所有 geometry 顶点计算包围盒，在大型 IFC 模型（数十万顶点）上
 * 会长时间阻塞主线程导致卡死。coordinateToOrigin=true 时 object.position
 * 已反映 IFC 原点归一化偏移，足以用于估算 sourceToViewer。
 *
 * 输出：modelId、object.position、object.matrixWorld、children 数量
 */
function logIfcModelBBox(ctx: ViewerContext, modelId: string, label: string): void {
  if (!DEBUG_IFC_LOAD) return;
  const model = ctx.fragments.list.get(modelId);
  if (!model?.object) {
    debugLog(DEBUG_IFC_LOAD, `[CoordAlign] ${label} model.object 不可用: ${modelId}`);
    return;
  }
  const pos = model.object.position;
  const mw = model.object.matrixWorld;
  const childCount = model.object.children.length;
  debugLog(DEBUG_IFC_LOAD, `[CoordAlign] ${label} IFC pose: ${modelId}`, {
    objectPosition: [pos.x, pos.y, pos.z],
    matrixWorld: mw.elements,
    childCount,
  });
}

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

/** 供变电加载性能诊断使用；不改变 IFC/Fragments 业务结果。 */
export type IfcLoadSource = 'fragments-cache' | 'ifc';

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
  options: {
    session?: ProjectLoadSession;
    /** 性能会话 id；旧工程迟到的缓存 IPC/span 不得写入新快照。 */
    perfSessionId?: number;
    /** 加载来源确定后回调一次；调用方可记录 cache hit/miss。 */
    onLoadSource?: (source: IfcLoadSource) => void;
  } = {},
): Promise<void> {
  const { modelId, name, path: entryPath } = entry;
  const session = options.session ?? state.captureProjectSession();
  const perfSessionId = options.perfSessionId ?? perfCurrentSession().id;
  const isCurrent = () => state.isCurrentSession(session);
  // web-ifc 解析期间也可能持续回调进度；旧工程任务不能把提示文字写到
  // 新工程的状态栏/加载层。
  const reportProgress = (progress: number) => {
    if (isCurrent()) onProgress?.(progress);
  };

  if (!isCurrent()) return;

  // 1. 防御性短路
  if (state.loadedModels.has(modelId)) {
    debugLog(DEBUG_IFC_LOAD, `[IFC Loader] 模型已加载，跳过: ${modelId}`);
    return;
  }

  // logical ID 用于业务索引/数据库；runtime ID 绑定源 GIM 和本次会话，
  // 防止工程 A 的迟到 Fragments 事件占用工程 B 的 key。
  const runtimeModelId = state.getRuntimeModelId(modelId, session);
  state.registerIfcRuntimeModel(modelId, runtimeModelId, session);
  if (ctx.fragments.list.has(runtimeModelId)) return;

  const projectId = session.projectId;
  const cacheEnabled = isFragmentsCacheEnabled();
  perfSetFragmentsCacheEnabled(cacheEnabled, perfSessionId);
  if (!cacheEnabled) {
    debugLog(DEBUG_IFC_LOAD, '[Fragments Cache] disabled, using IFC loader');
  }
  const sourceGimSha256 = session.sourceSha256?.trim() || '';
  const canUseCache = cacheEnabled && isTauri() && projectId != null && !!entryPath && !!sourceGimSha256;

  // 2. 尝试 Fragments 缓存（不读 IFC buffer）
  if (canUseCache && entryPath) {
    const cacheHit = await tryLoadFromFragmentsCache(
      ctx, state, runtimeModelId, modelId, entryPath, sourceGimSha256, session, perfSessionId,
    );
    if (!isCurrent()) return;
    if (cacheHit) {
      options.onLoadSource?.('fragments-cache');
      debugLog(DEBUG_IFC_LOAD, `[Fragments Cache] 命中: ${entryPath} (modelId=${modelId})`);
      // 诊断：缓存命中路径同样输出 IFC bbox（与 MOD/STL bbox 对比）
      logIfcModelBBox(ctx, runtimeModelId, 'cache-hit');
      return;
    }
  }

  if (!isCurrent()) return;

  // 3. 缓存无效或未启用 → lazy 读取 IFC buffer
  debugLog(DEBUG_IFC_LOAD, `[Fragments Cache] 未命中: ${entryPath ?? '(无 entryPath)'} (modelId=${modelId})`);
  options.onLoadSource?.('ifc');

  const tIfcRead = performance.now();
  const ifcBuffer = await getIfcBuffer();
  debugLog(DEBUG_IFC_LOAD, `[Perf] ifc read: ${Math.round(performance.now() - tIfcRead)} ms`);

  if (!isCurrent()) return;

  if (!ifcBuffer) {
    throw new Error(`IFC buffer 不可用: ${name} (${entryPath})`);
  }

  // 4. IFC 转换
  const tIfcLoad = performance.now();
  const model = await ctx.ifcLoader.load(ifcBuffer, true, runtimeModelId, {
    processData: { progressCallback: reportProgress },
  });
  debugLog(DEBUG_IFC_LOAD, `[Perf] ifc load: ${Math.round(performance.now() - tIfcLoad)} ms`);

  // load() 可能在旧工程失效后才完成；模型已进入 Fragments 时必须立即销毁，
  // 后续不能继续写缓存或刷新当前工程 UI。
  if (!isCurrent()) {
    try { ctx.fragments.core.disposeModel(runtimeModelId); } catch { /* 尚未登记时无需清理 */ }
    return;
  }

  // onItemSet 事件已更新 loadedModels，此处不重复设置

  // 4b. 后置校验：等待一帧让 onItemSet 完成（state.loadedModels + ctx.fragments.list 更新）
  // 即使 onItemSet 内部 safeFragmentsUpdate 报了 "Malformed tile"（被 catch），
  // 模型对象本身应该已经进入 scene + fragments.list + loadedModels
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  if (!isCurrent()) {
    try { ctx.fragments.core.disposeModel(runtimeModelId); } catch { /* ignore */ }
    return;
  }

  const inFragments = ctx.fragments.list.has(runtimeModelId);
  const loaded = state.loadedModels.has(modelId);
  const fragModel = ctx.fragments.list.get(runtimeModelId);
  const childCount = fragModel?.object?.children?.length ?? 0;

  debugLog(DEBUG_IFC_LOAD, '[IFC Loader] post-load validation', {
    modelId,
    runtimeModelId,
    inFragments,
    loaded,
    childCount,
  });

  // 不强制要求 childCount > 0：部分 Fragments 模型可能通过 virtual tiles 延迟显示
  // 但模型必须进入 fragments.list，否则后续 update / dispose / 高亮都无效
  if (!inFragments) {
    throw new Error(`IFC 加载后未进入 fragments.list: ${runtimeModelId} (${name})`);
  }

  // 4c. 诊断：输出 IFC model 的 bbox（与 MOD/STL bbox 对比，辅助估算 projectSourceToViewer offset）
  logIfcModelBBox(ctx, runtimeModelId, 'ifc-load');

  // 5. 写 .frag 缓存（失败不影响主流程）
  if (canUseCache && entryPath) {
    if (!isCurrent()) {
      try { ctx.fragments.core.disposeModel(runtimeModelId); } catch { /* ignore */ }
      return;
    }
    await tryWriteFragmentsCache(
      state, model, projectId as number, entryPath, modelId, ifcBuffer.byteLength, sourceGimSha256, session, perfSessionId,
    ).catch((err) => {
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
  runtimeModelId: string,
  logicalModelId: string,
  entryPath: string,
  sourceGimSha256: string,
  session: ProjectLoadSession,
  perfSessionId: number,
): Promise<boolean> {
  const projectId = session.projectId;
  if (projectId == null || !state.isCurrentSession(session)) return false;

  // 2a. 校验缓存（不读 IFC）
  const tValidate = performance.now();
  let validation;
  try {
    perfRecordFragmentsCacheOutcome('attempt', perfSessionId);
    validation = await validateFragmentCache(
      projectId,
      entryPath,
      0,
      FRAG_CACHE_VERSION,
      sourceGimSha256,
      { sessionId: perfSessionId },
    );
    perfRecordFragmentsCacheOperation('validate', performance.now() - tValidate, 0, false, perfSessionId);
  } catch (err) {
    perfRecordFragmentsCacheOperation('validate', performance.now() - tValidate, 0, true, perfSessionId);
    perfRecordFragmentsCacheOutcome('fallback', perfSessionId);
    console.warn(`[Fragments Cache] 校验失败，回退 IFC: ${entryPath}`, err);
    return false;
  }
  debugLog(DEBUG_IFC_LOAD, `[Perf] fragment validate: ${Math.round(performance.now() - tValidate)} ms`);
  if (!state.isCurrentSession(session)) return false;

  // sourceIfcSize 传 0 表示不校验 IFC 大小（因为不读 IFC buffer），但源 GIM
  // SHA-256 是强身份条件，必须在 Rust 侧完成匹配。
  if (!validation.valid) {
    perfRecordFragmentsCacheOutcome('miss', perfSessionId);
    // 校验已确认记录或文件存在但实际大小不一致时，先删除坏记录和文件。
    // 这样“截断但非空”的 .frag 不会在每次打开时重复命中同一坏缓存，
    // 也满足损坏缓存自愈后回退 IFC 的语义；版本/SHA 不匹配则保留旧
    // 记录，便于诊断并由后续成功写入覆盖。
    if (validation.has_record
      && validation.fragment_file_exists
      && !validation.fragment_file_size_match) {
      const tDelete = performance.now();
      let deleteFailed = false;
      await deleteFragmentCacheRecord(projectId, entryPath, { sessionId: perfSessionId }).catch((err) => {
        deleteFailed = true;
        console.warn(`[Fragments Cache] 删除尺寸不一致的缓存失败，继续回退 IFC: ${entryPath}`, err);
      });
      perfRecordFragmentsCacheOperation('delete', performance.now() - tDelete, 0, deleteFailed, perfSessionId);
    }
    if (validation.has_record && !validation.fragments_version_match) {
      console.warn(`[Fragments Cache] 版本不匹配: ${entryPath} (stored=${validation.stored_fragments_version}, current=${validation.current_fragments_version})`);
    }
    return false;
  }

  // 2b. 读取 .frag
  const tRead = performance.now();
  let fragBytes: Uint8Array;
  try {
    fragBytes = await readFragmentCacheFile(projectId, entryPath, { sessionId: perfSessionId });
    perfRecordFragmentsCacheOperation('read', performance.now() - tRead, fragBytes.byteLength, false, perfSessionId);
  } catch (err) {
    perfRecordFragmentsCacheOperation('read', performance.now() - tRead, 0, true, perfSessionId);
    perfRecordFragmentsCacheOutcome('fallback', perfSessionId);
    console.warn(`[Fragments Cache] 读取失败，删除坏缓存并回退 IFC: ${entryPath}`, err);
    // 读取失败可能是在工程切换后才返回；旧 session 不得删除新工程
    // （同一 projectId 换源文件时尤其重要）的缓存记录。
    if (state.isCurrentSession(session)) {
      const tDelete = performance.now();
      let deleteFailed = false;
      await deleteFragmentCacheRecord(projectId, entryPath, { sessionId: perfSessionId }).catch(() => { deleteFailed = true; });
      perfRecordFragmentsCacheOperation('delete', performance.now() - tDelete, 0, deleteFailed, perfSessionId);
    }
    return false;
  }
  debugLog(DEBUG_IFC_LOAD, `[Perf] fragment read: ${Math.round(performance.now() - tRead)} ms`);
  if (!state.isCurrentSession(session)) return false;

  // validate 与 read 之间文件可能被截断（另一个进程清理缓存、磁盘故障
  // 或 IPC 传输异常）。不要把短 buffer 交给 Fragments；否则某些版本可能
  // 接受它并产生一个“命中但模型不完整”的假成功。
  const expectedFragmentSize = Number(validation.fragment_file_size);
  if (fragBytes.byteLength === 0
    || (Number.isFinite(expectedFragmentSize)
      && expectedFragmentSize > 0
      && fragBytes.byteLength !== expectedFragmentSize)) {
    perfRecordFragmentsCacheOutcome('fallback', perfSessionId);
    const reason = fragBytes.byteLength === 0
      ? '缓存文件为空'
      : `缓存文件尺寸变化（expected=${expectedFragmentSize}, actual=${fragBytes.byteLength}）`;
    console.warn(`[Fragments Cache] ${reason}，删除坏缓存并回退 IFC: ${entryPath}`);
    const tDelete = performance.now();
    let deleteFailed = false;
    await deleteFragmentCacheRecord(projectId, entryPath, { sessionId: perfSessionId }).catch(() => { deleteFailed = true; });
    perfRecordFragmentsCacheOperation('delete', performance.now() - tDelete, 0, deleteFailed, perfSessionId);
    return false;
  }

  // 2c. 反序列化加载
  const tLoad = performance.now();
  try {
    const camera = (ctx.world.camera as unknown as OBC.SimpleCamera).three;
    await ctx.fragments.core.load(fragBytes, { modelId: runtimeModelId, camera });
    const loadMs = Math.round(performance.now() - tLoad);
    perfRecordFragmentsCacheOperation('load', performance.now() - tLoad, fragBytes.byteLength, false, perfSessionId);
    debugLog(DEBUG_IFC_LOAD, `[Perf] fragment load: ${loadMs} ms`);
    if (!state.isCurrentSession(session)) {
      try { await ctx.fragments.list.delete(runtimeModelId); } catch { /* ignore */ }
      return false;
    }

    // 2d. 运行时校验：确认模型确实进入 loadedModels 和 fragments.list
    const inLoadedModels = state.loadedModels.has(logicalModelId);
    const inFragmentsList = ctx.fragments.list.has(runtimeModelId);
    let childCount = 0;
    const model = ctx.fragments.list.get(runtimeModelId);
    if (model) {
      childCount = model.object.children.length;
    }

    debugLog(DEBUG_IFC_LOAD, `[Fragments Cache] 运行时校验: modelId=${logicalModelId}, runtimeModelId=${runtimeModelId}, fragBytes=${fragBytes.byteLength}, inLoadedModels=${inLoadedModels}, inFragmentsList=${inFragmentsList}, children=${childCount}, loadMs=${loadMs}`);

    if (!inLoadedModels || !inFragmentsList) {
      perfRecordFragmentsCacheOutcome('fallback', perfSessionId);
      console.warn(`[Fragments Cache] 运行时校验失败：模型未进入 loadedModels 或 fragments.list，回退 IFC: ${entryPath}`);
      // 尝试清理失败的加载
      try {
        if (inFragmentsList) {
          await ctx.fragments.list.delete(runtimeModelId);
        }
      } catch {
        // 忽略清理失败
      }
      return false;
    }

    perfRecordFragmentsCacheOutcome('hit', perfSessionId);
    return true;
  } catch (err) {
    perfRecordFragmentsCacheOperation('load', performance.now() - tLoad, fragBytes.byteLength, true, perfSessionId);
    perfRecordFragmentsCacheOutcome('fallback', perfSessionId);
    console.warn(`[Fragments Cache] 反序列化失败，删除坏缓存并回退 IFC: ${entryPath}`, err);
    debugLog(DEBUG_IFC_LOAD, `[Perf] fragment load: ${Math.round(performance.now() - tLoad)} ms (failed)`);
    // core.load 也可能在工程切换后才 reject；不让旧任务清理当前
    // 工程同路径的新缓存。当前工程仍有效时才执行自愈删除。
    if (state.isCurrentSession(session)) {
      const tDelete = performance.now();
      let deleteFailed = false;
      await deleteFragmentCacheRecord(projectId, entryPath, { sessionId: perfSessionId }).catch(() => { deleteFailed = true; });
      perfRecordFragmentsCacheOperation('delete', performance.now() - tDelete, 0, deleteFailed, perfSessionId);
    }
    return false;
  }
}

/**
 * 尝试将已加载的 Fragments 模型写入缓存。
 * 任何步骤失败均 console.warn 并返回，不抛出。
 */
async function tryWriteFragmentsCache(
  state: AppState,
  model: { getBuffer(raw?: boolean): Promise<ArrayBuffer> },
  projectId: number,
  entryPath: string,
  modelId: string,
  sourceIfcSize: number,
  sourceGimSha256: string,
  session: ProjectLoadSession,
  perfSessionId: number,
): Promise<void> {
  if (!state.isCurrentSession(session)) return;
  // 序列化
  const tSerialize = performance.now();
  let buffer: ArrayBuffer;
  try {
    buffer = await model.getBuffer();
    perfRecordFragmentsCacheOperation('serialize', performance.now() - tSerialize, buffer.byteLength, false, perfSessionId);
  } catch (err) {
    perfRecordFragmentsCacheOperation('serialize', performance.now() - tSerialize, 0, true, perfSessionId);
    console.warn(`[Fragments Cache] 序列化失败，跳过缓存写入: ${entryPath}`, err);
    return;
  }
  if (!state.isCurrentSession(session)) return;
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
    writeResult = await writeFragmentCacheFile(projectId, entryPath, bytes, sourceGimSha256, { sessionId: perfSessionId });
    perfRecordFragmentsCacheOperation('write', performance.now() - tWrite, writeResult.size, false, perfSessionId);
  } catch (err) {
    perfRecordFragmentsCacheOperation('write', performance.now() - tWrite, 0, true, perfSessionId);
    console.warn(`[Fragments Cache] 写入文件失败，不影响当前加载: ${entryPath}`, err);
    return;
  }
  if (!state.isCurrentSession(session)) return;
  debugLog(DEBUG_IFC_LOAD, `[Perf] fragment write: ${Math.round(performance.now() - tWrite)} ms`);

  // 写记录
  const tUpsert = performance.now();
  try {
    await upsertFragmentCacheRecord(projectId, entryPath, modelId, sourceIfcSize, writeResult.size, FRAG_CACHE_VERSION, sourceGimSha256, { sessionId: perfSessionId });
    perfRecordFragmentsCacheOperation('upsert', performance.now() - tUpsert, 0, false, perfSessionId);
    debugLog(DEBUG_IFC_LOAD, `[Fragments Cache] 写入成功: ${entryPath} (size=${writeResult.size})`);
  } catch (err) {
    perfRecordFragmentsCacheOperation('upsert', performance.now() - tUpsert, 0, true, perfSessionId);
    console.warn(`[Fragments Cache] 写入记录失败，不影响当前加载: ${entryPath}`, err);
  }
  debugLog(DEBUG_IFC_LOAD, `[Perf] fragment upsert: ${Math.round(performance.now() - tUpsert)} ms`);
}
