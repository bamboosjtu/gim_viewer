import fragmentsWorkerUrl from '@thatopen/fragments/worker?url';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState } from '../app/state.js';
import { resolveWebIfcWasmBaseUrl } from './wasmAssets.js';
import { DEBUG_IFC_LOAD, DEBUG_FRAGMENTS } from '../config/debug.js';
import { debugLog, debugWarn } from '../utils/logger.js';

export type ModelEventCallbacks = {
  onModelAdded: (modelId: string) => void;
  onModelRemoved: (modelId: string) => void;
};

/**
 * 安全调用 fragments.core.update，确保 Fragments 内部异常（如 "Malformed tile"）
 * 不会变成 Uncaught promise 并中断加载链路。
 *
 * - update() 可能返回 void 或 Promise<void>（不同 OBC 版本），两者都兼容
 * - 同步抛出 → try/catch 捕获，warn 带 label 定位
 * - 异步 reject → .catch 捕获，warn 带 label 定位
 * - 不改变 web-ifc wasm 初始化逻辑
 * - 不开启 Fragments 缓存
 *
 * 日志策略：
 * - DEBUG_FRAGMENTS=true（开发环境）：输出完整 label + err，便于定位是哪个 IFC 出问题
 * - DEBUG_FRAGMENTS=false（生产环境）：静默，由全局 unhandledrejection 监听器兜底
 *
 * @param ctx Viewer 上下文
 * @param label 调用来源标识（如 'camera-controls-update' / 'model-added:<id>'），用于 warn 定位
 * @param force 是否强制重建（true 用于新模型加入）
 */
function safeFragmentsUpdate(ctx: ViewerContext, label: string, force = false): void {
  try {
    const result = ctx.fragments.core.update(force);
    // 不同 OBC 版本 update 可能返回 void 或 Promise<void>
    if (result && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).catch((err) => {
        debugWarn(DEBUG_FRAGMENTS, `[Fragments] update failed (${label})`, err);
      });
    }
  } catch (err) {
    debugWarn(DEBUG_FRAGMENTS, `[Fragments] update threw (${label})`, err);
  }
}

/** 初始化 IFC 引擎（仅首次调用生效） */
export async function initEngine(ctx: ViewerContext, state: AppState): Promise<void> {
  if (state.initialized) return;

  debugLog(DEBUG_IFC_LOAD, '[IFC Engine] init start', {
    href: window.location.href,
    origin: window.location.origin,
    baseURI: document.baseURI,
  });

  // 1. web-ifc WASM 校验 + ifcLoader.setup
  let wasmBase = '';
  try {
    debugLog(DEBUG_IFC_LOAD, '[IFC Engine] before wasm assert');
    wasmBase = await resolveWebIfcWasmBaseUrl();
    debugLog(DEBUG_IFC_LOAD, '[IFC Engine] after wasm assert, wasmBase=', wasmBase);
    debugLog(DEBUG_IFC_LOAD, '[IFC Engine] before ifcLoader.setup');
    await ctx.ifcLoader.setup({ autoSetWasm: false, wasm: { path: wasmBase, absolute: true } });
    debugLog(DEBUG_IFC_LOAD, '[IFC Engine] after ifcLoader.setup');
  } catch (err) {
    console.error('[IFC Engine] ifcLoader.setup failed', { wasmBase, error: err });
    throw err;
  }

  // 2. Fragments worker
  try {
    debugLog(DEBUG_IFC_LOAD, '[IFC Engine] fragments workerUrl', fragmentsWorkerUrl);
    ctx.fragments.init(fragmentsWorkerUrl);
    debugLog(DEBUG_IFC_LOAD, '[IFC Engine] after fragments.init');
  } catch (err) {
    console.error('[IFC Engine] fragments worker init failed', { error: err });
    throw err;
  }

  ctx.world.camera.controls?.addEventListener('update', () => {
    // 使用 safeFragmentsUpdate：相机移动触发 Fragments 重建 virtual tile 时，
    // 内部 "Malformed tile" 异常不能变成 Uncaught promise
    safeFragmentsUpdate(ctx, 'camera-controls-update', false);
  });
  state.initialized = true;
  debugLog(DEBUG_IFC_LOAD, '[IFC Engine] ready');
}

/** 注册模型生命周期事件（在 initEngine 后调用，仅首次生效） */
export function registerModelEvents(
  ctx: ViewerContext,
  state: AppState,
  callbacks: ModelEventCallbacks,
): void {
  ctx.fragments.list.onItemSet.add(({ value: model }) => {
    // 顺序：先加入 scene + state + UI（模型生命周期状态可见），再触发 fragments update
    // 即使 update 报错（如 "Malformed tile"），模型生命周期状态也要可见，便于后续清理
    // 不让 state 与 ctx.fragments.list 继续不同步
    try {
      model.useCamera((ctx.world.camera as any).three);
      (ctx.world.scene as any).three.add(model.object);

      state.loadedModels.set(model.modelId, { modelId: model.modelId, visible: true });
      callbacks.onModelAdded(model.modelId);

      // update(true) 强制重建 virtual tiles，最可能抛 "Malformed tile"
      // warn 中带 modelId，方便定位是哪一个 IFC 出问题
      safeFragmentsUpdate(ctx, `model-added:${model.modelId}`, true);
    } catch (err) {
      console.error(`[IFC Loader] onItemSet failed: ${model.modelId}`, err);
    }
  });
  ctx.fragments.list.onBeforeDelete.add(({ value: model }) => {
    (ctx.world.scene as any).three.remove(model.object);
  });
  ctx.fragments.list.onItemDeleted.add((modelId) => {
    callbacks.onModelRemoved(modelId);
    state.loadedModels.delete(modelId);
  });
  ctx.fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
    if (!('isLodMaterial' in material && material.isLodMaterial)) {
      material.polygonOffset = true; material.polygonOffsetUnits = 1; material.polygonOffsetFactor = Math.random();
    }
  });
}

/** 确保引擎已初始化并注册事件（幂等，可在多处调用） */
export async function ensureEngineReady(
  ctx: ViewerContext,
  state: AppState,
  callbacks: ModelEventCallbacks,
): Promise<void> {
  await initEngine(ctx, state);
  if (!state.eventsRegistered) {
    registerModelEvents(ctx, state, callbacks);
    state.eventsRegistered = true;
  }
}

/**
 * 直接加载 IFC Buffer（不启用 Fragments 缓存）。
 * 用于本地 IFC 打开等无 project_id 的场景。
 * GIM IFC entry 加载请使用 ifcEntryLoader.loadIfcEntry。
 */
export async function loadIfcBuffer(
  ctx: ViewerContext,
  name: string,
  buffer: Uint8Array,
  state: AppState,
  onProgress?: (progress: number) => void,
): Promise<void> {
  const modelId = name.replace(/\.ifc$/i, '');

  if (state.loadedModels.has(modelId)) {
    debugLog(DEBUG_IFC_LOAD, `[IFC Loader] 模型已加载，跳过: ${modelId}`);
    return;
  }

  await ctx.ifcLoader.load(buffer, true, modelId, {
    processData: { progressCallback: (progress) => { onProgress?.(progress); } },
  });
  // onItemSet 事件已更新 state.loadedModels
}
