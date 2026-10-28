# -*- coding: utf-8 -*-
"""用渲染器自身的构建结果，导出每个网格的世界包围盒"""
import os, sys, json, shutil
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_render import make_page
from playwright.sync_api import sync_playwright

GIM = sys.argv[1]
page, work, meta = make_page(GIM)
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', args=['--use-gl=angle', '--use-angle=swiftshader',
                                                 '--enable-unsafe-swiftshader', '--allow-file-access-from-files'])
    pg = b.new_page(viewport={'width': 1000, 'height': 700})
    pg.goto('file:///' + page.replace('\\', '/'), wait_until='load')
    pg.wait_for_timeout(2500)
    rows = pg.evaluate("""() => {
      const out = [];
      for (const m of meshes){
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        const bb = m.geometry.boundingBox.clone().applyMatrix4(m.matrix);
        const e = m.userData.ent || {};
        out.push({
          id: e.id, type: e.type, hidden: !!e.hidden,
          min: [bb.min.x, bb.min.y, bb.min.z].map(v=>+v.toFixed(0)),
          max: [bb.max.x, bb.max.y, bb.max.z].map(v=>+v.toFixed(0)),
          attrs: e.attrs || {}
        });
      }
      return JSON.stringify(out);
    }""")
    rows = json.loads(rows)
    b.close()
shutil.rmtree(work, ignore_errors=True)

json.dump(rows, open('_bbox.json', 'w', encoding='utf-8'), ensure_ascii=False)
print('网格数', len(rows))
zmin = min(r['min'][2] for r in rows); zmax = max(r['max'][2] for r in rows)
print(f'z 范围 {zmin} .. {zmax}')
# 按 z 分层统计，看哪一段是空的
import collections
bands = collections.Counter()
for r in rows:
    for z in range(int(zmin//250*250), int(zmax)+250, 250):
        if r['min'][2] < z+250 and r['max'][2] > z:
            bands[z] += 1
for z in sorted(bands):
    print(f'  z {z:5d}-{z+250:5d} : {"#"*min(bands[z],80)} {bands[z]}')
