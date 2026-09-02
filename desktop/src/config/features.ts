/**
 * 功能开关配置。
 *
 * Fragments 缓存目前为实验功能，默认关闭。
 * 关闭时 loadIfcEntry 完全走 ctx.ifcLoader.load 路径，不读/写 .frag 文件。
 */
const ENABLE_FRAGMENTS_CACHE_BASE = false;

/** Fragments 缓存灰度开关的 localStorage 覆盖键（设为 '1' 开启实测） */
export const FRAGMENTS_CACHE_DEBUG_KEY = 'gim-debug-fragments-cache';

/** 缓存键基础版本（语义变更时手动 bump，配合依赖包版本自动失效） */
export const FRAGMENTS_CACHE_KEY_VERSION = 'fragments-cache-v6';

/**
 * Fragments 缓存是否启用（acc-plan P0-3 灰度开关）。
 *
 * 默认关闭；localStorage 设 FRAGMENTS_CACHE_DEBUG_KEY='1' 可临时开启，
 * 用于真机灰度实测，无需重新构建。
 */
export function isFragmentsCacheEnabled(): boolean {
  if (ENABLE_FRAGMENTS_CACHE_BASE) return true;
  try {
    // eslint-disable-next-line no-restricted-globals
    return localStorage.getItem(FRAGMENTS_CACHE_DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 组合 Fragments 缓存版本键：绑定 @thatopen/fragments 与 web-ifc 包版本。
 *
 * 任一依赖升级都会生成新的版本串 → 旧 .frag 缓存全部失效重建，
 * 避免「升级后加载旧格式缓存」导致的 Malformed tile 类错误。
 */
/** 实际安装版本的缓存键（构建期注入，非 package.json 的 semver 范围） */
export const FRAGMENTS_CACHE_COMPOSED_KEY = fragmentsCacheKey(
  __FRAGMENTS_PKG_VERSION__,
  __WEB_IFC_PKG_VERSION__,
);

export function fragmentsCacheKey(fragmentsVer: string, webIfcVer: string): string {
  return `${FRAGMENTS_CACHE_KEY_VERSION}|fragments@${fragmentsVer}|web-ifc@${webIfcVer}`;
}

/**
 * MVP 阶段默认启用 MapLibre overlay。
 *
 * 当前策略（M4-A2 第 3 轮 Patch）：
 * - MVP 不区分开发 / 生产；
 * - 默认使用 OSM online raster；
 * - OSM 不可用时由 lineProjectView 回退 Canvas-only；
 * - 如需强制关闭，可临时改为 false 或后续接入 env flag。
 *
 * 已实现（M4-A2 第 1 轮）：
 * - MapLibre 底图 + Canvas overlay + 交互桥接（hover/click/联动）
 * - ScaleControl + fitBounds(duration:0)
 * - 失败自动降级为 Canvas-only
 */
export const ENABLE_MAPLIBRE_EXPERIMENT = true;

/**
 * PMTiles 离线瓦片预研开关（M4-A2 第 2 轮）。
 *
 * 默认 false：MapLibre 使用 empty style（纯色背景）。
 * 仅当 ENABLE_MAPLIBRE_EXPERIMENT=true 且本开关=true 时才尝试加载本地 PMTiles。
 *
 * 失败时自动回退 empty style，不影响 overlay 交互。
 *
 * 瓦片文件路径由 PMTILES_DEMO_URL 指定，不提交大文件到 git。
 */
export const ENABLE_PMTILES_EXPERIMENT = false;

/**
 * PMTiles 瓦片文件 URL（相对于 public 目录）。
 *
 * 实际文件放在 `public/tiles/demo.pmtiles`，通过 `/tiles/demo.pmtiles` 访问。
 * 文件不存在时自动回退 empty style。
 */
export const PMTILES_DEMO_URL = '/tiles/demo.pmtiles';

/**
 * M4-A2 第 3 轮：底图模式定义。
 *
 * - 'empty'            ：纯色 background，无瓦片（兜底模式）
 * - 'osm-online'       ：OpenStreetMap 在线 raster 底图（MVP 默认）
 * - 'pmtiles'          ：本地 PMTiles 矢量瓦片（后续离线方案）
 * - 'tianditu-satellite': 天地图卫星影像（img_w + cia_w 双图层叠加）
 * - 'tianditu-terrain' : 天地图地形图（ter_w + cta_w 双图层叠加，呈现地形起伏）
 * - 'tianditu-vector'  : 天地图矢量图（vec_w + cva_w 双图层叠加，呈现道路/地名）
 *
 * 天地图三种模式需要 .env 中配置 VITE_TIANDITU_KEY。
 * 未配置 key 时自动回退到 OSM（由 lineProjectView 处理）。
 */
export type LineBasemapMode =
  | 'empty'
  | 'osm-online'
  | 'pmtiles'
  | 'tianditu-satellite'
  | 'tianditu-terrain'
  | 'tianditu-vector';

/**
 * MVP 默认底图模式：OpenStreetMap online。
 *
 * 用户可通过 UI 切换到天地图地形图 / 矢量图（lineProjectView 底图切换控件）。
 * OSM 不可用时由 lineProjectView 回退 Canvas-only。
 *
 * 注意：LINE_BASEMAP_MODE 仅在 ENABLE_MAPLIBRE_EXPERIMENT=true 时生效。
 *       若 ENABLE_MAPLIBRE_EXPERIMENT=false，仍走纯 Canvas 渲染。
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

/**
 * 设置运行时底图模式。
 *
 * 由 lineProjectView 底图切换控件调用。
 * 仅修改模块内变量，不触发 probe 重建——重建由调用方负责。
 */
export function setRuntimeBasemapMode(mode: LineBasemapMode): void {
  runtimeBasemapMode = mode;
}

/** 重置运行时底图模式为编译期默认值（destroyLineMapView 调用） */
export function resetRuntimeBasemapMode(): void {
  runtimeBasemapMode = LINE_BASEMAP_MODE;
}

/**
 * 悬链线（catenary）渲染开关（M4-B3C，14 号文档 §6.6）。
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
