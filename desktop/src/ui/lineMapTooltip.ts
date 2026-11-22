import type { TowerMarker } from '../gim/lineMapData.js';
import { towerLabel } from '../features/powerline/presentation/lineMapGeometry.js';
import { escapeHtml } from '../shared/html.js';

export function createLineMapTooltip(element: HTMLElement) {
  return {
    show(tower: TowerMarker, x: number, y: number, width: number, height: number): void {
      const lines = [`<b>${escapeHtml(towerLabel(tower))}</b>`];
      if (tower.towerNumber) lines.push(`杆塔编号: ${escapeHtml(tower.towerNumber)}`);
      lines.push(
        `塔型: ${escapeHtml(tower.towerType || '—')}`,
        `呼高: ${escapeHtml(tower.towerHeight || '—')}`,
        `转角: ${escapeHtml(tower.turnAngle || '—')}`,
        `纬度: ${tower.lat.toFixed(6)}`,
        `经度: ${tower.lng.toFixed(6)}`,
      );
      if (tower.elev != null) lines.push(`高程: ${tower.elev} m`);
      lines.push(
        `数据质量: ${tower.dataQuality}`,
        `FAM: ${tower.famSource ? '命中' : '未命中缓存'}`,
        `DEV: ${tower.devSource ? '命中' : '未命中缓存'}`,
      );
      element.innerHTML = lines.join('<br>');
      element.style.display = 'block';
      const w = element.offsetWidth,
        h = element.offsetHeight;
      element.style.left = `${x + 14 + w > width - 4 ? x - w - 14 : x + 14}px`;
      element.style.top = `${y + 14 + h > height - 4 ? y - h - 14 : y + 14}px`;
    },
    hide(): void {
      element.style.display = 'none';
    },
  };
}
