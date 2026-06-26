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
export const propsDrawerBody = document.getElementById('props-drawer-body') as HTMLElement;
export const propsDrawer = document.getElementById('props-drawer') as HTMLElement;
export const btnToggleProps = document.getElementById('btn-toggle-props') as HTMLButtonElement;
export const btnCloseProps = document.getElementById('btn-close-props') as HTMLButtonElement;

// 模态框
export const ifcModal = document.getElementById('ifc-modal') as HTMLElement;
export const modalIfcList = document.getElementById('modal-ifc-list') as HTMLElement;
export const modalInfo = document.getElementById('modal-info') as HTMLElement;
export const modalClose = document.getElementById('modal-close') as HTMLButtonElement;
export const modalSelectAll = document.getElementById('modal-select-all') as HTMLButtonElement;
export const modalDeselectAll = document.getElementById('modal-deselect-all') as HTMLButtonElement;
export const modalLoad = document.getElementById('modal-load') as HTMLButtonElement;
