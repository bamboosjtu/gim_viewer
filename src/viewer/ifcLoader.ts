import * as OBC from '@thatopen/components';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState } from '../app/state.js';
import { getWebIfcWasmBaseUrl, assertWebIfcWasmAvailable } from './wasmAssets.js';

export type ModelEventCallbacks = {
  onModelAdded: (modelId: string) => void;
  onModelRemoved: (modelId: string) => void;
};

/** 初始化 IFC 引擎（仅首次调用生效） */
export async function initEngine(ctx: ViewerContext, state: AppState): Promise<void> {
  if (state.initialized) return;

  // 1. web-ifc WASM 校验 + ifcLoader.setup
  const wasmBase = getWebIfcWasmBaseUrl();
  try {
    await assertWebIfcWasmAvailable();
    await ctx.ifcLoader.setup({ autoSetWasm: false, wasm: { path: wasmBase, absolute: true } });
  } catch (err) {
    console.error('[IFC Engine] ifcLoader.setup failed', { wasmBase, error: err });
    throw err;
  }

  // 2. Fragments worker
  try {
    const workerUrl = await OBC.FragmentsManager.getWorker();
    ctx.fragments.init(workerUrl);
  } catch (err) {
    console.error('[IFC Engine] fragments worker init failed', { error: err });
    throw err;
  }

  ctx.world.camera.controls?.addEventListener('update', () => ctx.fragments.core.update());
  state.initialized = true;
  console.log('[IFC Engine] ready');
}

/** 注册模型生命周期事件（在 initEngine 后调用，仅首次生效） */
export function registerModelEvents(
  ctx: ViewerContext,
  state: AppState,
  callbacks: ModelEventCallbacks,
): void {
  ctx.fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera((ctx.world.camera as any).three);
    (ctx.world.scene as any).three.add(model.object);
    ctx.fragments.core.update(true);
    state.loadedModels.set(model.modelId, { modelId: model.modelId, visible: true });
    callbacks.onModelAdded(model.modelId);
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
    console.log(`[IFC Loader] 模型已加载，跳过: ${modelId}`);
    return;
  }

  await ctx.ifcLoader.load(buffer, true, modelId, {
    processData: { progressCallback: (progress) => { onProgress?.(progress); } },
  });
  // onItemSet 事件已更新 state.loadedModels
}
