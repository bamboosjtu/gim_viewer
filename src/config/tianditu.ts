/**
 * 天地图配置模块。
 *
 * 天地图 API 文档：https://console.tianditu.gov.cn/
 * 瓦片服务：WMTS，经纬度投影（EPSG:4326），URL 格式：
 *   https://t{n}.tianditu.gov.cn/DataServer?T={layer}&x={x}&y={y}&l={z}&tk={key}
 *
 * 子域 n ∈ {0..7}：t0 ~ t7（实测 t0/t1/t2/t3/t4 都可用，t5+ 偶发 502）
 * 图层类型 T：
 *   - img_w / img_c：卫星影像（w=WebMercator / c=EPSG:4326）
 *   - vec_w / vec_c：矢量底图
 *   - cva_w / cva_c：矢量注记（与 vec 配对使用，叠加显示中文地名/道路名）
 *   - ter_w / ter_c：地形渲染（DEM 着色）
 *   - cta_w / cta_c：地形注记（与 ter 配对使用）
 *
 * MapLibre raster source 约定使用 {z}/{x}/{y} 占位符 + EPSG:3857 投影。
 * 天地图 _w 系列原生就是 WebMercator 瓦片，可被 MapLibre 直接消费。
 *
 * 天地图 _c 系列（EPSG:4326）需要 MapLibre 自定义 projection 支持，本 MVP 不使用。
 * 线路工程 OSM 底图已是 EPSG:3857（MapLibre 默认），天地图 _w 系列无缝兼容。
 *
 * 安全性：key 通过 Vite env 注入到客户端，构建后会出现在产物中。
 * 此 key 仅用于瓦片访问（不可调用付费接口），即便泄露风险较低；
 * 服务端 key 控制不在 MVP 范围（需自建代理服务）。
 */

/** 天地图 API 密钥（构建期从 .env 注入） */
export const TIANDITU_KEY: string = import.meta.env.VITE_TIANDITU_KEY ?? '';

/** 天地图可用子域列表 */
export const TIANDITU_SUBDOMAINS: number[] = [0, 1, 2, 3, 4, 5, 6, 7];

/** 天地图图层类型 */
export type TiandituLayerType =
  | 'img_w' // 卫星影像（WebMercator）
  | 'cia_w' // 卫星影像注记（WebMercator，与 img_w 配对）
  | 'vec_w' // 矢量底图（WebMercator）
  | 'cva_w' // 矢量注记（WebMercator，与 vec_w 配对）
  | 'ter_w' // 地形渲染（WebMercator）
  | 'cta_w'; // 地形注记（WebMercator，与 ter_w 配对）

/** 天地图瓦片 attribution */
export const TIANDITU_ATTRIBUTION = '© 天地图';

/**
 * 生成天地图瓦片 URL 模板（MapLibre raster source 使用）。
 *
 * 输出形如：`https://t0.tianditu.gov.cn/DataServer?T=img_w&x={x}&y={y}&l={z}&tk=KEY`
 *
 * MapLibre 会自动把 {z}/{x}/{y} 替换为实际值。
 * 注意：天地图使用 `l` 表示 zoom level，与 MapLibre 的 {z} 占位符对应。
 *
 * @param layer 图层类型
 * @param subdomain 子域编号（0-7）
 */
export function buildTiandituTileUrl(layer: TiandituLayerType, subdomain: number): string {
  return `https://t${subdomain}.tianditu.gov.cn/DataServer?T=${layer}&x={x}&y={y}&l={z}&tk=${TIANDITU_KEY}`;
}

/**
 * 检查天地图密钥是否已配置。
 *
 * 调用方在初始化前应检查，未配置时回退到 OSM。
 */
export function isTiandituKeyAvailable(): boolean {
  return TIANDITU_KEY.length > 0;
}
