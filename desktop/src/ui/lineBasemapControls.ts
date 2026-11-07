/** DOM controls for the current line basemap mode. */
import type { LineMapData } from '../gim/lineMapData.js';
import type { LineBasemapMode } from '../config/features.js';
import { isTiandituKeyAvailable } from '../config/tianditu.js';

export function isTiandituMode(mode: LineBasemapMode): boolean {
  return mode === 'tianditu-satellite' || mode === 'tianditu-terrain' || mode === 'tianditu-vector';
}

/** 底图切换按钮配置 */
const BASEMAP_SWITCHER_OPTIONS: { mode: LineBasemapMode; label: string; title: string }[] = [
  { mode: 'osm-online',        label: 'OSM',  title: 'OpenStreetMap 在线底图' },
  { mode: 'tianditu-satellite', label: '卫星', title: '天地图卫星影像（高分辨率遥感）' },
  { mode: 'tianditu-terrain',  label: '地形', title: '天地图地形图（侧视效果，可观察悬链线弧垂）' },
  { mode: 'tianditu-vector',   label: '矢量', title: '天地图矢量图（道路/地名）' },
];



export function renderBasemapControls(layerPanel: HTMLElement, mapData: LineMapData, currentMode: LineBasemapMode, onSwitch: (mode: LineBasemapMode, container: HTMLElement, data: LineMapData) => void): void {
  // 已存在则移除（重入时刷新）
  const existing = layerPanel.querySelector('.basemap-switcher-section');
  if (existing) existing.remove();

  const section = document.createElement('div');
  section.className = 'basemap-switcher-section';
  section.style.cssText = `
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid #cbd5e1;
  `;

  const title = document.createElement('div');
  title.textContent = '底图';
  title.style.cssText = `
    font-weight: 600;
    margin-bottom: 4px;
    color: #334155;
  `;
  section.appendChild(title);

  const btnGroup = document.createElement('div');
  btnGroup.style.cssText = `
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  `;

  const hasTiandituKey = isTiandituKeyAvailable();
  const container = layerPanel.parentElement || document.getElementById('viewport') as HTMLElement;

  for (const opt of BASEMAP_SWITCHER_OPTIONS) {
    const btn = document.createElement('button');
    btn.textContent = opt.label;
    btn.title = opt.title;
    btn.style.cssText = `
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid transparent;
      background: #f1f5f9;
      color: #475569;
      cursor: pointer;
      font-size: 11px;
      transition: background 0.15s;
    `;
    if (currentMode === opt.mode) {
      btn.style.background = '#0d84fc';
      btn.style.color = '#fff';
      btn.style.borderColor = '#0d84fc';
    }
    // 天地图 key 未配置时禁用对应按钮
    if (!hasTiandituKey && isTiandituMode(opt.mode)) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'not-allowed';
      btn.title = '未配置天地图 API Key，请在“更多 → 设置”中填写';
    }
    btn.addEventListener('mouseenter', () => {
      if (!btn.disabled && currentMode !== opt.mode) {
        btn.style.background = '#e2e8f0';
      }
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.disabled && currentMode !== opt.mode) {
        btn.style.background = '#f1f5f9';
        btn.style.color = '#475569';
      }
    });
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      if (currentMode === opt.mode) return; // 已是当前模式
      onSwitch(opt.mode, container, mapData);
    });
    btnGroup.appendChild(btn);
  }

  section.appendChild(btnGroup);
  layerPanel.appendChild(section);
}
