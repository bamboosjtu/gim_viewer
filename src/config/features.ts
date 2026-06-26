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
 * 默认 false：线路地图仍走 `src/ui/lineMapView.ts` 纯 Canvas 渲染。
 * 仅当手动改为 true 时，才会动态加载 `src/ui/lineMapBaseLayer.ts` 的 probe 模块。
 *
 * 已实现（M4-A2 第 1 轮）：
 * - MapLibre 底图 + Canvas overlay + 交互桥接（hover/click/联动）
 * - ScaleControl + fitBounds(duration:0)
 * - 失败自动降级为 Canvas-only
 *
 * 不加载在线瓦片，不访问外网。
 */
export const ENABLE_MAPLIBRE_EXPERIMENT = false;

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
