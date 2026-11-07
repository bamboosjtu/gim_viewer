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
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.zIndex = '2';
  canvas.style.cursor = 'grab';
  // M4-A2：overlay 模式下 Canvas 不接收鼠标事件（MapLibre 管理 pan/zoom）
  if (overlayMode) {
    canvas.style.pointerEvents = 'none';
  }
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  // tooltip
  const tooltip = document.createElement('div');
  tooltip.style.position = 'absolute';
  tooltip.style.pointerEvents = 'none';
  tooltip.style.zIndex = '20';
  tooltip.style.maxWidth = '280px';
  tooltip.style.padding = '8px 10px';
  tooltip.style.borderRadius = '6px';
  tooltip.style.background = 'rgba(15,23,42,0.92)';
  tooltip.style.color = '#e2e8f0';
  tooltip.style.fontSize = '12px';
  tooltip.style.lineHeight = '1.5';
  tooltip.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
  tooltip.style.display = 'none';
  tooltip.style.whiteSpace = 'nowrap';
  container.appendChild(tooltip);

  // fit 按钮（左上角，避免与右上角 loading 重叠）
  const fitBtn = document.createElement('button');
  fitBtn.textContent = '全景';
  fitBtn.title = '回到全景（双击画布亦可）';
  fitBtn.style.position = 'absolute';
  fitBtn.style.left = '10px';
  fitBtn.style.top = '10px';
  fitBtn.style.zIndex = '20';
  fitBtn.style.padding = '4px 10px';
  fitBtn.style.borderRadius = '4px';
  fitBtn.style.border = '1px solid #cbd5e1';
  fitBtn.style.background = 'rgba(255,255,255,0.92)';
  fitBtn.style.cursor = 'pointer';
  fitBtn.style.fontSize = '12px';
  container.appendChild(fitBtn);

  // 图层面板（左上角，fit 按钮下方）
  const layerPanel = document.createElement('div');
  layerPanel.style.position = 'absolute';
  layerPanel.style.left = '10px';
  layerPanel.style.top = '42px';
  layerPanel.style.zIndex = '20';
  layerPanel.style.padding = '8px 10px';
  layerPanel.style.borderRadius = '6px';
  layerPanel.style.background = 'rgba(255,255,255,0.92)';
  layerPanel.style.border = '1px solid #cbd5e1';
  layerPanel.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
  layerPanel.style.fontSize = '12px';
  layerPanel.style.maxHeight = 'calc(100% - 60px)';
  layerPanel.style.overflowY = 'auto';
  container.appendChild(layerPanel);

  const layerTitle = document.createElement('div');
  layerTitle.textContent = '图层';
  layerTitle.style.fontWeight = '600';
  layerTitle.style.marginBottom = '4px';
  layerTitle.style.color = '#334155';
  layerPanel.appendChild(layerTitle);

  const layerCheckboxes: HTMLInputElement[] = [];
  for (const item of LAYER_ITEMS) {
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '4px';
    label.style.cursor = 'pointer';
    label.style.padding = '1px 0';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.style.accentColor = item.color;
    cb.style.margin = '0';
    cb.style.cursor = 'pointer';
    const span = document.createElement('span');
    span.textContent = item.label;
    span.style.color = '#334155';
    label.appendChild(cb);
    label.appendChild(span);
    layerPanel.appendChild(label);
    layerCheckboxes.push(cb);
  }

  return { canvas, ctx, tooltip, fitBtn, layerPanel, layerCheckboxes };
}
