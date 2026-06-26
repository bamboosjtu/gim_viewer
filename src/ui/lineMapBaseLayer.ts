/**
 * M4-A1/A2-lite/A2：MapLibre 底图层模块。
 *
 * 仅在 `ENABLE_MAPLIBRE_EXPERIMENT = true` 时由调用方动态 import 使用。
 * 默认功能关闭，主流程仍走 `lineMapView.ts` 纯 Canvas 渲染。
 *
 * M4-A1（已完成）：
 * - maplibre-gl 能在 Tauri + Vite 中被动态 import
 * - 能创建一个空白地图容器（使用本地空 style）
 * - 能销毁（remove() 释放资源）
 * - 不加载在线瓦片、不访问外网
 *
 * M4-A2-lite（已完成）：
 * - Handle 新增 project(lng, lat) → 屏幕像素（桥接 Canvas overlay）
 * - Handle 新增 onViewChange(callback) → 监听 move/zoom/resize
 * - 支持交互（pan/zoom），MapLibre 管理视图，Canvas overlay 跟随重绘
 * - 支持初始 bbox（fitBounds）
 *
 * M4-A2 正式版第 1 轮（本轮新增）：
 * - Handle 新增 onPointerMove / onPointerClick / onPointerLeave → 桥接 Canvas 交互
 * - ScaleControl（仅 overlay 模式，bottom-right）
 * - fitBounds 使用 duration:0（无动画，立即同步 Canvas 重绘）
 *
 * 不做的事（留给后续）：
 * - 不加载 PMTiles / MBTiles
 * - 不做坐标偏移
 * - 不添加 NavigationControl / FullscreenControl 等其他控件
 */

import type { Map as MapLibreMap, StyleSpecification, LngLatBoundsLike, ScaleControl, MapMouseEvent } from 'maplibre-gl';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface LineMapBaseLayerHandle {
  /** 释放 MapLibre map 实例（remove() + 清空容器 + 解除引用） */
  destroy(): void;
  /** 返回底层 MapLibre 实例（仅用于实验性调试） */
  getMap(): MapLibreMap | null;
  /** 将经纬度投影为屏幕像素坐标（桥接 Canvas overlay 的 geoToScreen） */
  project(lng: number, lat: number): { x: number; y: number } | null;
  /** 注册视图变化回调（move/zoom/resize），返回取消注册函数 */
  onViewChange(callback: () => void): () => void;
  /** 调整视图以适配指定 bbox（LngLatBoundsLike: [minLng, minLat, maxLng, maxLat]），duration:0 无动画 */
  fitBounds(bounds: [number, number, number, number]): void;
  /** M4-A2：注册 pointer move 回调，参数为容器内像素坐标，返回取消注册函数 */
  onPointerMove(cb: (p: { x: number; y: number }) => void): () => void;
  /** M4-A2：注册 pointer click 回调，参数为容器内像素坐标，返回取消注册函数 */
  onPointerClick(cb: (p: { x: number; y: number }) => void): () => void;
  /** M4-A2：注册 pointer leave 回调（鼠标离开地图容器），返回取消注册函数 */
  onPointerLeave(cb: () => void): () => void;
}

/** createMapLibreProbe 的可选参数 */
export interface CreateMapLibreProbeOptions {
  /** 初始视图 bbox [minLng, minLat, maxLng, maxLat]，加载后自动 fitBounds */
  initialBounds?: [number, number, number, number];
}

// ---------------------------------------------------------------------------
// 空 style（本地，不访问外网）
// ---------------------------------------------------------------------------

/**
 * 最小空 style：仅一个 background 层，不引入任何 source / 瓦片。
 *
 * 目的：验证 MapLibre 能初始化容器，不依赖网络资源。
 * 后续 M4-A2 正式版才会接入 PMTiles source。
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
 * 创建一个 MapLibre 底图层容器。
 *
 * 行为：
 * - 在 `container` 内创建一个绝对定位的 div（z-index:0）作为 MapLibre 的挂载点
 * - 初始化 MapLibre map（空 style）
 * - 如果提供 initialBounds，加载后自动 fitBounds（duration:0 无动画）
 * - 等待 `load` 事件后 resolve（证明 WebGL 上下文可用）
 * - 启用交互（pan/zoom），MapLibre 管理视图
 * - 添加 ScaleControl（bottom-right，metric）
 * - 失败时抛出错误（调用方应 catch 并回退到 Canvas 主流程）
 *
 * 注意：本函数仅在 `ENABLE_MAPLIBRE_EXPERIMENT = true` 时被调用，
 * 调用方负责 feature flag 判断，本模块不做 flag 检查。
 */
export async function createMapLibreProbe(
  container: HTMLElement,
  options?: CreateMapLibreProbeOptions,
): Promise<LineMapBaseLayerHandle> {
  // 动态 import：默认关闭时 maplibre-gl 不会进入主 bundle
  const maplibre = await import('maplibre-gl');

  // 挂载点 div（底图层，z-index:0 在 Canvas overlay 之下）
  const mountDiv = document.createElement('div');
  mountDiv.style.cssText = `
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 0;
  `;
  container.appendChild(mountDiv);

  // 创建 MapLibre 实例
  const map = new maplibre.Map({
    container: mountDiv,
    style: EMPTY_STYLE,
    center: options?.initialBounds
      ? [(options.initialBounds[0] + options.initialBounds[2]) / 2, (options.initialBounds[1] + options.initialBounds[3]) / 2]
      : [0, 0],
    zoom: options?.initialBounds ? 10 : 0,
    attributionControl: false,
    // M4-A2-lite：启用交互（pan/zoom），MapLibre 管理视图
    interactive: true,
    // 离线：不尝试加载任何在线瓦片
    hash: false,
  });

  // M4-A2：ScaleControl（仅 overlay 模式需要，Canvas-only 不经过此路径）
  let scaleControl: ScaleControl | null = null;
  try {
    scaleControl = new maplibre.ScaleControl({ maxWidth: 100, unit: 'metric' });
    map.addControl(scaleControl, 'bottom-right');
  } catch (err) {
    console.warn('[MapLibre probe] ScaleControl 添加失败:', err);
    scaleControl = null;
  }

  // 等待 map 加载完成（证明 WebGL 上下文 + style 可用）
  await new Promise<void>((resolve, reject) => {
    const onLoad = () => {
      map.off('error', onError);
      // 加载后 fitBounds（如果提供了初始边界），duration:0 无动画
      if (options?.initialBounds) {
        try {
          const bounds: LngLatBoundsLike = [
            options.initialBounds[0], // minLng
            options.initialBounds[1], // minLat
            options.initialBounds[2], // maxLng
            options.initialBounds[3], // maxLat
          ];
          map.fitBounds(bounds, { padding: 48, duration: 0 });
        } catch (err) {
          console.warn('[MapLibre probe] fitBounds 失败:', err);
        }
      }
      resolve();
    };
    const onError = (e: unknown) => {
      map.off('load', onLoad);
      reject(new Error(`MapLibre probe 初始化失败: ${formatMapEvent(e)}`));
    };
    map.once('load', onLoad);
    map.once('error', onError);
  });

  let destroyed = false;

  // M4-A2：pointer 事件桥接（mousemove / click / mouseleave）
  // 使用 MapLibre 的 MapMouseEvent，e.point 为容器内像素坐标
  function onPointerMove(cb: (p: { x: number; y: number }) => void): () => void {
    if (destroyed) return () => {};
    const handler = (e: MapMouseEvent) => cb({ x: e.point.x, y: e.point.y });
    map.on('mousemove', handler);
    return () => {
      if (destroyed) return;
      map.off('mousemove', handler);
    };
  }

  function onPointerClick(cb: (p: { x: number; y: number }) => void): () => void {
    if (destroyed) return () => {};
    const handler = (e: MapMouseEvent) => cb({ x: e.point.x, y: e.point.y });
    map.on('click', handler);
    return () => {
      if (destroyed) return;
      map.off('click', handler);
    };
  }

  function onPointerLeave(cb: () => void): () => void {
    if (destroyed) return () => {};
    // 使用容器的 mouseleave 事件（比 MapLibre 的 mouseout 更可靠）
    const handler = () => cb();
    mountDiv.addEventListener('mouseleave', handler);
    return () => {
      if (destroyed) return;
      mountDiv.removeEventListener('mouseleave', handler);
    };
  }

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
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
      return destroyed ? null : map;
    },
    project(lng: number, lat: number): { x: number; y: number } | null {
      if (destroyed) return null;
      try {
        const p = map.project({ lng, lat });
        return { x: p.x, y: p.y };
      } catch {
        return null;
      }
    },
    onViewChange(callback: () => void): () => void {
      if (destroyed) return () => {};
      const events = ['move', 'zoom', 'resize'] as const;
      for (const ev of events) {
        map.on(ev, callback);
      }
      return () => {
        if (destroyed) return;
        for (const ev of events) {
          map.off(ev, callback);
        }
      };
    },
    fitBounds(bounds: [number, number, number, number]): void {
      if (destroyed) return;
      try {
        const llb: LngLatBoundsLike = [bounds[0], bounds[1], bounds[2], bounds[3]];
        // M4-A2：duration:0 无动画，确保 Canvas overlay 立即同步重绘
        map.fitBounds(llb, { padding: 48, duration: 0 });
      } catch (err) {
        console.warn('[MapLibre probe] fitBounds 失败:', err);
      }
    },
    onPointerMove,
    onPointerClick,
    onPointerLeave,
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
