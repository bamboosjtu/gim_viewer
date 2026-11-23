const paths = {
  home: 'm2 11 10-8 10 8 M5 10v11h5v-7h4v7h5V10',
  orbit: 'M20 9a8 8 0 1 0 0 6 M20 4v5h-5 M10 10l4-2 4 2-4 2z M10 10v4l4 2 4-2v-4m-4 2v4',
  pan: 'M6 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-8a1.5 1.5 0 0 1 3 0v8-6a1.5 1.5 0 0 1 3 0v8c0 5-2 8-6 8h-1c-2 0-3-1-5-4l-3-4c-1-2 0-3 2-2l3 3',
  zoomIn: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0z M15 15l6 6 M10 6v8m-4-4h8',
  zoomOut: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0z M15 15l6 6 M6 10h8',
  view: 'm3 7 9-5 9 5v10l-9 5-9-5z M3 7l9 5 9-5m-9 5v10m-4-7 2 1',
  pointer: 'M5 3l14 9-7 1-3 7z',
  locate:
    'M12 2v4m0 12v4M2 12h4m12 0h4 M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0z M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
  clear: 'm3 14 10-11 8 7-10 11H9z M8 9l8 7m-6 5h11',
  hide: 'm3 3 18 18 M10 5.5A12 12 0 0 1 22 12a18 18 0 0 1-3 3.5M6 7C4 8.3 2.7 10 2 12c3 5 9 9 15 5M10 10a3 3 0 0 0 4 4',
  isolate: 'M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7S2 12 2 12z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  restore: 'M3 4v6h6 M4 10a8 8 0 1 1 0 6',
  layers: 'm2 8 10-5 10 5-10 5z M3 13l9 5 9-5 M3 18l9 5 9-5',
  horizontal: 'm3 8 9-5 9 5-9 5z M3 13l9 5 9-5 M3 9v7l9 5 9-5V9',
  vertical: 'm3 7 9-5 9 5v10l-9 5-9-5z M12 2v20m4-18v15',
  box: 'm3 7 9-5 9 5v10l-9 5-9-5z M3 7l9 5 9-5m-9 5v10',
  distance: 'M3 8v8m18-8v8M4 12h16m-13-3-3 3 3 3m10-6 3 3-3 3',
} as const;
export type ToolIcon = keyof typeof paths;
export function toolGlyph(button: HTMLElement, icon: ToolIcon, label: string, help = label) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[icon]);
  svg.append(path);
  const caption = document.createElement('span');
  caption.className = 'viewer-command-caption';
  const captions: Partial<Record<ToolIcon, string>> = {
    pointer: '选择',
    locate: '自动定位',
    clear: '清除选择',
    layers: '模型过滤',
    horizontal: '水平剖切',
    vertical: '垂直剖切',
    distance: '距离',
    home: '复位',
    view: '标准视角',
  };
  caption.textContent = captions[icon] ?? label;
  button.replaceChildren(svg, caption);
  button.dataset.icon = icon;
  button.classList.add('viewer-glyph');
  button.setAttribute('aria-label', label);
  button.dataset.tip = help;
  button.removeAttribute('title');
}
export function installTooltips(bar: HTMLElement, id = 'viewer-tool-tip') {
  const tip = document.createElement('div');
  tip.id = id;
  tip.className = 'viewer-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  let owner: HTMLElement | null = null,
    timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  function hide() {
    clearTimeout(timer);
    owner?.removeAttribute('aria-describedby');
    owner = null;
    tip.hidden = true;
  }
  function show(event: Event) {
    const next = (event.target as HTMLElement)?.closest<HTMLElement>('[data-tip]');
    if (!next) return;
    hide();
    owner = next;
    const open = () => {
      if (!next.isConnected) return hide();
      tip.textContent = next.dataset.tip ?? '';
      tip.hidden = false;
      next.setAttribute('aria-describedby', tip.id);
      const r = next.getBoundingClientRect();
      tip.style.left =
        Math.max(
          4,
          Math.min(innerWidth - tip.offsetWidth - 4, r.left + r.width / 2 - tip.offsetWidth / 2),
        ) + 'px';
      tip.style.top = Math.min(innerHeight - tip.offsetHeight - 4, r.bottom + 6) + 'px';
    };
    if (event.type === 'focusin') open();
    else timer = setTimeout(open, 280);
  }
  for (const name of ['pointerover', 'focusin'])
    bar.addEventListener(name, show, { signal: abort.signal });
  for (const name of ['pointerout', 'focusout', 'click'])
    bar.addEventListener(name, hide, { signal: abort.signal });
  return () => {
    hide();
    abort.abort();
    tip.remove();
  };
}
