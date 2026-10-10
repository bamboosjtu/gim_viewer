import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPowerlineProject, buildTowerPreview } from '@gim/powerline-core';
import type { TreeNode } from '@gim/powerline-core';
import { parseProjectHeader } from '../src/core/header';
const expected = [
  { tower: 40, cross: 152 }, { tower: 129, cross: 414 }, { tower: 111, cross: 772 },
  { tower: 6, cross: 16 }, { tower: 49, cross: 798 }, { tower: 14, cross: 7 },
];
describe('six source package mobile contracts (required, never skipped)', () => {
  for (let i = 1; i <= 6; i++) it(`line0${i} has complete unique objects, sources, tree and cache equivalence`, () => {
    const sid = `line0${i}`;
    const header = parseProjectHeader(readFileSync(resolve(`../demo/${sid}.gim`)).subarray(0,784));
    expect(header.layout).toBe('在册分段头部布局');
    expect(header.fields.find(f => f.label === '工程名称')?.value).toBeTruthy();
    expect(header.fields.find(f => f.label === '导出软件')?.encoding).toBe('UTF-8');
    if (i === 4) expect(header.fields.find(f => f.label === '设计单位')?.value).toBeTruthy();
    const input = JSON.parse(readFileSync(resolve(`../output/mobile-samples/${sid}.json`), 'utf8'));
    const start = performance.now(); const project = buildPowerlineProject(input.files, input.identity); const parserMs = performance.now() - start;
    const ids = new Set(project.objects.map(o => o.id)); expect(ids.size).toBe(project.objects.length);
    const treeIds = new Set<string>(); const walk = (n: TreeNode) => { expect(ids.has(n.objectId)).toBe(true); treeIds.add(n.objectId); n.children.forEach(walk); }; walk(project.tree);
    expect(treeIds.size).toBe(ids.size);
    expect(project.counts.tower).toBe(expected[i - 1].tower); expect(project.counts.cross).toBe(expected[i - 1].cross);
    expect(project.objects.filter(o => o.kind === 'tower' && o.coordinate).length).toBe(project.counts.tower);
    const rawIds = new Set<string>(); for (const span of project.objects.filter(o => o.kind === 'span')) { for (const id of span.rawWireIds ?? []) { expect(rawIds.has(id)).toBe(false); rawIds.add(id); expect(project.rawWires.find(w => w.id === id)?.jumper).toBe(false); } }
    expect(rawIds.size).toBe(project.rawWires.filter(w => !w.jumper).length);
    const previewTower = project.objects.find(o => o.previewRef); expect(previewTower).toBeDefined();
    const text = input.files.find((f: { path: string }) => f.path === previewTower!.previewRef)?.text;
    expect(buildTowerPreview(text, previewTower!.previewRef!).segments.length).toBeGreaterThan(0);
    const encoded = JSON.stringify(project); const restored = JSON.parse(encoded);
    expect(restored.counts).toEqual(project.counts);
    expect(restored.objects.map((o: { id: string }) => o.id)).toEqual(project.objects.map(o => o.id));
    expect(JSON.stringify(restored)).toBe(encoded);
    writeFileSync(resolve(`../output/mobile-samples/${sid}-result.json`), JSON.stringify({ sid, sha: input.identity.sha256, parserMs, counts: project.counts, wire: project.rawWires.length, jumper: project.rawWires.filter(w => w.jumper).length, unassociated: project.rawWires.filter(w => !w.jumper && (!w.startTowerId || !w.endTowerId)).length, findings: project.findings.reduce((a, f) => ({ ...a, [f.code]: (a[f.code] ?? 0) + 1 }), {} as Record<string, number>) }, null, 2));
  });
});
