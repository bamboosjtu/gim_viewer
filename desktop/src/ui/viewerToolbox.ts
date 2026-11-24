import { mountDistanceResults } from './distanceResults.js';
import { toolGlyph, installTooltips, type ToolIcon } from './viewerToolIcons.js';
import type { AppState } from '../app/state.js';
import type {
  ViewerCommand,
  ViewerCommandPort,
  ReadonlyToolState,
  Tool,
  Section,
  Vec3,
} from '../shared/viewerCommands.js';

export function mountViewerToolbox(
  state: AppState,
  bar: HTMLElement,
  viewport: HTMLElement,
  selectionButtons: HTMLElement[],
) {
  const port: ViewerCommandPort = state.viewerCommands;
  const nav = document.createElement('div'),
    panel = document.createElement('div');
  nav.className = 'viewer-tool-tabs';
  panel.className = 'viewer-tool-panel';
  bar.append(nav, panel);
  const send = (c: ViewerCommand) => port.dispatch(c);
  const results = mountDistanceResults(viewport, send);
  const dock = document.createElement('div');
  dock.className = 'viewer-camera-dock';
  dock.setAttribute('role', 'toolbar');
  dock.setAttribute('aria-label', '相机导航');
  viewport.append(dock);
  function button(host: HTMLElement, text: string, action: () => void, disabled = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.disabled = disabled;
    b.onclick = action;
    host.append(b);
    return b;
  }
  function check(host: HTMLElement, text: string, checked: boolean, change: (v: boolean) => void) {
    const l = document.createElement('label'),
      cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.onchange = () => change(cb.checked);
    l.append(cb, text);
    host.append(l);
    return cb;
  }
  function select(
    host: HTMLElement,
    label: string,
    rows: readonly { id: string; label: string }[],
    value: string,
    change: (id: string) => void,
  ) {
    const l = document.createElement('label'),
      el = document.createElement('select');
    l.append(label, el);
    host.append(l);
    for (const row of rows) el.add(new Option(row.label, row.id));
    el.value = value;
    el.onchange = () => change(el.value);
  }
  function field(label: string, value: number, change: (n: number) => void) {
    const l = document.createElement('label'),
      input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = String(Number(value.toFixed(4)));
    input.onchange = () => {
      if (Number.isFinite(input.valueAsNumber)) change(input.valueAsNumber);
    };
    l.append(label, input);
    panel.append(l);
    return input;
  }
  const tools: readonly [Tool, string][] = [
    ['select', '选择'],
    ['display', '显示'],
    ['section', '剖切'],
    ['distance', '测量'],
    ['view', '视角'],
  ];
  const sections = new Map<Tool, HTMLElement>();
  const tabs = tools.map(([tool, label]) => {
    const group = document.createElement('div'),
      actions = document.createElement('div');
    group.className = 'viewer-ribbon-group';
    actions.className = 'viewer-ribbon-actions';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    const heading = button(group, label, () => send({ kind: 'tool', tool }));
    heading.className = 'viewer-group-heading';
    heading.setAttribute('aria-label', label);
    group.dataset.group = tool;
    sections.set(tool, actions);
    group.append(actions);
    nav.append(group);
    return heading;
  });
  function action(group: Tool, icon: ToolIcon, name: string, cmd: ViewerCommand, tip = name) {
    const b = button(sections.get(group)!, name, () => send(cmd));
    toolGlyph(b, icon, name, tip);
    return b;
  }
  const pointer = action('select', 'pointer', '选择对象', { kind: 'tool', tool: 'select' });
  sections.get('select')!.append(...selectionButtons);
  const hide = action('display', 'hide', '隐藏对象', { kind: 'hide' });
  const only = action('display', 'isolate', '仅看选中', { kind: 'isolate' });
  const restore = action(
    'display',
    'restore',
    '恢复显示',
    { kind: 'restore' },
    '恢复显示，保留模型图层开关',
  );
  const filter = action(
    'display',
    'layers',
    '模型与 IFC 类型过滤',
    { kind: 'tool', tool: 'display' },
    '模型、IFC 类型与楼层过滤',
  );
  const shapes = (
    [
      ['horizontal', '水平面'],
      ['vertical', '垂直面'],
      ['box', '剖切盒'],
    ] as const
  ).map(([shape, label]) =>
    action(
      'section',
      shape,
      label,
      { kind: 'startSection', shape },
      label + ' · 拖动手柄或输入米数',
    ),
  );
  const distance = action(
    'distance',
    'distance',
    '两点距离',
    { kind: 'tool', tool: 'distance' },
    '测量两个可见表面点之间的空间距离',
  );
  const home = action(
    'view',
    'home',
    '复位视角',
    { kind: 'camera', action: 'home' },
    '恢复全景视角',
  );
  const views = action(
    'view',
    'view',
    '标准视角',
    { kind: 'tool', tool: 'view' },
    '切换俯视、正视、右视或轴测',
  );
  const cameraButtons = (
    [
      ['home', '复位'],
      ['orbit', '旋转'],
      ['pan', '平移'],
      ['zoomIn', '放大'],
      ['zoomOut', '缩小'],
    ] as const
  ).map(([act, label]) => {
    const b = button(dock, label, () => send({ kind: 'camera', action: act }));
    toolGlyph(b, act, label);
    return b;
  });
  const removeDockTips = installTooltips(dock, 'camera-tool-tip');
  const removeTips = installTooltips(bar);
  const feedback = document.createElement('div');
  feedback.setAttribute('role', 'status');
  feedback.className = 'tool-feedback';
  bar.append(feedback);
  let sectionKind: Section['kind'] | undefined;
  let updateSectionFields: ((value: ReadonlyToolState<Section>) => void) | undefined;
  function editSection(s: ReadonlyToolState<Section>) {
    const update = (patch: Partial<Section>) => {
      const current = port.snapshot.section;
      if (current?.kind === s.kind)
        send({
          kind: 'section',
          value: { ...current, min: [...current.min], max: [...current.max], ...patch },
        });
    };
    const enabled = check(panel, '启用剖切', s.enabled, (enabled) => update({ enabled }));
    const sync: Array<(value: ReadonlyToolState<Section>) => void> = [
      (value) => {
        enabled.checked = value.enabled;
      },
    ];
    const number = (
      label: string,
      get: (value: ReadonlyToolState<Section>) => number,
      change: (n: number) => void,
    ) => {
      const input = field(label, get(s), change);
      sync.push((value) => {
        const text = String(Number(get(value).toFixed(4)));
        if (input.value !== text) input.value = text;
      });
    };
    if (s.kind === 'box') {
      for (const side of ['min', 'max'] as const)
        for (const [index, axis] of ['X', 'Y', 'Z'].entries()) {
          number(
            axis + (side === 'min' ? ' 下限' : ' 上限') + ' (m)',
            (value) => value[side][index],
            (v) => {
              const current = port.snapshot.section;
              if (current?.kind !== 'box') return;
              const values: Vec3 = [...current[side]];
              values[index] = v;
              update({ [side]: values });
            },
          );
        }
    } else {
      number(
        s.kind === 'horizontal' ? '工程高度 (m)' : '偏移 (m)',
        (value) => value.offset,
        (offset) => update({ offset }),
      );
      if (s.kind === 'vertical')
        number(
          '方位角 (°)',
          (value) => value.azimuth,
          (azimuth) => update({ azimuth }),
        );
      const flipped = check(panel, '翻转方向', s.flipped, (flipped) => update({ flipped }));
      sync.push((value) => {
        flipped.checked = value.flipped;
      });
    }
    button(panel, '清除剖切', () => send({ kind: 'clearSection' }));
    return (value: ReadonlyToolState<Section>) => {
      for (const field of sync) field(value);
    };
  }
  function refreshSelection() {
    hide.disabled = !port.available || !state.selection.canIsolateSelection;
    only.disabled = hide.disabled || state.selection.onlySelected;
  }
  port.addEventListener('selectionchange', refreshSelection);
  function render() {
    const s = port.snapshot;
    for (const model of s.options.models) {
      const checkbox = document
        .getElementById('model-' + model.id)
        ?.querySelector<HTMLInputElement>('.model-checkbox');
      if (checkbox) checkbox.checked = model.visible;
    }
    const available =
      port.available &&
      (state.currentProjectType === 'substation' ||
        state.currentProjectType === 'equipment' ||
        state.ifc.loadedModels.size > 0);
    for (const [i, tab] of tabs.entries()) {
      tab.disabled = !available;
      tab.setAttribute('aria-pressed', String(s.tool === tools[i][0]));
    }
    feedback.textContent = s.message;
    const section = s.tool === 'section' ? s.section : undefined;
    const reuseSection = section && section.kind === sectionKind && updateSectionFields;
    if (!reuseSection) {
      panel.replaceChildren();
      sectionKind = section?.kind;
      updateSectionFields = section ? editSection(section) : undefined;
    } else reuseSection(section);
    results.render(s);
    bar.dataset.tool = s.tool;
    for (const b of [home, views, ...cameraButtons]) b.disabled = !available;
    dock.hidden = !available || state.currentProjectType === 'transmission_line';
    cameraButtons[1].setAttribute('aria-pressed', String(s.cameraMode === 'orbit'));
    cameraButtons[2].setAttribute('aria-pressed', String(s.cameraMode === 'pan'));
    if (s.tool === 'view') {
      for (const [act, label] of [
        ['top', '俯视'],
        ['front', '正视'],
        ['right', '右视'],
        ['iso', '轴测'],
      ] as const)
        button(panel, label, () => send({ kind: 'camera', action: act }));
      button(
        panel,
        '上一视角',
        () => send({ kind: 'camera', action: 'back' }),
        !state.viewState.viewHistory?.canGoBack,
      );
    }
    pointer.setAttribute('aria-pressed', String(s.tool === 'select'));
    distance.setAttribute('aria-pressed', String(s.tool === 'distance'));
    filter.setAttribute('aria-pressed', String(s.tool === 'display'));
    for (const b of [pointer, restore, filter, ...shapes, distance]) b.disabled = !available;
    refreshSelection();
    shapes.forEach((b, i) =>
      b.setAttribute(
        'aria-pressed',
        String(!!s.section?.enabled && s.section.kind === ['horizontal', 'vertical', 'box'][i]),
      ),
    );
    if (s.tool === 'display') {
      if (s.options.models.length) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = '模型与 IFC 类型';
        details.append(summary);
        details.open = expanded;
        details.ontoggle = () => {
          if (details.isConnected) expanded = details.open;
        };
        panel.append(details);
        for (const row of s.options.models)
          check(details, row.label, row.visible, (v) =>
            send({ kind: 'model', id: row.id, visible: v }),
          );
        for (const type of s.options.types)
          check(details, type, !s.hiddenTypes.includes(type), (v) =>
            send({ kind: 'type', id: type, visible: v }),
          );
      }
      if (s.options.floors.length) {
        select(panel, '楼层', [{ id: '', label: '全部楼层' }, ...s.options.floors], s.floor, (id) =>
          send({ kind: 'floor', id, inferred: s.inferred }),
        );
        check(panel, '包含空间推断', s.inferred, (v) =>
          send({ kind: 'floor', id: s.floor, inferred: v }),
        );
      }
    }
    if (s.tool === 'distance') {
      panel.append(s.first ? '请选择第二个表面点' : '请选择第一个表面点');
      if (s.first) button(panel, '取消起点', () => send({ kind: 'cancelPoint' }));
    }
  }
  let expanded = false;
  port.addEventListener('change', render);
  render();
  return {
    render,
    refreshSelection,
    dispose() {
      port.removeEventListener('selectionchange', refreshSelection);
      removeTips();
      port.removeEventListener('change', render);
      removeDockTips();
      dock.remove();
      results.dispose();
    },
  };
}
