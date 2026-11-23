// @vitest-environment node
import { expect, it } from 'vitest';
import { inspectorTabsHtml, renderInspectorSummary, sectionHtml } from '../inspectorMarkup.js';

it('formats tabs and escapes source text without a DOM', () => {
  const html = inspectorTabsHtml('<h2>设备</h2>', { overview: '<p>概要</p>', params: ' ', relations: '', source: '<p>来源</p>' }, 'params');
  expect(html).toContain('data-itab="params" class="itab active"');
  expect(html).toContain('data-itab-pane="params" class="itab-pane active"');
  expect(html).toContain('暂无内容');
  expect(sectionHtml('原始值', [['ENTITYNAME', '<设备&>']])).toContain('&lt;设备&amp;&gt;');
  const summary = renderInspectorSummary({ name: '<主变>', identity: '', keyRows: [{ label: '电压', value: '220&' }], idRows: [], systemPath: '', componentCount: 0 });
  expect(summary).toContain('&lt;主变&gt;');
  expect(summary).toContain('220&amp;');
});
