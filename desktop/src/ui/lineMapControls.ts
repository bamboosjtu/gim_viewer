/** DOM controls owned by one line-map instance. */
/** 图层开关状态（仅内存，不入库） */
export interface LayerState {
  conductor: boolean;
  groundwire: boolean;
  opgw: boolean;
  unknownWire: boolean;
  tower: boolean;
  cross: boolean;
  label: boolean;
}

/** 图层配置（供 UI + legend 共用） */
export const LAYER_ITEMS: { key: keyof LayerState; label: string; color: string }[] = [
  { key: 'conductor', label: '导线 CONDUCTOR', color: '#3b82f6' },
  { key: 'groundwire', label: '地线 GROUNDWIRE', color: '#6b7280' },
  { key: 'opgw', label: 'OPGW', color: '#10b981' },
  { key: 'unknownWire', label: '未知导线', color: '#9ca3af' },
  { key: 'tower', label: '塔位', color: '#3b82f6' },
  { key: 'cross', label: '跨越点', color: '#f59e0b' },
  { key: 'label', label: '标签', color: '#334155' },
];

export function mountLineMapControls(container: HTMLElement, overlayMode: boolean) {
  // ---- DOM：canvas + tooltip + fit 按钮 + 图层面板 ----
  const canvas = document.createElement('canvas');
  canvas.className = 'line-map-canvas';
  // M4-A2：overlay 模式下 Canvas 不接收鼠标事件（MapLibre 管理 pan/zoom）
  if (overlayMode) {
    canvas.classList.add('line-map-overlay');
  }
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  // tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'line-map-tip';
  container.appendChild(tooltip);

  // fit 按钮（左上角，避免与右上角 loading 重叠）
  const fitBtn = document.createElement('button');
  fitBtn.textContent = '全景';
  fitBtn.title = '回到全景（双击画布亦可）';
  fitBtn.className = 'line-map-fit';
  container.appendChild(fitBtn);

  // 图层面板（左上角，fit 按钮下方）
  const layerPanel = document.createElement('div');
  layerPanel.className = 'line-map-layers';
  container.appendChild(layerPanel);

  const layerTitle = document.createElement('div');
  layerTitle.textContent = '图层';
  layerTitle.className = 'line-map-layer-title';
  layerPanel.appendChild(layerTitle);

  const layerCheckboxes: HTMLInputElement[] = [];
  for (const item of LAYER_ITEMS) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.style.accentColor = item.color;
    const span = document.createElement('span');
    span.textContent = item.label;
    label.appendChild(cb);
    label.appendChild(span);
    layerPanel.appendChild(label);
    layerCheckboxes.push(cb);
  }

  return { canvas, ctx, tooltip, fitBtn, layerPanel, layerCheckboxes };
}
