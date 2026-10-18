/**
 * 缓存管理 UI（M4-D2）
 *
 * 提供最小可用的缓存查看与清理能力：
 * - 显示数据库路径
 * - 列出所有缓存项目（name / type / version / size / updated_at）
 * - 每个项目可"复制诊断 JSON"和"删除缓存"
 *
 * 入口：左侧栏"缓存管理"按钮（btn-cache-manager）
 * 仅在 Tauri 模式下可用。
 */

import {
  listCachedProjects,
  deleteProjectCache,
  getProjectDiagnostic,
  getDbPath,
  validateGimCache,
  type CachedProjectSummary,
} from '@desktop/database.js';
import { summarizeDiagnostic } from '../shared/diagnosticSummary.js';
import { escapeHtml } from '../shared/html.js';
import { getDebugConfigSnapshot } from '../config/debug.js';
import type { AppState } from '../app/state.js';

let modalEl: HTMLElement | null = null;

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 格式化时间戳 */
function formatTime(ms: number): string {
  if (!ms) return '(未知)';
  const d = new Date(ms);
  return d.toLocaleString('zh-CN', { hour12: false });
}

/** 创建 modal DOM */
function createModal(): HTMLElement {
  const modal = document.createElement('div');
  modal.id = 'cache-manager-modal';
  modal.className = 'cache-modal';
  modal.innerHTML = `
    <div class="cache-dialog" role="dialog" aria-modal="true" aria-label="缓存管理">
      <div class="cache-head">
        <div>
          <h2>缓存管理</h2>
          <div class="cache-sub">本地 SQLite 缓存 · 删除后下次打开会重新解压</div>
        </div>
        <button id="cache-mgr-close" class="cache-close" aria-label="关闭">×</button>
      </div>
      <div class="cache-body">
        <div class="cache-path-card">
          <span class="cache-path-label">数据库</span>
          <span id="cache-mgr-dbpath" class="cache-path-value">加载中…</span>
        </div>
        <div class="cache-list-head">
          <span class="cache-list-title">缓存项目</span>
          <span id="cache-mgr-count" class="cache-count"></span>
        </div>
        <div id="cache-mgr-list" class="cache-list">
          <div class="cache-empty">加载中…</div>
        </div>
      </div>
      <div class="cache-foot">
        <button id="cache-mgr-refresh" class="cache-btn">刷新</button>
        <button id="cache-mgr-done" class="cache-btn primary">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

/** 创建项目卡片 DOM */
function createProjectRow(project: CachedProjectSummary): HTMLElement {
  const row = document.createElement('div');
  row.className = 'cache-card';

  const typeLabel = project.project_type === 'transmission_line' ? '线路'
    : project.project_type === 'substation' ? '变电'
    : '(未识别)';
  const versionLabel = project.parser_version ?? '未发布';
  const sizeLabel = formatSize(project.size);
  const timeLabel = formatTime(project.updated_at_ms);

  row.innerHTML = `
    <div class="cache-card-head">
      <span class="cache-name">${escapeHtml(project.name)}</span>
      <span class="cache-badge id">#${project.id}</span>
      <span class="cache-badge">${escapeHtml(typeLabel)}</span>
      <span class="cache-badge${project.parser_version ? ' ok' : ''}">${escapeHtml(versionLabel)}</span>
    </div>
    <div class="cache-meta">
      <div><b>大小</b>${sizeLabel}</div>
      <div><b>更新</b>${escapeHtml(timeLabel)}</div>
      <div><b>路径</b>${escapeHtml(project.path)}</div>
    </div>
    <div class="cache-mgr-status" data-project-id="${project.id}"></div>
    <div class="cache-actions">
      <button class="cache-btn primary cache-mgr-open" data-project-id="${project.id}">打开工程</button>
      <button class="cache-btn cache-mgr-validate" data-project-id="${project.id}" data-project-type="${escapeHtml(project.project_type ?? '')}">校验缓存</button>
      <button class="cache-btn cache-mgr-diag" data-project-id="${project.id}">复制诊断 JSON</button>
      <button class="cache-btn cache-mgr-diag-summary" data-project-id="${project.id}">复制摘要</button>
      <button class="cache-btn danger cache-mgr-delete" data-project-id="${project.id}" data-project-name="${escapeHtml(project.name)}">删除缓存</button>
    </div>
  `;

  return row;
}

/** 加载并渲染项目列表 */
async function loadProjects(listContainer: HTMLElement): Promise<void> {
  const countEl = listContainer.closest('.cache-body')?.querySelector<HTMLElement>('#cache-mgr-count') ?? null;
  listContainer.innerHTML = '<div class="cache-empty">加载中…</div>';
  try {
    const projects = await listCachedProjects();
    if (countEl) countEl.textContent = `${projects.length} 个项目`;
    if (projects.length === 0) {
      listContainer.innerHTML = '<div class="cache-empty">暂无缓存项目。打开 .gim 文件后会自动创建缓存。</div>';
      return;
    }
    listContainer.innerHTML = '';
    for (const p of projects) {
      listContainer.appendChild(createProjectRow(p));
    }
  } catch (err) {
    if (countEl) countEl.textContent = '';
    listContainer.innerHTML = `<div class="cache-empty">加载失败: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

/** 绑定事件（事件委托） */
function bindEvents(modal: HTMLElement, onRefresh: () => void, state?: AppState): void {
  // 关闭按钮
  const closeBtn = modal.querySelector('#cache-mgr-close') as HTMLButtonElement;
  const doneBtn = modal.querySelector('#cache-mgr-done') as HTMLButtonElement;
  const refreshBtn = modal.querySelector('#cache-mgr-refresh') as HTMLButtonElement;
  const backdrop = modal;

  const closeModal = () => {
    if (modalEl === modal) {
      document.body.removeChild(modal);
      modalEl = null;
    }
  };

  closeBtn.onclick = closeModal;
  doneBtn.onclick = closeModal;
  refreshBtn.onclick = onRefresh;
  backdrop.onclick = (e) => {
    if (e.target === backdrop) closeModal();
  };

  // 事件委托：复制诊断 / 复制摘要 / 删除
  const listEl = modal.querySelector('#cache-mgr-list') as HTMLElement;
  listEl.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;

    if (target.classList.contains('cache-mgr-open')) {
      if (!state) return;
      const projectId = Number(target.dataset.projectId);
      target.textContent = '打开中...';
      if (modalEl) { document.body.removeChild(modalEl); modalEl = null; }
      try {
        const { openGimProjectFromId } = await import('../services/openGimService.js');
        await openGimProjectFromId(state, () => {}, projectId);
      } catch (err) {
        console.error('[缓存管理] 打开工程失败:', err);
        target.textContent = '打开失败';
        setTimeout(() => { target.textContent = '打开工程'; }, 2000);
      }
      return;
    }

    if (target.classList.contains('cache-mgr-validate')) {
      const projectId = Number(target.dataset.projectId);
      const domain = target.dataset.projectType === 'transmission_line' ? 'transmission_line' : 'substation';
      const statusEl = modal.querySelector<HTMLElement>(`.cache-mgr-status[data-project-id="${projectId}"]`);
      target.textContent = '校验中...';
      try {
        const result = await validateGimCache(projectId, domain);
        if (statusEl) {
          statusEl.textContent = result.valid
            ? `缓存有效 · IFC ${result.cached_ifc_count}/${result.ifc_entry_count}`
            : `缓存需重建 · ${result.cache_miss_reason ?? '未知原因'}`;
          statusEl.style.color = result.valid ? '#4caf50' : '#ff9800';
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = `校验失败: ${err instanceof Error ? err.message : String(err)}`;
      }
      target.textContent = '校验缓存';
      return;
    }

    // 复制诊断 JSON
    if (target.classList.contains('cache-mgr-diag')) {
      const projectId = Number(target.dataset.projectId);
      target.textContent = '加载中...';
      try {
        const diagnostic = await getProjectDiagnostic(projectId);
        const debug = getDebugConfigSnapshot();
        const payload = JSON.stringify({ projectId, diagnostic, debug }, null, 2);
        await navigator.clipboard.writeText(payload);
        target.textContent = '已复制 ✓';
        console.log(`[缓存管理] 项目 ${projectId} 诊断已复制到剪贴板:\n`, summarizeDiagnostic({ diagnostic }));
      } catch (err) {
        target.textContent = '复制失败';
        console.error('[缓存管理] 复制诊断失败:', err);
      }
      setTimeout(() => { target.textContent = '复制诊断 JSON'; }, 2000);
      return;
    }

    // 复制摘要
    if (target.classList.contains('cache-mgr-diag-summary')) {
      const projectId = Number(target.dataset.projectId);
      target.textContent = '加载中...';
      try {
        const diagnostic = await getProjectDiagnostic(projectId);
        const summary = summarizeDiagnostic({ diagnostic });
        await navigator.clipboard.writeText(summary);
        target.textContent = '已复制 ✓';
        console.log(`[缓存管理] 项目 ${projectId} 诊断摘要:\n${summary}`);
      } catch (err) {
        target.textContent = '复制失败';
        console.error('[缓存管理] 复制摘要失败:', err);
      }
      setTimeout(() => { target.textContent = '复制摘要'; }, 2000);
      return;
    }

    // 删除缓存
    if (target.classList.contains('cache-mgr-delete')) {
      const projectId = Number(target.dataset.projectId);
      const projectName = target.dataset.projectName ?? '';
      if (!confirm(`确认删除项目 "${projectName}" (ID: ${projectId}) 的全部缓存？\n\n此操作将：\n- 删除数据库中的所有索引记录\n- 尝试删除磁盘缓存文件\n\n注意：如果删除的是当前正在查看的工程，当前视图不会立即关闭；\n重新打开该 GIM 时会重新解压并重建缓存。\n\n不可恢复。`)) {
        return;
      }
      target.textContent = '删除中...';
      target.setAttribute('disabled', 'true');
      try {
        const result = await deleteProjectCache(projectId);
        console.log(`[缓存管理] 删除项目 ${projectId} 结果:`, result);
        target.textContent = '已删除 ✓';
        // 刷新列表
        setTimeout(() => onRefresh(), 500);
      } catch (err) {
        target.textContent = '删除失败';
        console.error('[缓存管理] 删除缓存失败:', err);
        target.removeAttribute('disabled');
      }
      return;
    }
  });
}

/**
 * 打开缓存管理 modal。
 *
 * 仅在 Tauri 模式下可用。如果已打开则不重复创建。
 */
export async function openCacheManager(state?: AppState): Promise<void> {
  if (modalEl) return; // 已打开

  modalEl = createModal();
  const dbPathEl = modalEl.querySelector('#cache-mgr-dbpath') as HTMLElement;
  const listEl = modalEl.querySelector('#cache-mgr-list') as HTMLElement;

  // 加载数据库路径
  try {
    const dbPath = await getDbPath();
    dbPathEl.textContent = dbPath;
  } catch (err) {
    dbPathEl.textContent = `获取失败: ${err instanceof Error ? err.message : String(err)}`;
    dbPathEl.style.color = '#f44336';
  }

  // 加载项目列表
  const refresh = () => loadProjects(listEl);
  await refresh();

  // 绑定事件
  bindEvents(modalEl, refresh, state);
}
