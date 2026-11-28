import { lineModelPreview } from '../../../viewer/lineModelPreview.js';
import { linePreviewBatch } from '../runtime/lineGeometryPreview.js';
import type { LineModRuntimeEntry } from './lineModSourcePort.js';
import type { GimGraphNode } from '@gim/powerline-core/gimGraphTypes.js';
export function showLineModel(
  node: GimGraphNode,
  entries: LineModRuntimeEntry[],
  version: string,
  spacing?: { mm: number; path: string },
) {
  const dialog = document.createElement('dialog');
  dialog.className = 'line-model-dialog';
  dialog.setAttribute('aria-label', '线路三维模型');
  dialog.innerHTML =
    '<header><strong>线路三维模型</strong><button type="button">关闭</button></header><section><select aria-label="几何来源"></select><select aria-label="呼高"></select><select aria-label="子腿"></select></section><canvas></canvas><p role="status"></p>';
  const [source, height, leg] = dialog.querySelectorAll('select'),
    status = dialog.querySelector('p')!,
    canvas = dialog.querySelector('canvas')!;
  const sources = entries.filter((e) => {
    const r = e.source?.records;
    return r && ('hNum' in r || 'H1' in r || 'OUTSIDEDIAMETER' in r);
  });
  for (const [i, e] of sources.entries()) source.add(new Option(e.path, String(i)));
  document.body.append(dialog);
  dialog.showModal();
  let view: ReturnType<typeof lineModelPreview> | undefined;
  const close = () => dialog.close();
  dialog.querySelector('button')!.onclick = close;
  dialog.addEventListener(
    'close',
    () => {
      view?.dispose();
      dialog.remove();
    },
    { once: true },
  );
  function render() {
    try {
      const entry = sources[source.selectedIndex];
      const compiled =
        entry &&
        linePreviewBatch(
          node,
          entry,
          version,
          height.value ? Number(height.value) : undefined,
          leg.value ? [Number(leg.value)] : undefined,
          spacing,
        );
      if (!compiled || !compiled.binding.ownerIds.includes(node.path)) {
        status.textContent = '尚缺可定位的部件或端点';
        canvas.hidden = true;
        return;
      }
      view ??= lineModelPreview(canvas);
      canvas.hidden = false;
      view.show(compiled.batch);
      const issues = compiled.batch.objects.reduce((n, o) => n + o.diagnostics.length, 0);
      status.textContent =
        compiled.caption +
        (issues ? ' · ' + issues + ' 条来源诊断' : '') +
        (!compiled.batch.templates.size
          ? compiled.batch.objects.some((o) => o.ports.length)
            ? ' · 仅有已知端口'
            : ' · 暂无可绘制几何'
          : '');
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
      canvas.hidden = true;
    }
  }
  function legsForHeight() {
    leg.replaceChildren(new Option('按来源保留子腿', ''));
    const r = sources[source.selectedIndex]?.source?.records;
    if (r && 'hNum' in r && height.value) {
      const options = r.hRecords.filter((h) => h.height === Number(height.value));
      const chosen = options.length === 1 ? options[0] : undefined;
      const parts = r.bodySections.find((b) => b.name === chosen?.body)?.partStarts ?? [];
      for (const n of new Set(
        parts
          .filter((p) => p.kind === 'subleg' && chosen?.leg === 'Leg' + p.leg)
          .map((p) => p.subleg),
      )) {
        if (n !== undefined) leg.add(new Option('子腿 ' + n, String(n)));
      }
    }
    leg.hidden = leg.length === 1;
    render();
  }
  function options() {
    height.replaceChildren(new Option('完整骨架', ''));
    const r = sources[source.selectedIndex]?.source?.records;
    if (r && 'hNum' in r) {
      for (const h of r.hRecords) height.add(new Option(h.height + ' mm', String(h.height)));
    }
    height.hidden = height.length === 1;
    legsForHeight();
  }
  source.onchange = options;
  height.onchange = legsForHeight;
  leg.onchange = render;
  options();
  return close;
}
