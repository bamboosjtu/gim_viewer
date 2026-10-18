/**
 * IFC 细节设置面板。
 *
 * “更多 → IFC 细节设置…”原先只是点击一个隐藏按钮，没有任何可见反馈。
 * 这里改成说明型弹窗：展示当前模式与 L0/L1/L2 的触发条件、内容和代价，
 * 并提供“自动（近景 30m）/ 远景”切换，切换后立即广播，已加载区域重算。
 */
import {
  IFC_DETAIL_MODE_KEY,
  IFC_NEAR_DETAIL_RADIUS_M,
  IFC_NEAR_SMALL_HOLE_MM,
  isIfcNearDetailEnabled,
} from '../config/features.js';

let modal: HTMLElement | null = null;

function modeLabel(): string {
  return isIfcNearDetailEnabled()
    ? `自动 · 相机 ${IFC_NEAR_DETAIL_RADIUS_M} m 内补近景细节`
    : '远景 · 省略近景开洞与螺栓';
}

function renderMode(): void {
  const el = modal?.querySelector('#ifc-detail-mode');
  if (el) el.textContent = modeLabel();
  const auto = modal?.querySelector<HTMLButtonElement>('#ifc-detail-auto');
  const far = modal?.querySelector<HTMLButtonElement>('#ifc-detail-far');
  const near = isIfcNearDetailEnabled();
  auto?.classList.toggle('primary', near);
  far?.classList.toggle('primary', !near);
  auto?.setAttribute('aria-pressed', String(near));
  far?.setAttribute('aria-pressed', String(!near));
}

function setMode(near: boolean): void {
  try {
    localStorage.setItem(IFC_DETAIL_MODE_KEY, near ? 'auto' : 'far');
  } catch {
    /* 偏好写入失败不影响本次会话 */
  }
  window.dispatchEvent(new Event('gim-ifc-detail-mode'));
  renderMode();
}

/** 打开 IFC 细节设置；已打开时不重复创建。 */
export function openIfcDetailPanel(): void {
  if (modal) {
    renderMode();
    return;
  }
  modal = document.createElement('div');
  modal.id = 'ifc-detail-modal';
  modal.className = 'cache-modal';
  modal.innerHTML = `
    <div class="cache-dialog" role="dialog" aria-modal="true" aria-label="IFC 细节设置">
      <div class="cache-head">
        <div>
          <h2>IFC 细节设置</h2>
          <div class="cache-sub">控制 IFC 的表示层级；自动模式只精化相机附近的构件</div>
        </div>
        <button id="ifc-detail-close" class="cache-close" aria-label="关闭">×</button>
      </div>
      <div class="cache-body">
        <div class="cache-path-card">
          <span class="cache-path-label">当前模式</span>
          <span id="ifc-detail-mode" class="cache-path-value"></span>
        </div>
        <div class="cache-list-head">
          <span class="cache-list-title">表示层级</span>
          <span class="cache-count">L0 / L1 / L2</span>
        </div>
        <div class="lod-table">
          <div class="lod-row"><b>L0 基础表示</b><span>全站默认表示；参数棱柱 / 简化几何，保证远景观感与首屏速度。</span></div>
          <div class="lod-row"><b>L1 近景细节</b><span>相机 ${IFC_NEAR_DETAIL_RADIUS_M} m 范围内补充中型开洞与螺栓（小于 ${IFC_NEAR_SMALL_HOLE_MM} mm 的孔洞关系省略）。</span></div>
          <div class="lod-row"><b>L2 精确几何</b><span>选中构件按需精化，使用原 IFC 完整几何；不参与全站自动加载。</span></div>
        </div>
        <div class="props-note">远景模式跳过 L1：全站只保留 L0，选中构件仍可按需 L2。修改立即生效，下次打开沿用。</div>
      </div>
      <div class="cache-foot">
        <button id="ifc-detail-auto" class="cache-btn">自动（近景 ${IFC_NEAR_DETAIL_RADIUS_M} m）</button>
        <button id="ifc-detail-far" class="cache-btn">远景（省略近景细节）</button>
        <button id="ifc-detail-done" class="cache-btn primary">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = (): void => {
    modal?.remove();
    modal = null;
  };
  modal.querySelector('#ifc-detail-close')?.addEventListener('click', close);
  modal.querySelector('#ifc-detail-done')?.addEventListener('click', close);
  modal.querySelector('#ifc-detail-auto')?.addEventListener('click', () => setMode(true));
  modal.querySelector('#ifc-detail-far')?.addEventListener('click', () => setMode(false));
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });
  renderMode();
}
