/**
 * 功能开关配置。
 *
 * Fragments 缓存目前为实验功能，默认关闭。
 * 关闭时 loadIfcEntry 完全走 ctx.ifcLoader.load 路径，不读/写 .frag 文件。
 */
export const ENABLE_FRAGMENTS_CACHE = false;

/**
 * MapLibre 技术验证开关（M4-A1/A2）。
 *
 * 开发调试：MapLibre + OSM online（npm run tauri:dev / npm run dev 自动启用）
 * 生产默认：不启用 MapLibre / 不使用 OSM
 * 强制开启：可通过 VITE_ENABLE_MAPLIBRE=true 在生产环境启用
 *
 * 已实现（M4-A2 第 1 轮）：
 * - MapLibre 底图 + Canvas overlay + 交互桥接（hover/click/联动）
 * - ScaleControl + fitBounds(duration:0)
 * - 失败自动降级为 Canvas-only
 *
 * 开发模式（DEV=true）：
 * - 默认启用 MapLibre overlay
 * - LINE_BASEMAP_MODE 自动 'osm-online'，加载 OSM 在线 raster 瓦片
 *
 * 生产模式（DEV=false）：
 * - 默认不启用 MapLibre
 * - LINE_BASEMAP_MODE 自动 'empty'，不加载瓦片
 * - 如需启用，设置环境变量 VITE_ENABLE_MAPLIBRE=true
 */
export const ENABLE_MAPLIBRE_EXPERIMENT =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_MAPLIBRE === 'true';

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
 * - 'empty'     ：纯色 background，无瓦片（生产默认，离线安全）
 * - 'osm-online'：OpenStreetMap 在线 raster 底图（仅开发调试用）
 * - 'pmtiles'   ：本地 PMTiles 矢量瓦片（后续离线方案）
 */
export type LineBasemapMode = 'empty' | 'osm-online' | 'pmtiles';

/**
 * 底图模式选择。
 *
 * 开发阶段：LINE_BASEMAP_MODE = 'osm-online'
 * - 用于快速调试线路 overlay 与底图对齐
 * - 仅在 ENABLE_MAPLIBRE_EXPERIMENT=true 时生效
 * - 不影响 Canvas-only 默认行为
 *
 * 生产阶段：默认 'empty'
 * - 不使用 OSM 在线瓦片
 * - 应切换到正式底图或离线瓦片方案（PMTiles / 内网瓦片服务 / 天地图）
 *
 * 注意：LINE_BASEMAP_MODE 只有在 ENABLE_MAPLIBRE_EXPERIMENT=true 时才生效。
 *       若 ENABLE_MAPLIBRE_EXPERIMENT=false，仍走纯 Canvas 渲染。
 */
export const LINE_BASEMAP_MODE: LineBasemapMode = import.meta.env.DEV ? 'osm-online' : 'empty';
