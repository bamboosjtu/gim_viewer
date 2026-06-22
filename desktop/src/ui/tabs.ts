/** 初始化左侧标签页切换 */
export function setupTabs(): void {
  document.querySelectorAll<HTMLElement>('#workspace-rail .rail-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      activateTab(btn.dataset.tab!);
    });
  });
}

/** 激活指定 tab（rail 高亮 + 面板切换）。 */
function activateTab(tabId: string): void {
  document.querySelectorAll<HTMLElement>('#workspace-rail .rail-item').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tabId),
  );
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(tabId)?.classList.add('active');
  // 让主视口叠加层感知“图纸”工作区的选择，而不让 tab 层直接依赖 SLD 模块。
  document.dispatchEvent(new CustomEvent('gim:tab-activated', { detail: { tabId } }));
}

/**
 * 隐藏指定的 tab（同时隐藏 tab-btn 与对应的 tab-panel）。
 *
 * 用于工程类型差异化：
 * - 线路工程调用 hideTabs(['tab-models', 'tab-filedev', 'tab-sld'])，仅保留模型
 * - 变电工程默认显示全部 4 个 tab
 *
 * 若被隐藏的 tab 当前处于 active 状态，会自动切到首个可见 tab
 * （避免点击隐藏 tab 后无可见面板）。
 */
export function hideTabs(tabIds: string[]): void {
  const hidden = new Set(tabIds);
  document.querySelectorAll<HTMLElement>('#workspace-rail .rail-item').forEach((btn) => {
    const tabId = btn.dataset.tab;
    if (!tabId) return;
    btn.classList.toggle('hidden', hidden.has(tabId));
  });

  // 若当前 active rail 项被隐藏，切到首个可见项
  const activeBtn = document.querySelector<HTMLElement>('#workspace-rail .rail-item.active');
  if (activeBtn && hidden.has(activeBtn.dataset.tab || '')) {
    activeBtn.classList.remove('active');
    const activePanel = document.querySelector('.tab-panel.active');
    activePanel?.classList.remove('active');

    const firstVisible = document.querySelector<HTMLElement>('#workspace-rail .rail-item:not(.hidden)');
    if (firstVisible) {
      firstVisible.classList.add('active');
      const tabId = firstVisible.dataset.tab!;
      document.getElementById(tabId)?.classList.add('active');
      document.dispatchEvent(new CustomEvent('gim:tab-activated', { detail: { tabId } }));
    }
  }
}

/**
 * 恢复所有 tab 可见性（项目切换清理时调用）。
 *
 * - 清除 hideTabs 设置的 inline display 样式
 * - 不改变当前 active 状态（由 setupTabs / 新工程入口重新决定）
 */
export function showAllTabs(): void {
  document.querySelectorAll<HTMLElement>('#workspace-rail .rail-item').forEach((btn) => {
    btn.classList.remove('hidden');
  });
}
