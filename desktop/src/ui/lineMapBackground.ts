/** Canvas background, grid, legend and scale drawing. */
import type { LineMapData } from '../gim/lineMapData.js';
import { niceStep, niceRound, formatLat, formatLng } from '../services/lineMapGeometry.js';
import type { LayerState } from './lineMapControls.js';

export const WIRE_COLORS: Record<string, string> = {
  CONDUCTOR: '#3b82f6',
  GROUNDWIRE: '#6b7280',
  OPGW: '#10b981',
};
export const WIRE_COLOR_UNKNOWN = '#9ca3af';
export const COLOR_BG = '#f8fafc';
export const COLOR_GRID = '#e2e8f0';
export const COLOR_GRID_MAJOR = '#cbd5e1';
export const COLOR_BORDER = '#94a3b8';
export const COLOR_TOWER_STRAIGHT = '#1d4ed8';
export const COLOR_TOWER_STRAIGHT_FILL = '#3b82f6';
export const COLOR_TOWER_TENSION = '#dc2626';
export const COLOR_TOWER_TENSION_FILL = '#ef4444';
export const COLOR_CROSS = '#f59e0b';
export const COLOR_LABEL = '#334155';
export const LEGEND_PAD = 10;
export const LEGEND_LINE_H = 18;
export const LEGEND_BOTTOM_MARGIN = 16;
export const COLOR_SCALE = '#475569';

export function paintEmptyHint(ctx: CanvasRenderingContext2D, cssW: number, cssH: number, text: string): void {
    ctx.fillStyle = '#64748b';
    ctx.font = '15px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cssW / 2, cssH / 2);
  }

export function paintBorder(ctx: CanvasRenderingContext2D, cssW: number, cssH: number): void {
    ctx.strokeStyle = COLOR_BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);
  }

export function paintGrid(ctx: CanvasRenderingContext2D, bbox: LineMapData['bbox'], cssW: number, cssH: number, geoToScreen: (lat: number, lng: number) => { x: number; y: number }): void {
    const latStep = niceStep(bbox.maxLat - bbox.minLat, 8);
    const lngStep = niceStep(bbox.maxLng - bbox.minLng, 8);
    ctx.lineWidth = 1;

    // 竖线（经度）
    const startLng = Math.ceil(bbox.minLng / lngStep) * lngStep;
    for (let lng = startLng; lng <= bbox.maxLng + 1e-9; lng += lngStep) {
      const top = geoToScreen(bbox.maxLat, lng);
      const bottom = geoToScreen(bbox.minLat, lng);
      ctx.strokeStyle = COLOR_GRID;
      ctx.beginPath();
      ctx.moveTo(top.x, 0);
      ctx.lineTo(bottom.x, cssH);
      ctx.stroke();
      // 经度标签
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(formatLng(lng), Math.min(Math.max(top.x + 2, 2), cssW - 50), 2);
    }

    // 横线（纬度）
    const startLat = Math.ceil(bbox.minLat / latStep) * latStep;
    for (let lat = startLat; lat <= bbox.maxLat + 1e-9; lat += latStep) {
      const left = geoToScreen(lat, bbox.minLng);
      const right = geoToScreen(lat, bbox.maxLng);
      ctx.strokeStyle = COLOR_GRID;
      ctx.beginPath();
      ctx.moveTo(0, left.y);
      ctx.lineTo(cssW, right.y);
      ctx.stroke();
      // 纬度标签
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(formatLat(lat), 2, Math.min(Math.max(left.y + 2, 2), cssH - 14));
    }
  }

export function paintLegend(ctx: CanvasRenderingContext2D, layerState: LayerState, cssH: number): void {
    // 导线图例项（与图层状态一致：关闭时半透明）
    const wireItems: [string, string, boolean][] = [
      ['导线 CONDUCTOR', WIRE_COLORS['CONDUCTOR'] || WIRE_COLOR_UNKNOWN, layerState.conductor],
      ['地线 GROUNDWIRE', WIRE_COLORS['GROUNDWIRE'] || WIRE_COLOR_UNKNOWN, layerState.groundwire],
      ['OPGW', WIRE_COLORS['OPGW'] || WIRE_COLOR_UNKNOWN, layerState.opgw],
      ['未知导线', WIRE_COLOR_UNKNOWN, layerState.unknownWire],
    ];
    const totalLines = wireItems.length + 3; // +直线塔 +耐张塔 +跨越点
    const x0 = LEGEND_PAD + 4;
    let y0 = cssH - LEGEND_PAD - LEGEND_BOTTOM_MARGIN - totalLines * LEGEND_LINE_H;

    // 背板（增加底部 padding 防裁切）
    const boxH = totalLines * LEGEND_LINE_H + LEGEND_PAD + LEGEND_BOTTOM_MARGIN;
    const boxW = 158;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeStyle = COLOR_GRID_MAJOR;
    ctx.lineWidth = 1;
    ctx.fillRect(LEGEND_PAD, y0 - 4, boxW, boxH);
    ctx.strokeRect(LEGEND_PAD, y0 - 4, boxW, boxH);

    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // 导线图例
    for (const [label, color, visible] of wireItems) {
      ctx.globalAlpha = visible ? 1 : 0.3;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0 + 6);
      ctx.lineTo(x0 + 22, y0 + 6);
      ctx.stroke();
      ctx.fillStyle = COLOR_LABEL;
      ctx.fillText(label, x0 + 28, y0 + 6);
      y0 += LEGEND_LINE_H;
    }
    ctx.globalAlpha = 1;
    // 塔位图例（圆形/菱形）
    ctx.globalAlpha = layerState.tower ? 1 : 0.3;
    ctx.fillStyle = COLOR_TOWER_STRAIGHT_FILL;
    ctx.strokeStyle = COLOR_TOWER_STRAIGHT;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x0 + 11, y0 + 6, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLOR_LABEL;
    ctx.fillText('直线塔（圆）', x0 + 28, y0 + 6);
    y0 += LEGEND_LINE_H;
    ctx.fillStyle = COLOR_TOWER_TENSION_FILL;
    ctx.strokeStyle = COLOR_TOWER_TENSION;
    ctx.beginPath();
    ctx.moveTo(x0 + 11, y0 + 2);
    ctx.lineTo(x0 + 15, y0 + 6);
    ctx.lineTo(x0 + 11, y0 + 10);
    ctx.lineTo(x0 + 7, y0 + 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLOR_LABEL;
    ctx.fillText('耐张塔（菱）', x0 + 28, y0 + 6);
    y0 += LEGEND_LINE_H;
    ctx.globalAlpha = 1;
    // 跨越点图例
    ctx.globalAlpha = layerState.cross ? 1 : 0.3;
    ctx.fillStyle = COLOR_CROSS;
    ctx.beginPath();
    ctx.moveTo(x0 + 11, y0 + 2);
    ctx.lineTo(x0 + 7, y0 + 10);
    ctx.lineTo(x0 + 15, y0 + 10);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = COLOR_LABEL;
    ctx.fillText('跨越点', x0 + 28, y0 + 6);
    ctx.globalAlpha = 1;
  }

export function paintScaleBar(ctx: CanvasRenderingContext2D, cssW: number, cssH: number, baseScale: number, zoom: number, centerLatRad: number): void {
    // Web Mercator：地面米/像素 = R·cos(φ) / pxPerMercYUnit（随中心纬度变化）
    // 替代原等距投影的 111km/° 常数，中高纬度比例尺不再失真
    const pxPerMerc = baseScale * zoom;
    const metersPerPx = ((6371000 * Math.cos(centerLatRad)) / pxPerMerc);
    const kmPerPx = metersPerPx / 1000;
    // 目标 80px 的 km 数，取整
    const targetKm = kmPerPx * 80;
    const niceKm = niceRound(targetKm);
    const barPx = (niceKm * 1000) / metersPerPx;
    if (!isFinite(barPx) || barPx < 20) return;

    const x = cssW - barPx - LEGEND_PAD - 8;
    const y = cssH - LEGEND_PAD - 8;
    ctx.strokeStyle = COLOR_SCALE;
    ctx.fillStyle = COLOR_SCALE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + barPx, y);
    ctx.moveTo(x, y - 3);
    ctx.lineTo(x, y + 3);
    ctx.moveTo(x + barPx, y - 3);
    ctx.lineTo(x + barPx, y + 3);
    ctx.stroke();
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(niceKm >= 1 ? `${niceKm} km` : `${Math.round(niceKm * 1000)} m`, x + barPx / 2, y - 4);
  }
