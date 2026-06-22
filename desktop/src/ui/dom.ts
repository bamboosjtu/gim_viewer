/** 统一获取 DOM 元素，集中导出 */
export const container = document.getElementById('viewport') as HTMLElement;
export const loadingEl = document.getElementById('loading') as HTMLElement;
export const emptyTipEl = document.getElementById('empty-tip') as HTMLElement;
export const modelListEl = document.getElementById('model-list') as HTMLElement;
export const fileInput = document.getElementById('file-input') as HTMLInputElement;
export const gimFileInput = document.getElementById('gim-file-input') as HTMLInputElement;
export const btnLoadLocal = document.getElementById('btn-load-local') as HTMLButtonElement;
export const btnLoadGim = document.getElementById('btn-load-gim') as HTMLButtonElement;
export const btnClear = document.getElementById('btn-clear') as HTMLButtonElement;
export const btnCacheManager = document.getElementById('btn-cache-manager') as HTMLButtonElement;
export const cbmTreePanel = document.getElementById('cbm-tree-panel') as HTMLElement;
export const fileDevPanel = document.getElementById('file-dev-panel') as HTMLElement;
export const sldPanel = document.getElementById('sld-panel') as HTMLElement;
/** 主视口内的单线图叠加层；不替换 Three.js/MapLibre 容器。 */
export const sldOverlay = document.getElementById('sld-overlay') as HTMLElement;
export const sldOverlayContent = document.getElementById('sld-overlay-content') as HTMLElement;
export const sldOverlayClose = document.getElementById('sld-overlay-close') as HTMLButtonElement;
export const propsDrawerBody = document.getElementById('props-drawer-body') as HTMLElement;
export const propsDrawer = document.getElementById('props-drawer') as HTMLElement;
export const btnToggleProps = document.getElementById('btn-toggle-props') as HTMLButtonElement;
export const btnCloseProps = document.getElementById('btn-close-props') as HTMLButtonElement;
export const btnExportProps = document.getElementById('btn-export-props') as HTMLButtonElement;

// 模态框
