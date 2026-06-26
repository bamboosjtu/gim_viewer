/**
 * 底图运行状态服务。
 *
 * 跟踪当前线路工程地图的底图运行状态，供诊断（Ctrl+Shift+D）和 UI 展示使用。
 *
 * 状态生命周期：
 * - renderLineProjectPanels 渲染 Canvas-only → setBasemapStatus('canvas-only')
 * - MapLibre + OSM 初始化成功 → setBasemapStatus('osm-online')
 * - OSM 不可用回退 → setBasemapStatus('osm-unavailable-fallback', { fallbackReason })
 * - destroyLineMapView → resetBasemapStatus()
 *
 * 非持久化：仅内存，工程切换/清空场景时重置。
 */

/** 底图运行状态 */
export type BasemapStatus =
  | 'canvas-only'
  | 'osm-online'
  | 'osm-unavailable-fallback'
  | 'empty'
  | 'pmtiles';

/** 底图状态快照（供诊断 JSON / UI 展示） */
export interface BasemapStatusSnapshot {
  /** 当前底图状态 */
  status: BasemapStatus;
  /** LINE_BASEMAP_MODE 配置值 */
  mode: string;
  /** ENABLE_MAPLIBRE_EXPERIMENT 配置值 */
  maplibreEnabled: boolean;
  /** OSM tile error 计数（仅 OSM 模式有意义） */
  tileErrorCount?: number;
  /** 回退原因（仅 'osm-unavailable-fallback' 状态有值） */
  fallbackReason?: string;
  /** ISO 时间戳 */
  updatedAt: string;
}

/** 初始状态（无工程打开时） */
const INITIAL_STATUS: BasemapStatus = 'canvas-only';

let currentStatus: BasemapStatus = INITIAL_STATUS;
let currentMode: string = '';
let currentMaplibreEnabled: boolean = false;
let currentTileErrorCount: number = 0;
let currentFallbackReason: string | undefined;

/** 内部：生成 ISO 时间戳 */
function nowIso(): string {
  try {
    return new Date().toISOString();
  } catch {
    return String(Date.now());
  }
}

/**
 * 更新底图状态。
 *
 * 调用时机：
 * - lineProjectView Canvas-only 渲染：status='canvas-only'
 * - MapLibre + OSM 成功：status='osm-online'
 * - OSM 回退：status='osm-unavailable-fallback', fallbackReason=...
 * - MapLibre + empty/pmtiles 成功：status='empty'/'pmtiles'
 */
export function setBasemapStatus(
  status: BasemapStatus,
  options?: {
    mode?: string;
    maplibreEnabled?: boolean;
    tileErrorCount?: number;
    fallbackReason?: string;
  },
): void {
  currentStatus = status;
  if (options?.mode !== undefined) currentMode = options.mode;
  if (options?.maplibreEnabled !== undefined) currentMaplibreEnabled = options.maplibreEnabled;
  if (options?.tileErrorCount !== undefined) currentTileErrorCount = options.tileErrorCount;
  if (options?.fallbackReason !== undefined) currentFallbackReason = options.fallbackReason;
  // 状态非回退时清除 fallbackReason
  if (status !== 'osm-unavailable-fallback') {
    currentFallbackReason = undefined;
  }
}

/**
 * 获取底图状态快照（供诊断 JSON 使用）。
 */
export function getBasemapStatusSnapshot(): BasemapStatusSnapshot {
  return {
    status: currentStatus,
    mode: currentMode,
    maplibreEnabled: currentMaplibreEnabled,
    tileErrorCount: currentTileErrorCount || undefined,
    fallbackReason: currentFallbackReason,
    updatedAt: nowIso(),
  };
}

/**
 * 重置底图状态（工程切换 / 清空场景时调用）。
 */
export function resetBasemapStatus(): void {
  currentStatus = INITIAL_STATUS;
  currentMode = '';
  currentMaplibreEnabled = false;
  currentTileErrorCount = 0;
  currentFallbackReason = undefined;
}

/**
 * 生成底图状态的人类可读摘要（供 Ctrl+Shift+D 控制台输出）。
 */
export function summarizeBasemapStatus(): string {
  const snap = getBasemapStatusSnapshot();
  const lines: string[] = [
    `底图状态：${snap.status}`,
    `底图模式：${snap.mode || '（未设置）'}`,
    `MapLibre：${snap.maplibreEnabled ? '启用' : '关闭'}`,
  ];
  if (snap.tileErrorCount !== undefined && snap.tileErrorCount > 0) {
    lines.push(`OSM tile error：${snap.tileErrorCount}`);
  }
  if (snap.fallbackReason) {
    lines.push(`回退原因：${snap.fallbackReason}`);
  }
  return lines.join('\n');
}
