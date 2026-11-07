/**
 * 通用侧栏搜索框。
 *
 * 纯 UI 组件：接收扁平化搜索条目（key/title/subtitle），输入即过滤，
 * 点击结果回调 onPick(key)。由调用方构建索引并解释 key。
 *
 * 行为：
 * - 大小写不敏感子串匹配 title / subtitle / key 或预编译全文，最多展示 MAX_HITS 条
 * - Escape 清空并收起；输入为空隐藏下拉
 * - 失焦延迟收起（保证结果行 click 先触发）
 */

import { escapeHtml } from '../shared/html.js';

import type { SearchItem } from '../shared/searchTypes.js';
export type { SearchItem } from '../shared/searchTypes.js';


/** 下拉最多展示的条数（超出时显示提示） */
const MAX_HITS = 50;
let searchInstanceId = 0;

export function renderSearchBox(
  host: HTMLElement,
  items: SearchItem[],
  onPick: (key: string) => void,
): { destroy(): void } {
  let blurTimer: number | undefined;
  let destroyed = false;
  const index = items.map(item => ({ item, title: item.title.toLowerCase(), subtitle: item.subtitle?.toLowerCase() ?? '',
    text: item.searchText ?? [item.title, item.subtitle ?? '', item.key].join('\n').toLowerCase() }));
  const wrap = document.createElement('div');
  wrap.className = 'search-box-wrap';
  wrap.style.cssText = 'position:relative;padding:6px 8px 2px;';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '搜索名称 / 编号...';
  input.setAttribute('aria-label', '搜索名称或编号');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.style.cssText = [
    'width:100%', 'box-sizing:border-box', 'padding:5px 8px',
    'border:1px solid #334155', 'border-radius:4px',
    'background:#0f172a', 'color:#e2e8f0', 'font-size:12px', 'outline:none',
  ].join(';');

  const list = document.createElement('div');
  list.id = `search-results-${++searchInstanceId}`;
  list.setAttribute('role', 'listbox');
  input.setAttribute('aria-controls', list.id);
  list.style.cssText = [
    'display:none', 'position:absolute', 'left:8px', 'right:8px', 'top:100%',
    'margin-top:-2px', 'max-height:260px', 'overflow-y:auto',
    'background:#1e293b', 'border:1px solid #334155', 'border-radius:4px',
    'z-index:60', 'box-shadow:0 4px 12px rgba(0,0,0,0.4)',
  ].join(';');

  function hideList(): void {
    list.style.display = 'none';
    list.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
  }

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      hideList();
      return;
    }
    const ranked: SearchItem[][] = Array.from({ length: 5 }, () => []);
    let total = 0;
    for (const { item: e, title, subtitle, text } of index) {
      if (text.includes(q)) {
        total++;
        // Keep a named whole or its category ahead of matches found only in
        // system context/internal sources. Otherwise the result cap can hide
        // the very equipment being searched among hundreds of its neighbours.
        const rank = title === q ? 0 : title.startsWith(q) ? 1 : subtitle.startsWith(q) ? 2 : title.includes(q) ? 3 : 4;
        if (ranked[rank].length < MAX_HITS) ranked[rank].push(e);
      }
    }
    const hits = ranked.flat().slice(0, MAX_HITS);
    list.innerHTML = '';
    if (total === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:8px 10px;color:#64748b;font-size:12px;';
      empty.textContent = '无匹配结果';
      list.appendChild(empty);
    } else {
      for (const e of hits) {
        const rowEl = document.createElement('div');
        rowEl.setAttribute('role', 'option');
        rowEl.tabIndex = -1;
        rowEl.setAttribute('aria-selected', 'false');
        rowEl.style.cssText = 'padding:6px 10px;cursor:pointer;font-size:12px;color:#e2e8f0;line-height:1.5;';
        rowEl.innerHTML = `<div>${escapeHtml(e.title)}</div>`
          + (e.subtitle ? `<div class="search-result-subtitle">${escapeHtml(e.subtitle)}</div>` : '');
        rowEl.addEventListener('mouseenter', () => {
          rowEl.style.background = '#334155';
        });
        rowEl.addEventListener('mouseleave', () => {
          rowEl.style.background = 'transparent';
        });
        rowEl.addEventListener('click', () => {
          if (destroyed) return;
          hideList();
          onPick(e.key);
        });
        list.appendChild(rowEl);
      }
      if (total > MAX_HITS) {
        const more = document.createElement('div');
        more.style.cssText = 'padding:6px 10px;color:#64748b;font-size:11px;border-top:1px solid #334155;';
        more.textContent = `共 ${total} 条匹配，仅显示前 ${MAX_HITS} 条，请细化关键字`;
        list.appendChild(more);
      }
    }
    list.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const options = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
      if (options.length === 0) return;
      const current = options.findIndex((option) => option.getAttribute('aria-selected') === 'true');
      const next = ev.key === 'ArrowDown'
        ? (current + 1) % options.length
        : (current <= 0 ? options.length - 1 : current - 1);
      options.forEach((option, index) => {
        const active = index === next;
        option.setAttribute('aria-selected', String(active));
        option.style.background = active ? '#334155' : 'transparent';
      });
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (ev.key === 'Enter') {
      const active = list.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
      if (active) {
        active.click();
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
    }
    if (ev.key === 'Escape') {
      input.value = '';
      hideList();
      input.blur();
    }
    ev.stopPropagation(); // 避免触发全局快捷键（如 Ctrl+Shift+C/D）
  });

  // 失焦收起（延迟以允许结果行 click 先触发）
  input.addEventListener('blur', () => {
    if (destroyed) return;
    if (blurTimer !== undefined) window.clearTimeout(blurTimer);
    blurTimer = window.setTimeout(() => { blurTimer = undefined; hideList(); }, 150);
  });
  input.addEventListener('focus', () => {
    if (list.childElementCount > 0) list.style.display = 'block';
  });

  wrap.appendChild(input);
  wrap.appendChild(list);
  host.prepend(wrap);
  return { destroy() {
    if (destroyed) return;
    destroyed = true;
    if (blurTimer !== undefined) window.clearTimeout(blurTimer);
    wrap.remove();
  } };
}
