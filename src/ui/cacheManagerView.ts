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
  type CachedProjectSummary,
} from '../desktop/database.js';
import { summarizeDiagnostic } from '../services/diagnosticSummaryService.js';
import { getDebugConfigSnapshot } from '../config/debug.js';

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
  modal.style.cssText = `
    position: fixed; inset: 0; z-index: 1000;
    background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
  `;
  modal.innerHTML = `
    <div style="
      background: #1e1e1e; color: #eee; border-radius: 8px;
      width: 800px; max-width: 90vw; max-height: 80vh;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    ">
      <div style="
        padding: 16px 20px; border-bottom: 1px solid #333;
        display: flex; justify-content: space-between; align-items: center;
      ">
        <h2 style="margin: 0; font-size: 16px; font-weight: 600;">缓存管理</h2>
        <button id="cache-mgr-close" style="
          background: none; border: none; color: #aaa; font-size: 20px;
          cursor: pointer; padding: 0 4px;
        ">×</button>
      </div>
      <div id="cache-mgr-body" style="
        flex: 1; overflow-y: auto; padding: 16px 20px;
      ">
        <div style="margin-bottom: 16px;">
          <div style="font-size: 12px; color: #aaa; margin-bottom: 4px;">数据库路径</div>
          <div id="cache-mgr-dbpath" style="
            font-size: 12px; font-family: monospace; color: #0d84fc;
            word-break: break-all; background: #2a2a2a; padding: 8px 10px; border-radius: 4px;
          ">加载中...</div>
        </div>
        <div style="font-size: 12px; color: #aaa; margin-bottom: 8px;">缓存项目</div>
        <div id="cache-mgr-list">加载中...</div>
      </div>
      <div style="
        padding: 12px 20px; border-top: 1px solid #333;
        display: flex; justify-content: flex-end; gap: 8px;
      ">
        <button id="cache-mgr-refresh" class="btn btn-secondary btn-small" style="background: #444; color: #fff; border: none; border-radius: 4px; padding: 6px 14px; cursor: pointer; font-size: 12px;">刷新</button>
        <button id="cache-mgr-done" class="btn btn-small" style="background: #0d84fc; color: #fff; border: none; border-radius: 4px; padding: 6px 14px; cursor: pointer; font-size: 12px;">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

/** 创建项目行 DOM */
function createProjectRow(project: CachedProjectSummary): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = `
    background: #2a2a2a; border-radius: 6px; padding: 12px 14px;
    margin-bottom: 8px; font-size: 13px;
  `;

  const typeLabel = project.project_type ?? '(未识别)';
  const versionLabel = project.parser_version ?? '(未设置)';
  const sizeLabel = formatSize(project.size);
  const timeLabel = formatTime(project.updated_at_ms);

  row.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
      <div style="font-weight: 600; font-size: 14px;">${escapeHtml(project.name)}</div>
      <div style="font-size: 11px; color: #888;">ID: ${project.id}</div>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 4px 12px; font-size: 12px; color: #bbb;">
      <div>类型: <span style="color: #0d84fc;">${escapeHtml(typeLabel)}</span></div>
      <div>版本: <span style="color: ${versionLabel.includes('v5') ? '#4caf50' : '#ff9800'};">${escapeHtml(versionLabel)}</span></div>
      <div>大小: ${sizeLabel}</div>
      <div>更新: ${timeLabel}</div>
    </div>
    <div style="font-size: 11px; color: #666; margin-top: 4px; font-family: monospace; word-break: break-all;">${escapeHtml(project.path)}</div>
    <div style="display: flex; gap: 6px; margin-top: 8px;">
      <button class="cache-mgr-diag" data-project-id="${project.id}" style="
        background: #444; color: #fff; border: none; border-radius: 4px;
        padding: 4px 10px; cursor: pointer; font-size: 11px;
      ">复制诊断 JSON</button>
      <button class="cache-mgr-diag-summary" data-project-id="${project.id}" style="
        background: #444; color: #fff; border: none; border-radius: 4px;
        padding: 4px 10px; cursor: pointer; font-size: 11px;
      ">复制摘要</button>
      <button class="cache-mgr-delete" data-project-id="${project.id}" data-project-name="${escapeHtml(project.name)}" style="
        background: #c0392b; color: #fff; border: none; border-radius: 4px;
        padding: 4px 10px; cursor: pointer; font-size: 11px;
      ">删除缓存</button>
    </div>
  `;

  return row;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 加载并渲染项目列表 */
async function loadProjects(listContainer: HTMLElement): Promise<void> {
  listContainer.innerHTML = '<div style="color: #aaa; padding: 8px;">加载中...</div>';
  try {
    const projects = await listCachedProjects();
    if (projects.length === 0) {
      listContainer.innerHTML = '<div style="color: #aaa; padding: 8px;">暂无缓存项目。打开 .gim 文件后会自动创建缓存。</div>';
      return;
    }
    listContainer.innerHTML = '';
    for (const p of projects) {
      listContainer.appendChild(createProjectRow(p));
    }
  } catch (err) {
    listContainer.innerHTML = `<div style="color: #f44336; padding: 8px;">加载失败: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

/** 绑定事件（事件委托） */
function bindEvents(modal: HTMLElement, onRefresh: () => void): void {
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
export async function openCacheManager(): Promise<void> {
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
  bindEvents(modalEl, refresh);
}
