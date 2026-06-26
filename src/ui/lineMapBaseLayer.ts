/**
 * M4-A1：MapLibre 技术验证 probe 模块。
 *
 * 仅在 `ENABLE_MAPLIBRE_EXPERIMENT = true` 时由调用方动态 import 使用。
 * 默认功能关闭，主流程仍走 `lineMapView.ts` 纯 Canvas 渲染。
 *
 * 验证范围（M4-A1）：
 * - maplibre-gl 能在 Tauri + Vite 中被动态 import
 * - 能创建一个空白地图容器（使用本地空 style）
 * - 能销毁（remove() 释放资源）
 * - 不加载在线瓦片、不访问外网
 *
 * 不做的事（M4-A2 才做）：
 * - 不替换 Canvas 主流程
 * - 不改 geoToScreen()
 * - 不做 Canvas overlay 对接
 * - 不加载 PMTiles / MBTiles
 *
 * 使用示例：
 * ```ts
 * import { ENABLE_MAPLIBRE_EXPERIMENT } from '../config/features.js';
 * if (ENABLE_MAPLIBRE_EXPERIMENT) {
 *   const { createMapLibreProbe } = await import('./lineMapBaseLayer.js');
 *   const handle = await createMapLibreProbe(container);
 *   // ... 实验性操作 ...
 *   handle.destroy();
 * }
 * ```
 */

import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface LineMapBaseLayerHandle {
  /** 释放 MapLibre map 实例（remove() + 清空容器 + 解除引用） */
  destroy(): void;
  /** 返回底层 MapLibre 实例（仅用于实验性调试，M4-A2 后会被封装） */
  getMap(): MapLibreMap | null;
}

// ---------------------------------------------------------------------------
// 空 style（本地，不访问外网）
// ---------------------------------------------------------------------------

/**
 * 最小空 style：仅一个 background 层，不引入任何 source / 瓦片。
 *
 * 目的：验证 MapLibre 能初始化容器，不依赖网络资源。
 * 后续 M4-A2 才会接入 PMTiles source。
 */
const EMPTY_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': '#f8fafc',
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// probe 工厂
// ---------------------------------------------------------------------------

/**
 * 创建一个 MapLibre probe 容器。
 *
 * 行为：
 * - 在 `container` 内创建一个绝对定位的 div 作为 MapLibre 的挂载点
 * - 初始化 MapLibre map（空 style，中心点 [0, 0]，zoom 0）
 * - 等待 `load` 事件后 resolve（证明 WebGL 上下文可用）
 * - 失败时抛出错误（调用方应 catch 并回退到 Canvas 主流程）
 *
 * 注意：本函数仅在 `ENABLE_MAPLIBRE_EXPERIMENT = true` 时被调用，
 * 调用方负责 feature flag 判断，本模块不做 flag 检查。
 */
export async function createMapLibreProbe(
  container: HTMLElement,
): Promise<LineMapBaseLayerHandle> {
  // 动态 import：默认关闭时 maplibre-gl 不会进入主 bundle
  const maplibre = await import('maplibre-gl');

  // 挂载点 div
  const mountDiv = document.createElement('div');
  mountDiv.style.cssText = `
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 1;
  `;
  container.appendChild(mountDiv);

  // 创建 MapLibre 实例
  const map = new maplibre.Map({
    container: mountDiv,
    style: EMPTY_STYLE,
    center: [0, 0],
    zoom: 0,
    attributionControl: false,
    // 禁用交互（probe 仅验证初始化，不需要用户交互）
    interactive: false,
    // 离线：不尝试加载任何在线瓦片
    hash: false,
  });

  // 等待 map 加载完成（证明 WebGL 上下文 + style 可用）
  await new Promise<void>((resolve, reject) => {
    const onLoad = () => {
      map.off('error', onError);
      resolve();
    };
    const onError = (e: unknown) => {
      map.off('load', onLoad);
      reject(new Error(`MapLibre probe 初始化失败: ${formatMapEvent(e)}`));
    };
    map.once('load', onLoad);
    map.once('error', onError);
  });

  return {
    destroy() {
      try {
        map.remove();
      } catch (err) {
        console.warn('[MapLibre probe] map.remove() 失败:', err);
      }
      if (mountDiv.parentNode) {
        mountDiv.parentNode.removeChild(mountDiv);
      }
    },
    getMap() {
      return map;
    },
  };
}

/** 格式化 MapLibre 事件对象（用于错误消息） */
function formatMapEvent(e: unknown): string {
  if (e && typeof e === 'object' && 'error' in e) {
    const err = (e as { error?: unknown }).error;
    if (err instanceof Error) return err.message;
    return String(err);
  }
  return String(e);
}
