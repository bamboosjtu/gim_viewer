/** 初始化左侧标签页切换 */
export function setupTabs(): void {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const tabId = (btn as HTMLElement).dataset.tab!;
      document.getElementById(tabId)?.classList.add('active');
    });
  });
}

/**
 * 隐藏指定的 tab（同时隐藏 tab-btn 与对应的 tab-panel）。
 *
 * 用于工程类型差异化：
 * - 线路工程调用 hideTabs(['tab-models', 'tab-filedev', 'tab-sld'])，仅保留层级树
 * - 变电工程默认显示全部 4 个 tab
 *
 * 若被隐藏的 tab 当前处于 active 状态，会自动切到首个可见 tab
 * （避免点击隐藏 tab 后无可见面板）。
 */
export function hideTabs(tabIds: string[]): void {
  const hidden = new Set(tabIds);
  document.querySelectorAll<HTMLElement>('.tab-btn').forEach((btn) => {
    const tabId = btn.dataset.tab;
    if (!tabId) return;
    if (hidden.has(tabId)) {
      btn.style.display = 'none';
    } else {
      btn.style.display = '';
    }
  });

  // 若当前 active tab 被隐藏，切到首个可见 tab
  const activeBtn = document.querySelector<HTMLElement>('.tab-btn.active');
  if (activeBtn && hidden.has(activeBtn.dataset.tab || '')) {
    activeBtn.classList.remove('active');
    const activePanel = document.querySelector('.tab-panel.active');
    activePanel?.classList.remove('active');

    const firstVisible = document.querySelector<HTMLElement>('.tab-btn:not([style*="display: none"]):not([style*="display:none"])');
    if (firstVisible) {
      firstVisible.classList.add('active');
      const tabId = firstVisible.dataset.tab!;
      document.getElementById(tabId)?.classList.add('active');
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
  document.querySelectorAll<HTMLElement>('.tab-btn').forEach((btn) => {
    btn.style.display = '';
  });
}
