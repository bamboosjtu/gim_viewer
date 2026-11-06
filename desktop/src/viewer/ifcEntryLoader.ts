import { reportBackgroundError } from '../utils/backgroundErrors.js';
import type { ViewerContext } from './viewerEngine.js';
import { loadRawIfc } from './ifcConversion.js';
import type { IfcOpeningPolicy } from '../config/features.js';
import type { ViewerState as AppState } from '../shared/viewerState.js';
import type { ProjectLoadSession } from '../shared/projectSession.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import {
  perfCurrentSession,
  perfBegin,
  perfRecordExternalSpan,
} from '../utils/perfTimings.js';
import { registerIfcLoadDiagnostic } from './ifcLoadDiagnostics.js';
import type { IfcRegionalConnectionBatch } from './ifcConversion.js';


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

/** Source-backed IFC loading with explicit opening policy and session ownership. */
export interface IfcEntryLike {
  name: string;
  path: string;
  modelId: string;
}

/** 供变电加载性能诊断使用；不改变 IFC/Fragments 业务结果。 */
export type IfcLoadSource = 'lod-cache' | 'ifc';

/**
 * 加载 GIM IFC entry，按浏览 LOD 或显式开洞策略读取源文件。
 *
 * @param ctx Viewer 上下文
 * @param state 应用状态
 * @param entry IFC entry（含 name/path/modelId）
 * @param getIfcBuffer lazy 源读取函数
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
    /** File-level BIM LOD stages for the status bar. */
    onStage?: (stage: import('./ifcBimLoader.js').IfcLoadStage, meta?: Record<string, unknown>) => void;
    /** Per-file size/source/conversion/cache-write profile. */
    onProfile?: (profile: import('./ifcBimLoader.js').IfcFileProfile) => void;
    /** Transfer the one-shot raw IFC buffer to the conversion worker. */
    transferInput?: boolean;
    openingPolicy?: IfcOpeningPolicy;
    /** Incremental source-evidenced connection preview batches. */
    onRegionalBatch?: (batch: IfcRegionalConnectionBatch) => void;
    onRegionalComplete?: (meta: { objectCount: number; sequence: number }) => void;
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

  const openingPolicy = options.openingPolicy ?? 'bim-lod';
  if(openingPolicy==='bim-lod'){
    const {loadBimIfc}=await import('./ifcBimLoader.js');
    const model=await loadBimIfc(ctx,state,session,runtimeModelId,modelId,entryPath,getIfcBuffer,reportProgress,{
      onStage: options.onStage,
      onProfile: options.onProfile,
      onRegionalBatch: options.onRegionalBatch,
      onRegionalComplete: options.onRegionalComplete,
    });
    if(model)options.onLoadSource?.(model.object.userData.ifcLodCacheHit?'lod-cache':'ifc');
    return;
  }
  if (!isCurrent()) return;
  options.onLoadSource?.('ifc');

  const tIfcRead = performance.now();
  const ifcBuffer = await getIfcBuffer();
  debugLog(DEBUG_IFC_LOAD, `[Perf] ifc read: ${Math.round(performance.now() - tIfcRead)} ms`);

  if (!isCurrent()) return;

  if (!ifcBuffer) {
    throw new Error(`IFC buffer 不可用: ${name} (${entryPath})`);
  }

  // 4. IFC 转换
  registerIfcLoadDiagnostic(runtimeModelId, {
    entryPath,
    source: 'ifc',
    sessionId: perfSessionId,
  });
  const tIfcLoad = performance.now();
  const endWebIfcConversion = perfBegin(
    `变电 IFC web-ifc conversion · ${entryPath}`,
    { entryPath, phase: 'web-ifc conversion', source: 'ifc' },
    { id: perfSessionId },
  );
  let webIfcLoadFailed = false;
  try {
    await loadRawIfc(ctx, state, session, ifcBuffer, runtimeModelId, entryPath || name, reportProgress, perfSessionId,
      { transferInput: options.transferInput, openingPolicy });
  } catch (err) {
    webIfcLoadFailed = true;
    throw err;
  } finally {
    endWebIfcConversion(undefined, {
      entryPath,
      phase: 'web-ifc conversion',
      source: 'ifc',
      failed: webIfcLoadFailed,
    });
  }
  const ifcConversionMs = Math.max(0, performance.now() - tIfcLoad);
  debugLog(DEBUG_IFC_LOAD, `[Perf] ifc load: ${Math.round(ifcConversionMs)} ms`);
  perfRecordExternalSpan(
    `变电 IFC web-ifc load/conversion + Fragments callback composite · ${entryPath}`,
    ifcConversionMs,
    { entryPath, phase: 'web-ifc conversion/model-callback/scene-add composite' },
    perfSessionId,
  );

  // load() 可能在旧工程失效后才完成；模型已进入 Fragments 时必须立即销毁，
  // 后续不能继续写缓存或刷新当前工程 UI。
  if (!isCurrent()) {
    try { void Promise.resolve(ctx.fragments.core.disposeModel(runtimeModelId)).catch(reportBackgroundError); } catch { /* 尚未登记时无需清理 */ }
    return;
  }

  // onItemSet 事件已更新 loadedModels，此处不重复设置

  // core.load awaits setup; onItemSet registration is synchronous. Verify
  // registration directly instead of delaying each file by an animation frame.

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

}
