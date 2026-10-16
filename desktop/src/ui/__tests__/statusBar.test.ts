import { expect, it } from 'vitest';
import { pushBusy, popBusy, resetStatusRight, setIfcStatus } from '../shell/statusBar.js';
it('progress updates are idempotent and independent tasks finish without a stuck loading state', () => {
  document.body.innerHTML = '<span id="status-text"></span><span id="status-dot"></span><span id="status-devices"></span>';
  resetStatusRight();
  for (let i=0;i<100;i++) pushBusy(`IFC ${i}`, 'ifc');
  pushBusy('DEV','dev'); popBusy('就绪','ifc');
  expect(document.getElementById('status-text')!.textContent).toBe('DEV');
  popBusy('就绪','dev');
  expect(document.getElementById('status-dot')!.classList.contains('loading')).toBe(false);
  setIfcStatus('IFC 2/3');
  expect(document.getElementById('status-ifc')!.textContent).toBe('IFC 2/3');
  resetStatusRight(); expect(document.getElementById('status-ifc')!.hidden).toBe(true);
});
