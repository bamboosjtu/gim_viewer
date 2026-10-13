import { afterEach, describe, expect, it } from 'vitest';
import { setupIfcPreviewModeControl } from '../ifcPreviewModeControl.js';
import { setProjectIdentity } from '../shell/projectBar.js';
import { isIfcPreviewEnabled, isIfcPreviewDeferredFineEnabled, isFragmentsCacheEnabled } from '../../config/features.js';

afterEach(() => { localStorage.clear(); document.body.innerHTML = ''; });
describe('visible substation Preview opt-in', () => {
  it('enables Preview and Deferred Fine together without changing Fragments policy', () => {
    document.body.innerHTML = '<button id="btn-ifc-quick-preview"></button>';
    setupIfcPreviewModeControl();
    const button = document.querySelector('button')!;
    expect(button.textContent).toBe('变电预览：关闭');
    button.click();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(isIfcPreviewEnabled()).toBe(true);
    expect(isIfcPreviewDeferredFineEnabled()).toBe(true);
    expect(isFragmentsCacheEnabled()).toBe(false);
    button.click();
    expect(isIfcPreviewEnabled()).toBe(false);
    expect(isIfcPreviewDeferredFineEnabled()).toBe(false);
  });
  it('reflects saved preferences and is hidden for powerline projects', () => {
    localStorage.setItem('gim-debug-ifc-preview', '1');
    localStorage.setItem('gim-debug-ifc-preview-deferred-fine', '1');
    document.body.innerHTML = '<button id="btn-ifc-quick-preview"></button>';
    setupIfcPreviewModeControl();
    expect(document.querySelector('button')!.textContent).toBe('变电预览：开启');
    setProjectIdentity('line', 'transmission_line');
    expect(document.querySelector('button')!.classList.contains('hidden')).toBe(true);
    setProjectIdentity(null, null);
    expect(document.querySelector('button')!.classList.contains('hidden')).toBe(false);
  });
});
