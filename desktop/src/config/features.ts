/** Trial stays opt-in until native draw-call and interaction gates pass. */
export const DEV_INSTANCE_BATCHES_DEBUG_KEY = 'gim-debug-dev-instancing';
export function isDevInstanceBatchesEnabled(): boolean {
  try { return localStorage.getItem(DEV_INSTANCE_BATCHES_DEBUG_KEY) === '1'; }
  catch { return false; }
}

/**
 * 线路底图模式。
 *
 * - 'empty'            ：纯色 background，无瓦片（兜底模式）
 * - 'osm-online'       ：OpenStreetMap 在线 raster 底图（MVP 默认）
 * - 'tianditu-satellite': 天地图卫星影像（img_w + cia_w 双图层叠加）
 * - 'tianditu-terrain' : 天地图地形图（ter_w + cta_w 双图层叠加，呈现地形起伏）
 * - 'tianditu-vector'  : 天地图矢量图（vec_w + cva_w 双图层叠加，呈现道路/地名）
 *
 * 天地图三种模式需要在本应用“更多 → 设置”中配置 API Key（保存在本地数据库）。
 * 未配置 key 时自动回退到 OSM（由 lineProjectView 处理）。
 */
export type LineBasemapMode =
  | 'empty'
  | 'osm-online'
  | 'tianditu-satellite'
  | 'tianditu-terrain'
  | 'tianditu-vector';

/**
 * 默认底图模式：OpenStreetMap online。
 *
 * 用户可通过 UI 切换到天地图地形图 / 矢量图（lineProjectView 底图切换控件）。
 * OSM 不可用时由 lineProjectView 回退 Canvas-only。
 *
 * 地图始终先显示 Canvas；在线底图可用时再切换 MapLibre overlay。
 */
export const LINE_BASEMAP_MODE: LineBasemapMode = 'osm-online';

/**
 * 运行时底图模式（可被 UI 切换修改）。
 *
 * 初始值 = LINE_BASEMAP_MODE（编译期默认），
 * lineProjectView 的底图切换控件会修改此变量并重建 MapLibre probe。
 * destroyLineMapView 时重置为编译期默认值。
 */
export let runtimeBasemapMode: LineBasemapMode = LINE_BASEMAP_MODE;

const LINE_BASEMAP_STORAGE_KEY = 'gim-line-basemap-mode';
const LINE_BASEMAP_MODES: readonly LineBasemapMode[] = [
  'empty', 'osm-online', 'tianditu-satellite', 'tianditu-terrain', 'tianditu-vector',
];

function readStoredBasemapMode(): LineBasemapMode {
  try {
    const value = localStorage.getItem(LINE_BASEMAP_STORAGE_KEY);
    if (value && (LINE_BASEMAP_MODES as readonly string[]).includes(value)) return value as LineBasemapMode;
  } catch { /* storage unavailable */ }
  return LINE_BASEMAP_MODE;
}

/**
 * 设置运行时底图模式。
 *
 * 由 lineProjectView 底图切换控件调用。
 * 仅修改模块内变量，不触发 probe 重建——重建由调用方负责。
 * 用户选择持久化到 localStorage，重新打开线路工程后沿用。
 */
export function setRuntimeBasemapMode(mode: LineBasemapMode): void {
  runtimeBasemapMode = mode;
  try { localStorage.setItem(LINE_BASEMAP_STORAGE_KEY, mode); } catch { /* storage unavailable */ }
}

/** 重置运行时底图模式为用户上次选择（首次为编译期默认值）。 */
export function resetRuntimeBasemapMode(): void {
  runtimeBasemapMode = readStoredBasemapMode();
}

/**
 * 悬链线（catenary）渲染开关（docs/schema/powerline-mod.md）。
 *
 * 默认 true：导线段用抛物线近似绘制弧垂（视觉示意）。
 * 设为 false 时回退直线段绘制。
 *
 * 启用时的行为：
 * - 对每条 inter-point 真实档距导线用抛物线近似 f(x) = sag * 4 * x * (1-x) 绘制；
 *   采样段数按屏幕弦长自适应（4–24 段），低缩放时减少 Canvas 指令，高缩放时保留细节
 * - sag 由 KVALUE 推算（kValue*L²），缺失或为 0 时回退 3% 经验弧垂，上限 10%*L
 * - 端点高差由 BLHA 第 3 段（elev）计算
 * - 同塔内部连接（same-point，端点 BLHA 相同）跳过渲染，保持直线
 * - 跳线（ISJUMPER=true）保持虚线样式，不走抛物线
 *
 * 设计原则：
 * - 不依赖 KVALUE 物理公式确认，仅做视觉示意
 * - 不修改 DB schema
 * - 后续 KVALUE 公式确认后可在此基础上扩展真实张力/弧垂
 */
export const ENABLE_CATENARY = true;

/**
 * web-ifc 多线程是否可激活（acc-plan P1-3 检测项）。
 *
 * web-ifc 在 Init 时检测 crossOriginIsolated，为 true 且未强制单线程时
 * 自动加载 web-ifc-mt.wasm 并启用 pthread。激活前提：
 * 1. 页面响应头包含 COOP: same-origin + COEP: credentialless
 *    （tauri.conf.json security.headers 配置）
 * 2. WebView2 支持 COEP credentialless
 * 3. 天地图/OSM 瓦片在 COEP 下仍可加载（天地图 CORS 行为待真机核验）
 *
 * 该函数仅报告环境能力，不改变行为——是否启用由响应头决定。
 */
export function isWebIfcMultiThreadingAvailable(): boolean {
  try {
    const g = globalThis as Record<string, unknown>;
    return g.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';
  } catch {
    return false;
  }
}

/** Product gate stays closed until cross-sample early-source acceptance completes. */
export const SUBSTATION_EARLY_SEMANTIC_DEFAULT = false;

/** Default BIM browsing representation; full remains an internal reference path. */
export type IfcOpeningPolicy = 'full' | 'omit-rel-voids' | 'bim-lod';
export const IFC_DETAIL_MODE_KEY='gim-ifc-detail-mode';
/** 近景 LOD1 的相机半径与中小开洞门槛（口径说明见 IFC 细节设置面板）。 */
export const IFC_NEAR_DETAIL_RADIUS_M = 30;
export const IFC_NEAR_SMALL_HOLE_MM = 50;
export function isIfcNearDetailEnabled():boolean {try{return localStorage.getItem(IFC_DETAIL_MODE_KEY)!=='far';}catch{return true;}}
export const IFC_LOD_CACHE_VERSION=`bim-lod-v1|single-parse-source-properties|near30m-small50mm|fragments@${__FRAGMENTS_PKG_VERSION__}|web-ifc@${__WEB_IFC_PKG_VERSION__}`;
export const IFC_NEAR_TEMPLATE_CACHE_VERSION='near-templates-v1';
