/**
 * M4-A2 第 2/3 轮：MapLibre style 工厂。
 *
 * 提供六种 style：
 * - empty：纯色背景，不加载瓦片（兜底模式）
 * - osm-online：OpenStreetMap 在线 raster 底图（MVP 默认）
 * - pmtiles：本地 PMTiles vector source（实验性，默认关闭）
 * - tianditu-satellite：天地图卫星影像（img_w + cia_w 双图层）
 * - tianditu-terrain：天地图地形图（ter_w + cta_w 双图层）
 * - tianditu-vector：天地图矢量图（vec_w + cva_w 双图层）
 *
 * empty / pmtiles 都包含一个 background 层，确保即使 PMTiles 加载失败也有底色。
 * PMTiles style 不强制 source-layer，避免因瓦片元数据不匹配而加载失败。
 *
 * 天地图三种 style 采用"底图层 + 注记层"双 source 叠加设计：
 * - 底图层：img_w（卫星）/ ter_w（地形）/ vec_w（矢量），提供基础地图信息
 * - 注记层：cia_w / cta_w / cva_w，叠加中文地名、道路名等标注
 * 双 source 设计是天地图官方推荐的 MapLibre 集成方式（注记层透明背景）。
 *
 * osm-online / 天地图仅在开发阶段用于调试 overlay 与底图对齐：
 * - 不批量下载瓦片
 * - 不预取大范围瓦片
 * - 不缓存为离线包
 * - 必须显示 attribution
 */

import type { StyleSpecification } from 'maplibre-gl';
import {
  buildTiandituTileUrl,
  TIANDITU_ATTRIBUTION,
  TIANDITU_KEY,
} from '../config/tianditu.js';

/** 空白 style：仅一个 background 层，不引入任何 source / 瓦片 */
export function createEmptyLineMapStyle(): StyleSpecification {
  return {
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
}

/**
 * OpenStreetMap 在线 raster style。
 *
 * - 使用官方 tile.openstreetmap.org（HTTPS），不使用 a/b/c 子域
 * - tileSize: 256（OSM 标准）
 * - attribution 必须显示（ODbL 许可要求）
 *
 * 限制（M4-A2 第 3 轮 spec）：
 * - 不批量下载瓦片
 * - 不预取大范围瓦片
 * - 不缓存为离线包
 * - 不做 GCJ-02 坐标偏移
 */
export function createOsmOnlineRasterStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: [
          'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [
      {
        id: 'osm-raster',
        type: 'raster',
        source: 'osm',
      },
    ],
  };
}

/**
 * 天地图卫星影像 style：img_w 底图 + cia_w 注记双图层。
 *
 * - img_w：卫星影像（高分辨率遥感影像）
 * - cia_w：影像注记（中文地名/道路名标签，叠加在影像之上）
 * - 双 source 叠加：底图层在下，注记层在上
 * - 子域 t0~t7 轮询以突破浏览器单域名 6 连接限制
 * - attribution 必须显示（天地图许可要求）
 *
 * @throws 当 TIANDITU_KEY 未配置时抛错（由调用方预防）
 */
export function createTiandituSatelliteStyle(): StyleSpecification {
  if (!TIANDITU_KEY) {
    throw new Error('TIANDITU_KEY 未配置，请在 .env 中设置 VITE_TIANDITU_KEY');
  }
  return {
    version: 8,
    sources: {
      'tianditu-img': {
        type: 'raster',
        tiles: [buildTiandituTileUrl('img_w', 0), buildTiandituTileUrl('img_w', 1)],
        tileSize: 256,
        attribution: TIANDITU_ATTRIBUTION,
      },
      'tianditu-cia': {
        type: 'raster',
        tiles: [buildTiandituTileUrl('cia_w', 0), buildTiandituTileUrl('cia_w', 1)],
        tileSize: 256,
      },
    },
    layers: [
      {
        id: 'tianditu-img-raster',
        type: 'raster',
        source: 'tianditu-img',
      },
      {
        id: 'tianditu-cia-raster',
        type: 'raster',
        source: 'tianditu-cia',
      },
    ],
  };
}

/**
 * 天地图地形图 style：ter_w 底图 + cta_w 注记双图层。
 *
 * - ter_w：地形渲染图（DEM 着色，呈现山脉/河谷）
 * - cta_w：地形注记（地名/等高线标签）
 * - 双 source 叠加：底图层在下，注记层在上
 * - 子域 t0~t7 轮询以突破浏览器单域名 6 连接限制
 * - attribution 必须显示（天地图许可要求）
 *
 * @throws 当 TIANDITU_KEY 未配置时抛错（由调用方预防）
 */
export function createTiandituTerrainStyle(): StyleSpecification {
  if (!TIANDITU_KEY) {
    throw new Error('TIANDITU_KEY 未配置，请在 .env 中设置 VITE_TIANDITU_KEY');
  }
  return {
    version: 8,
    sources: {
      'tianditu-ter': {
        type: 'raster',
        tiles: [buildTiandituTileUrl('ter_w', 0), buildTiandituTileUrl('ter_w', 1)],
        tileSize: 256,
        attribution: TIANDITU_ATTRIBUTION,
      },
      'tianditu-cta': {
        type: 'raster',
        tiles: [buildTiandituTileUrl('cta_w', 0), buildTiandituTileUrl('cta_w', 1)],
        tileSize: 256,
      },
    },
    layers: [
      {
        id: 'tianditu-ter-raster',
        type: 'raster',
        source: 'tianditu-ter',
      },
      {
        id: 'tianditu-cta-raster',
        type: 'raster',
        source: 'tianditu-cta',
      },
    ],
  };
}

/**
 * 天地图矢量图 style：vec_w 底图 + cva_w 注记双图层。
 *
 * - vec_w：矢量底图（道路/行政区/水系）
 * - cva_w：矢量注记（中文地名/道路名标签）
 * - 双 source 叠加：底图层在下，注记层在上
 * - 子域 t0~t7 轮询
 * - attribution 必须显示
 *
 * @throws 当 TIANDITU_KEY 未配置时抛错（由调用方预防）
 */
export function createTiandituVectorStyle(): StyleSpecification {
  if (!TIANDITU_KEY) {
    throw new Error('TIANDITU_KEY 未配置，请在 .env 中设置 VITE_TIANDITU_KEY');
  }
  return {
    version: 8,
    sources: {
      'tianditu-vec': {
        type: 'raster',
        tiles: [buildTiandituTileUrl('vec_w', 0), buildTiandituTileUrl('vec_w', 1)],
        tileSize: 256,
        attribution: TIANDITU_ATTRIBUTION,
      },
      'tianditu-cva': {
        type: 'raster',
        tiles: [buildTiandituTileUrl('cva_w', 0), buildTiandituTileUrl('cva_w', 1)],
        tileSize: 256,
      },
    },
    layers: [
      {
        id: 'tianditu-vec-raster',
        type: 'raster',
        source: 'tianditu-vec',
      },
      {
        id: 'tianditu-cva-raster',
        type: 'raster',
        source: 'tianditu-cva',
      },
    ],
  };
}

/**
 * PMTiles style：本地 vector source + background 层。
 *
 * - source URL 使用 `pmtiles://` 协议前缀，由 Protocol 管理
 * - 不添加 vector 图层（避免 source-layer 不匹配导致渲染失败）
 * - 仅保留 background 层，确保有底色
 *
 * @param url PMTiles 文件 URL（如 `/tiles/demo.pmtiles`）
 */
export function createPmtilesLineMapStyle(url: string): StyleSpecification {
  return {
    version: 8,
    sources: {
      offline: {
        type: 'vector',
        url: `pmtiles://${url}`,
      },
    },
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
}
