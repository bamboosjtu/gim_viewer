import type { ReadonlyToolState, ToolSnapshot, ViewerCommand } from '../shared/viewerCommands.js';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function mountDistanceResults(
  viewport: HTMLElement,
  send: (command: ViewerCommand) => void,
) {
  const result = element('aside', 'viewer-distance-results');
  result.setAttribute('aria-label', '测量结果');
  result.hidden = true;
  const drawer = document.getElementById('props-drawer'),
    title = drawer?.querySelector<HTMLElement>('#props-drawer-header h3');
  const originalTitle = title?.textContent ?? '对象属性';
  let active = false;
  function place() {
    const docked = !!drawer && !drawer.classList.contains('collapsed') && active;
    drawer?.classList.toggle('measuring', docked);
    if (title) title.textContent = docked ? '测量结果' : originalTitle;
    const parent = docked ? drawer : viewport;
    if (result.parentElement !== parent) parent.append(result);
    result.classList.toggle('docked', docked);
  }
  const observer = new MutationObserver(place);
  if (drawer) observer.observe(drawer, { attributes: true, attributeFilter: ['class'] });
  place();
  function action(label: string, cmd: ViewerCommand) {
    const button = element('button', 'measure-action', label);
    button.type = 'button';
    button.onclick = () => send(cmd);
    return button;
  }
  function number(value: number) {
    return Number(value.toFixed(3)).toFixed(3);
  }
  function render(s: ReadonlyToolState<ToolSnapshot>) {
    active = s.tool === 'distance';
    result.hidden = !active;
    place();

    result.replaceChildren();
    if (!active) return;
    const header = element('header', 'measure-heading');
    header.append(element('strong', 'measure-title', '测量结果'));
    if (s.distances.length) header.append(action('清除测量', { kind: 'clearDistances' }));
    result.append(header);
    if (!s.distances.length) {
      result.append(
        element(
          'p',
          'measure-empty',
          s.first ? '起点已记录，请选择终点。' : '在模型表面依次选择起点和终点。',
        ),
      );
      return;
    }
    for (const r of [...s.distances].reverse()) {
      const card = element('section', 'measure-card'),
        value = element('div', 'measure-value');
      value.append(element('b', '', number(r.metres)), element('span', '', 'm'));
      const head = element('div', 'measure-card-head');
      head.append(value, action('删除此条', { kind: 'removeDistance', id: r.id }));
      value.setAttribute('aria-label', '近似距离 ' + number(r.metres) + ' 米');
      const table = element('table', 'measure-coordinates');
      table.setAttribute('aria-label', '工程坐标，单位米');
      const tr = table.createTHead().insertRow();
      for (const t of ['坐标 (m)', '起点', '终点']) tr.append(element('th', '', t));
      const body = table.createTBody();
      for (const [i, axis] of ['X', 'Y', 'Z'].entries()) {
        const row = body.insertRow();
        row.append(
          element('th', '', axis),
          element('td', '', number(r.a.xyz[i])),
          element('td', '', number(r.b.xyz[i])),
        );
      }
      card.append(head, table);
      result.append(card);
    }
  }
  return {
    render,
    dispose() {
      observer.disconnect();
      active = false;
      place();
      result.remove();
    },
  };
}
