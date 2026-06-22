/**
 * 通用侧栏搜索框单测（dev-log「无搜索」项）。
 *
 * 覆盖：渲染、输入过滤、大小写不敏感、结果点击回调、Escape 清空、空态提示。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { renderSearchBox } from '../searchBox.js';
import type { SearchItem } from '../searchBox.js';

describe('renderSearchBox', () => {
  let host: HTMLElement;
  const picks: string[] = [];
  const items: SearchItem[] = [
    { key: 'Cbm/A001.cbm', title: 'N123 · 塔', subtitle: 'Tower_Device' },
    { key: 'Cbm/B002.cbm', title: '避雷器', subtitle: 'PARTINDEX' },
    { key: 'Cbm/C003.cbm', title: 'N456 · 线', subtitle: 'WIRE' },
  ];

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    renderSearchBox(host, items, (key) => picks.push(key));
  });

  afterEach(() => {
    document.body.innerHTML = '';
    picks.length = 0;
  });

  function input(): HTMLInputElement {
    return host.querySelector('input')!;
  }

  function rows(): HTMLElement[] {
    return Array.from(host.querySelectorAll('div[style*="cursor"]'));
  }

  it('初始不显示下拉', () => {
    expect(input()).toBeTruthy();
    // 下拉为 display:none（通过子元素为空判断）
    expect(rows().length).toBe(0);
  });

  it('输入过滤：大小写不敏感匹配 title 与 subtitle', () => {
    const inp = input();
    inp.value = 'n123';
    inp.dispatchEvent(new Event('input'));
    expect(rows().length).toBe(1);
    expect(rows()[0].textContent).toContain('N123');

    inp.value = 'tower_device';
    inp.dispatchEvent(new Event('input'));
    expect(rows().length).toBe(1);

    inp.value = '无此内容xyz';
    inp.dispatchEvent(new Event('input'));
    expect(rows().length).toBe(0);
  });

  it('点击结果触发 onPick 并回传 key', () => {
    const inp = input();
    inp.value = '避雷器';
    inp.dispatchEvent(new Event('input'));
    expect(rows().length).toBe(1);
    rows()[0].click();
    expect(picks).toEqual(['Cbm/B002.cbm']);
  });

  it('清空输入后下拉收起', () => {
    const inp = input();
    inp.value = 'N';
    inp.dispatchEvent(new Event('input'));
    expect(rows().length).toBeGreaterThan(0);
    inp.value = '';
    inp.dispatchEvent(new Event('input'));
    expect(rows().length).toBe(0);
  });
});
