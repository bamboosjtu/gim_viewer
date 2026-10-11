/**
 * Fragments 缓存灰度开关与版本键单测（acc-plan P0-3）。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  isFragmentsCacheEnabled,
  fragmentsCacheKey,
  FRAGMENTS_CACHE_DEBUG_KEY,
  FRAGMENTS_CACHE_KEY_VERSION,
  isIfcPreviewEnabled, IFC_PREVIEW_DEBUG_KEY,
  isIfcPreviewDeferredFineEnabled, IFC_PREVIEW_DEFERRED_FINE_KEY,
} from '../features.js';

it('IFC preview is opt-in and independent of the Fragments cache default',()=>{
  localStorage.removeItem(IFC_PREVIEW_DEBUG_KEY);localStorage.removeItem(FRAGMENTS_CACHE_DEBUG_KEY);
  localStorage.removeItem(IFC_PREVIEW_DEFERRED_FINE_KEY);
  expect(isIfcPreviewEnabled()).toBe(false);
  expect(isIfcPreviewDeferredFineEnabled()).toBe(false);
  localStorage.setItem(IFC_PREVIEW_DEBUG_KEY,'1');
  expect(isIfcPreviewEnabled()).toBe(true);expect(isFragmentsCacheEnabled()).toBe(false);
  localStorage.setItem(IFC_PREVIEW_DEFERRED_FINE_KEY,'1');
  expect(isIfcPreviewDeferredFineEnabled()).toBe(true);
  localStorage.removeItem(IFC_PREVIEW_DEBUG_KEY);
});

describe('isFragmentsCacheEnabled（灰度开关）', () => {
  beforeEach(() => localStorage.removeItem(FRAGMENTS_CACHE_DEBUG_KEY));
  afterEach(() => localStorage.removeItem(FRAGMENTS_CACHE_DEBUG_KEY));

  it('默认关闭', () => {
    expect(isFragmentsCacheEnabled()).toBe(false);
  });

  it("localStorage 设 '1' 后开启", () => {
    localStorage.setItem(FRAGMENTS_CACHE_DEBUG_KEY, '1');
    expect(isFragmentsCacheEnabled()).toBe(true);
  });

  it("设其他值仍关闭", () => {
    localStorage.setItem(FRAGMENTS_CACHE_DEBUG_KEY, 'yes');
    expect(isFragmentsCacheEnabled()).toBe(false);
  });
});

describe('fragmentsCacheKey（缓存键绑定依赖包版本）', () => {
  it('组合 fragments 与 web-ifc 版本', () => {
    const key = fragmentsCacheKey('3.4.0', '0.0.77');
    expect(key).toContain('fragments@3.4.0');
    expect(key).toContain('web-ifc@0.0.77');
    expect(key.startsWith(FRAGMENTS_CACHE_KEY_VERSION)).toBe(true);
  });

  it('任一依赖版本变化生成新键', () => {
    const a = fragmentsCacheKey('3.4.0', '0.0.77');
    const b = fragmentsCacheKey('3.5.0', '0.0.77');
    const c = fragmentsCacheKey('3.4.0', '0.0.78');
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
