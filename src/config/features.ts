/**
 * 功能开关配置。
 *
 * Fragments 缓存目前为实验功能，默认关闭。
 * 关闭时 loadIfcEntry 完全走 ctx.ifcLoader.load 路径，不读/写 .frag 文件。
 */
export const ENABLE_FRAGMENTS_CACHE = false;

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
 * - 'empty'     ：纯色 background，无瓦片（兜底模式）
 * - 'osm-online'：OpenStreetMap 在线 raster 底图（MVP 默认）
 * - 'pmtiles'   ：本地 PMTiles 矢量瓦片（后续离线方案）
 */
export type LineBasemapMode = 'empty' | 'osm-online' | 'pmtiles';

/**
 * MVP 阶段统一使用 OSM online。
 *
 * - 不区分开发 / 生产环境
 * - OSM 不可用时由 lineProjectView 回退 Canvas-only
 * - 后续生产正式底图、内网瓦片、PMTiles 离线方案另行扩展
 *
 * 注意：LINE_BASEMAP_MODE 仅在 ENABLE_MAPLIBRE_EXPERIMENT=true 时生效。
 *       若 ENABLE_MAPLIBRE_EXPERIMENT=false，仍走纯 Canvas 渲染。
 */
export const LINE_BASEMAP_MODE: LineBasemapMode = 'osm-online';
