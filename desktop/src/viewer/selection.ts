import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState } from '../app/state.js';
import { resetHighlight, HIGHLIGHT_STYLE } from './highlight.js';

export type OnElementSelected = (modelId: string, localId: number) => void;

/** 注册 3D canvas 点击拾取 */
export function setupSelection(
  ctx: ViewerContext,
  state: AppState,
  container: HTMLElement,
  onElementSelected: OnElementSelected,
): void {
  container.addEventListener('click', async (e: MouseEvent) => {
    if (!state.initialized || ctx.fragments.list.size === 0) return;
    const canvas = container.querySelector('canvas');
    if (e.target !== container && e.target !== canvas) return;

    const mouse = new THREE.Vector2(e.clientX, e.clientY);

    try {
      const result = await ctx.fragments.raycast({
        camera: (ctx.world.camera as any).three,
        mouse,
        dom: (container.querySelector('canvas') as HTMLCanvasElement) || container,
      });

      if (!result) {
        await resetHighlight(ctx, state);
        return;
      }

      const { localId, fragments: hitModel } = result;
      const modelId = hitModel.modelId;

      // 高亮选中构件
      await resetHighlight(ctx, state);
      const items: OBC.ModelIdMap = { [modelId]: new Set([localId]) };
      await ctx.fragments.highlight(HIGHLIGHT_STYLE, items as any);
      state.highlightedItems = items as any;

      // 通知外部
      onElementSelected(modelId, localId);
    } catch (err) {
      console.warn('射线拾取失败:', err);
    }
  });
}
