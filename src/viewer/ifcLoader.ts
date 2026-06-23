import * as OBC from '@thatopen/components';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState } from '../app/state.js';

/** 初始化 IFC 引擎（仅首次调用生效） */
export async function initEngine(ctx: ViewerContext, state: AppState): Promise<void> {
  if (state.initialized) return;
  await ctx.ifcLoader.setup({ autoSetWasm: false, wasm: { path: '/', absolute: true } });
  const workerUrl = await OBC.FragmentsManager.getWorker();
  ctx.fragments.init(workerUrl);
  ctx.world.camera.controls?.addEventListener('update', () => ctx.fragments.core.update());
  state.initialized = true;
}

/** 注册模型生命周期事件（在 initEngine 后调用） */
export function registerModelEvents(
  ctx: ViewerContext,
  state: AppState,
  callbacks: {
    onModelAdded: (modelId: string) => void;
    onModelRemoved: (modelId: string) => void;
  },
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

/** 加载 IFC Buffer */
export async function loadIfcBuffer(ctx: ViewerContext, name: string, buffer: Uint8Array, state: AppState, onProgress?: (progress: number) => void): Promise<void> {
  const modelId = name.replace(/\.ifc$/i, '');
  await ctx.ifcLoader.load(buffer, true, modelId, {
    processData: { progressCallback: (progress) => { onProgress?.(progress); } },
  });
  state.loadedModels.set(modelId, { modelId, visible: true });
}
