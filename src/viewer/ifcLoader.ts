import * as OBC from '@thatopen/components';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState } from '../app/state.js';
import { loadModelWithFragmentsCache } from './fragmentsCacheLoader.js';

export type ModelEventCallbacks = {
  onModelAdded: (modelId: string) => void;
  onModelRemoved: (modelId: string) => void;
};

/** 初始化 IFC 引擎（仅首次调用生效） */
export async function initEngine(ctx: ViewerContext, state: AppState): Promise<void> {
  if (state.initialized) return;
  await ctx.ifcLoader.setup({ autoSetWasm: false, wasm: { path: '/', absolute: true } });
  const workerUrl = await OBC.FragmentsManager.getWorker();
  ctx.fragments.init(workerUrl);
  ctx.world.camera.controls?.addEventListener('update', () => ctx.fragments.core.update());
  state.initialized = true;
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
 * 加载 IFC Buffer。
 *
 * @param ctx Viewer 上下文
 * @param name IFC 文件名（用于推导 modelId）
 * @param buffer IFC 文件二进制内容
 * @param state 应用状态
 * @param onProgress IFC 转换进度回调（仅未命中缓存路径会触发）
 * @param entryPath GIM 内部相对路径（作为 Fragments 缓存 key；不传则不启用缓存，走原 IFC load 路径）
 */
export async function loadIfcBuffer(
  ctx: ViewerContext,
  name: string,
  buffer: Uint8Array,
  state: AppState,
  onProgress?: (progress: number) => void,
  entryPath?: string,
): Promise<void> {
  await loadModelWithFragmentsCache(ctx, state, name, buffer, entryPath ?? null, onProgress);
}
