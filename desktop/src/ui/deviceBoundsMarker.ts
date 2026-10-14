import type { AppState } from '../app/state.js';

export function markDeviceBounds(row: HTMLElement, state: AppState, path: string): void {
  if (!state.deviceUnknownBounds.has(path) || row.querySelector('[data-device-bounds]')) return;
  const marker = document.createElement('span');
  marker.dataset.deviceBounds = 'unknown';
  marker.className = 'functional-badge';
  marker.textContent = '范围未确定';
  marker.title = '此设备的完整范围尚未确定，已自动加载可支持的几何；选择设备可查看细节。';
  row.appendChild(marker);
}
export function refreshDeviceBoundsMarkers(state: AppState): void {
  for (const row of document.querySelectorAll<HTMLElement>('.tree-row[data-node-path]')) {
    markDeviceBounds(row, state, row.dataset.nodePath!);
  }
}
