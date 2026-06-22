/**
 * 顶部项目栏（M0 设计系统：design/component_brief.md §4）。
 *
 * 职责：工程身份展示（匿名工程名 + 类型徽标）。
 * 打开/附加/关闭/缓存等命令按钮保留原 ID，由 bootstrap 绑定。
 */

/** 工程类型的显示名与徽标文案 */
export type ProjectKind = 'substation' | 'transmission_line' | null;

let currentKind: ProjectKind = null;

/** 更新工程身份（名称 + 类型徽标）；传 null 恢复未打开状态 */
export function setProjectIdentity(name: string | null, kind: ProjectKind): void {
  currentKind = kind;
  const titleEl = document.getElementById('project-title');
  const badgeEl = document.getElementById('project-type-badge');
  if (titleEl) titleEl.textContent = name || '未打开工程';

  if (!badgeEl) return;
  if (!kind) {
    badgeEl.classList.add('hidden');
    badgeEl.textContent = '';
    return;
  }
  badgeEl.textContent = kind === 'substation' ? '变电工程' : '线路工程';
  badgeEl.classList.remove('hidden');
}

/** 更新导航器标题（变电=模型导航，线路=线路导航） */
export function setNavigatorTitle(title: string): void {
  const el = document.getElementById('navigator-title');
  if (el) el.textContent = title;
}

/** 按工程类型刷新导航器标题 */
export function refreshNavigatorTitle(): void {
  setNavigatorTitle(currentKind === 'transmission_line' ? '线路导航' : '模型导航');
}
