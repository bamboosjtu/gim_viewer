/**
 * M4-A1/A2：MapLibre 底图层模块。
 *
 * 仅在 `ENABLE_MAPLIBRE_EXPERIMENT = true` 时由调用方动态 import 使用。
 * 默认功能关闭，主流程仍走 `lineMapView.ts` 纯 Canvas 渲染。
 *
 * M4-A1（已完成）：
 * - maplibre-gl 能在 Tauri + Vite 中被动态 import
 * - 能创建一个空白地图容器（使用本地空 style）
 * - 能销毁（remove() 释放资源）
 * - empty / pmtiles 模式不访问外网；osm-online 模式访问 https://tile.openstreetmap.org
 *
 * M4-A2 第 1 轮（已完成，原 M4-A2 已升级）：
 * - Handle 新增 project(lng, lat) → 屏幕像素（桥接 Canvas overlay）
 * - Handle 新增 onViewChange(callback) → 监听 move/zoom/resize
 * - 支持交互（pan/zoom），MapLibre 管理视图，Canvas overlay 跟随重绘
 * - 支持初始 bbox（fitBounds）
 * - Handle 新增 onPointerMove / onPointerClick / onPointerLeave → 桥接 Canvas 交互
 * - ScaleControl（仅 overlay 模式，bottom-right）
 * - fitBounds 使用 duration:0（无动画，立即同步 Canvas 重绘）
 *
 * M4-A2 第 2 轮（已完成）：
 * - PMTiles 离线瓦片最小预研（默认关闭，ENABLE_PMTILES_EXPERIMENT）
 * - 失败自动回退 empty style
 *
 * M4-A2 第 3 轮（本轮新增）：
 * - 支持 basemapMode 选择底图（empty / osm-online / pmtiles）
 * - OSM online 模式：MVP 默认，启用 attributionControl
 * - OSM tile 加载错误计数（阈值 3 次）→ 触发 onBasemapUnavailable 回调
 * - 调用方（lineProjectView）收到回调后销毁 probe + 回退 Canvas-only
 * - 不 reject 主流程，不影响 empty / pmtiles 模式
 *
 * 不做的事（留给后续）：
 * - 不做坐标偏移（GCJ-02）
 * - 不批量下载瓦片 / 不缓存为离线包
 * - 不添加 NavigationControl / FullscreenControl 等其他控件
 */

import type { Map as MapLibreMap, StyleSpecification, LngLatBoundsLike, ScaleControl, MapMouseEvent } from 'maplibre-gl';
import type { LineBasemapMode } from '../config/features.js';
import { createEmptyLineMapStyle, createPmtilesLineMapStyle, createOsmOnlineRasterStyle } from './lineMapStyle.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface LineMapBaseLayerHandle {
  /** 释放 MapLibre map 实例（remove() + 清空容器 + 解除引用 + protocol cleanup） */
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

/** PMTiles 配置（M4-A2 第 2 轮） */
export interface PmtilesOptions {
  /** 是否启用 PMTiles 瓦片 */
  enabled: boolean;
  /** PMTiles 文件 URL（如 `/tiles/demo.pmtiles`） */
  url: string;
}

/** createMapLibreProbe 的可选参数 */
export interface CreateMapLibreProbeOptions {
  /** 初始视图 bbox [minLng, minLat, maxLng, maxLat]，加载后自动 fitBounds */
  initialBounds?: [number, number, number, number];
  /** M4-A2 第 2 轮：PMTiles 瓦片配置（默认不启用，需 basemapMode='pmtiles' 才尝试加载） */
  pmtiles?: PmtilesOptions;
  /**
   * M4-A2 第 3 轮：底图模式选择。
   * - 'empty'：纯色 background，无瓦片（代码兜底）
   * - 'osm-online'：OpenStreetMap 在线 raster（MVP 默认，启用 attribution）
   * - 'pmtiles'：本地 PMTiles 矢量瓦片（需配合 pmtiles 选项）
   *
   * 优先级：osm-online > pmtiles > empty。
   * OSM 模式不依赖 PMTiles；PMTiles 模式不影响 OSM 模式。
   */
  basemapMode?: LineBasemapMode;
  /**
   * M4-A2 第 3 轮 Patch：OSM online tile 加载失败回调。
   *
   * 只用于判断底图服务不可用（阈值：3 次 tile error），
   * 不处理普通 MapLibre 初始化失败（仍走 reject 路径）。
   *
   * - 只触发一次
   * - 不 reject 整个 MapLibre 初始化
   * - 调用方负责销毁 probe + 回退 Canvas-only
   */
  onBasemapUnavailable?: (reason: unknown) => void;
}

// ---------------------------------------------------------------------------
// probe 工厂
// ---------------------------------------------------------------------------

/**
 * 创建一个 MapLibre 底图层容器。
 *
 * 行为：
 * - 在 `container` 内创建一个绝对定位的 div（z-index:0）作为 MapLibre 的挂载点
 * - 初始化 MapLibre map（OSM raster / empty / PMTiles style）
 * - 如果提供 initialBounds，加载后自动 fitBounds（duration:0 无动画）
 * - 等待 `load` 事件后 resolve（证明 WebGL 上下文可用）
 * - 启用交互（pan/zoom），MapLibre 管理视图
 * - 添加 ScaleControl（bottom-right，metric）
 * - PMTiles 启用时注册 protocol，失败自动回退 empty style
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

  // ---- M4-A2 第 3 轮：底图模式选择 ----
  // 优先级：osm-online > pmtiles > empty
  const basemapMode: LineBasemapMode = options?.basemapMode ?? 'empty';
  const isOsmMode = basemapMode === 'osm-online';
  // OSM 模式启用 attributionControl（© OpenStreetMap contributors）
  // MapLibre attributionControl 类型：false | AttributionControlOptions（不接受 true）
  // OSM 模式传 { compact: false } 始终展开 attribution；其他模式传 false 禁用

  // ---- M4-A2 第 2 轮：PMTiles protocol 注册（仅 pmtiles 模式尝试） ----
  let pmtilesProtocolHandle: { destroy(): void } | null = null;
  let usingPmtiles = false;
  if (basemapMode === 'pmtiles' && options?.pmtiles?.enabled && options.pmtiles.url) {
    try {
      const { setupPmtilesProtocol } = await import('./lineMapPmtiles.js');
      pmtilesProtocolHandle = await setupPmtilesProtocol(maplibre);
      usingPmtiles = true;
      console.log(`[PMTiles] using local demo: ${options.pmtiles.url}`);
    } catch (err) {
      console.warn('[PMTiles] unavailable, fallback to empty style:', err);
      pmtilesProtocolHandle = null;
      usingPmtiles = false;
    }
  }

  // 选择 style：
  // - osm-online 模式：使用 OSM raster style（不依赖 PMTiles）
  // - pmtiles 模式：protocol 注册成功时用 PMTiles style，否则回退 empty
  // - empty / 其他：empty style（最终兜底）
  let style: StyleSpecification;
  if (isOsmMode) {
    style = createOsmOnlineRasterStyle();
  } else if (usingPmtiles && options?.pmtiles?.url) {
    style = createPmtilesLineMapStyle(options.pmtiles.url);
  } else {
    style = createEmptyLineMapStyle();
  }

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
    style,
    center: options?.initialBounds
      ? [(options.initialBounds[0] + options.initialBounds[2]) / 2, (options.initialBounds[1] + options.initialBounds[3]) / 2]
      : [0, 0],
    zoom: options?.initialBounds ? 10 : 0,
    // M4-A2 第 3 轮：OSM 模式启用 attributionControl（ODbL 许可要求）
    // empty / pmtiles 模式不显示 attribution
    attributionControl: isOsmMode ? { compact: false } : false,
    // M4-A2：启用交互（pan/zoom），MapLibre 管理视图
    interactive: true,
    // empty/pmtiles 模式不发起瓦片请求；osm-online 模式请求 https://tile.openstreetmap.org
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
  // M4-A2 第 3 轮 Patch：OSM 模式下 tile error 计数 + 阈值触发 onBasemapUnavailable
  let osmTileErrorCount = 0;
  let basemapUnavailableNotified = false;
  const OSM_TILE_ERROR_THRESHOLD = 3;
  // M4-A2 第 3 轮 Patch：OSM error listener 引用，destroy 时显式清理
  // OSM 模式下 onLoad 不移除 error listener（需持续监听 load 后的 tile error），
  // 因此 destroy() 必须显式 off，避免 map.remove() 之前的回调残留
  let osmErrorHandler: ((e: unknown) => void) | null = null;

  function notifyBasemapUnavailable(reason: unknown): void {
    if (basemapUnavailableNotified) return;
    basemapUnavailableNotified = true;
    try {
      options?.onBasemapUnavailable?.(reason);
    } catch (err) {
      console.warn('[MapLibre probe] onBasemapUnavailable 回调抛出异常:', err);
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onLoad = () => {
      // M4-A2 第 3 轮 Patch：OSM 模式下 load 后仍需监听 tile error
      // 原因：style load 成功 ≠ 瓦片请求成功；OSM 瓦片请求在 load 后才大规模发起
      // 场景：style JSON 解析完成 → load 事件触发 → 后续 OSM tile 请求失败（net::ERR_CONNECTION_CLOSED）
      // 若此时移除 error listener，onBasemapUnavailable 永不触发，回退失效
      // 仅 empty / pmtiles 模式在 load 后移除（首个 error 才致命，load 成功即不再需要）
      if (!isOsmMode) {
        map.off('error', onError);
      }
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
      if (isOsmMode) {
        // M4-A2 第 3 轮 Patch：OSM 模式下瓦片 404 / 网络错误计数
        // 达到阈值后触发 onBasemapUnavailable，让调用方回退 Canvas-only
        // 注意：load 前后均会触发（onLoad 不移除 OSM error listener）
        osmTileErrorCount++;
        if (osmTileErrorCount <= OSM_TILE_ERROR_THRESHOLD) {
          console.warn(`[MapLibre probe] OSM tile error (${osmTileErrorCount}/${OSM_TILE_ERROR_THRESHOLD}, non-fatal):`, formatMapEvent(e));
        }
        if (osmTileErrorCount >= OSM_TILE_ERROR_THRESHOLD) {
          notifyBasemapUnavailable(e);
        }
        return;
      }
      map.off('load', onLoad);
      reject(new Error(`MapLibre probe 初始化失败: ${formatMapEvent(e)}`));
    };
    map.once('load', onLoad);
    // OSM 模式：可能有多个 tile 错误，用 on 持续监听（计数 + 阈值）
    //   - load 前的 error：style/supplier 初始化失败
    //   - load 后的 error：瓦片请求失败（net::ERR_CONNECTION_CLOSED 等）
    //   - onLoad 不移除 OSM error listener，保证 load 后仍计数
    // empty / pmtiles 模式：仅首个 error 致命，用 once
    if (isOsmMode) {
      map.on('error', onError);
      // 保存引用，destroy() 时显式 off（onLoad 不移除，需手动清理）
      osmErrorHandler = onError;
    } else {
      map.once('error', onError);
    }
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
      // M4-A2 第 3 轮 Patch：显式移除 OSM error listener
      // OSM 模式下 onLoad 不移除该 listener（需持续监听 load 后的 tile error），
      // 因此 destroy 时必须显式 off，防止 map.remove() 之前的回调残留或重复触发
      if (osmErrorHandler) {
        try {
          map.off('error', osmErrorHandler);
        } catch (err) {
          console.warn('[MapLibre probe] OSM error listener 清理失败:', err);
        }
        osmErrorHandler = null;
      }
      try {
        map.remove();
      } catch (err) {
        console.warn('[MapLibre probe] map.remove() 失败:', err);
      }
      if (mountDiv.parentNode) {
        mountDiv.parentNode.removeChild(mountDiv);
      }
      // M4-A2 第 2 轮：清理 PMTiles protocol（引用计数 -1，归零时 removeProtocol）
      if (pmtilesProtocolHandle) {
        try {
          pmtilesProtocolHandle.destroy();
        } catch (err) {
          console.warn('[MapLibre probe] PMTiles protocol cleanup 失败:', err);
        }
        pmtilesProtocolHandle = null;
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
