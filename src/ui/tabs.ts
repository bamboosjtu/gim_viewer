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
