import type { ViewerNavigationCommands } from '../shared/viewerNavigationCommands.js';
import type { ViewerCommandPort } from '../shared/viewerCommands.js';
import { toolGlyph } from './viewerToolIcons.js';

/** A nonmodal preparation view. Only the card and its own commands receive pointer events. */
export function mountPatrolPreparation(
  hud: HTMLElement,
  port: ViewerNavigationCommands,
  tools?: ViewerCommandPort,
) {
  const root = document.createElement('div');
  root.className = 'patrol-preparation';
  root.hidden = true;
  root.innerHTML = `<header class="patrol-prep-bar"><span class="patrol-prep-icon" aria-hidden="true"></span><strong>巡视模式</strong><span class="patrol-prep-badge">准备中</span><span class="patrol-prep-spacer"></span><button type="button" data-select>选择</button><button type="button" data-distance>测距</button><button type="button" data-help aria-expanded="false">操作说明</button><button type="button" data-exit>退出巡视 <kbd>Esc</kbd></button></header>
 <section class="patrol-prep-card" aria-label="正在准备巡视场景"><div class="patrol-prep-title"><i aria-hidden="true"></i><div><h2>正在准备巡视场景</h2><small>完成后可进入第一人称巡视</small></div></div><ol><li data-read><strong>读取工程</strong><span></span></li><li data-build><strong>准备巡视场景</strong><span></span><div class="patrol-prep-count" hidden>已处理对象 <output></output><progress></progress></div></li><li><strong>巡视就绪</strong><span>待完成</span></li></ol><footer>准备期间可查看模型<button type="button" data-cancel>取消准备</button></footer><p data-instructions hidden>点击模型查看对象属性。选择测距后，依次点击两个可见表面。</p></section>`;
  const el = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const glyph = el('.patrol-prep-icon');
  toolGlyph(glyph, 'patrol', '巡视');
  glyph.classList.remove('viewer-glyph');
  delete glyph.dataset.icon;
  delete glyph.dataset.tip;

  el('[data-exit]').onclick = el('[data-cancel]').onclick = () => port.execute?.('exit');
  el('[data-select]').onclick = () => tools?.dispatch({ kind: 'tool', tool: 'select' });
  el('[data-distance]').onclick = () => tools?.dispatch({ kind: 'tool', tool: 'distance' });
  const help = el('button[data-help]'),
    instructions = el('[data-instructions]');
  help.onclick = () => {
    instructions.hidden = !instructions.hidden;
    help.setAttribute('aria-expanded', String(!instructions.hidden));
  };
  const read = el('[data-read]'),
    build = el('[data-build]'),
    count = el('.patrol-prep-count'),
    output = el('output'),
    progress = el<HTMLProgressElement>('progress');
  hud.append(root);
  return (visible: boolean) => {
    root.hidden = !visible;
    if (!visible) {
      instructions.hidden = true;
      help.setAttribute('aria-expanded', 'false');
      return;
    }
    const ready = port.browseReady;
    read.dataset.state = ready ? 'done' : 'active';
    build.dataset.state = ready ? 'active' : 'waiting';
    read.querySelector('span')!.textContent = ready ? '已完成' : '进行中';
    build.querySelector('span')!.textContent = ready ? '进行中' : '待完成';
    count.hidden = !ready;
    if (!port.preparationProgress) {
      output.textContent = '整理来源…';
      progress.removeAttribute('value');
    }
    if (port.preparationProgress) {
      const { done, total } = port.preparationProgress;
      output.textContent = done.toLocaleString() + ' / ' + total.toLocaleString();
      progress.max = total || 1;
      progress.value = done;
    }
  };
}
