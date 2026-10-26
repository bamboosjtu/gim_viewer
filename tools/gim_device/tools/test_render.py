# -*- coding: utf-8 -*-
"""test_render.py —— 用无头浏览器验证任意 gim 的渲染结果

做法：把 three.js 内联 + 数据内联，生成一次性页面再截图。
用于开发期快速回归（最终交付走 PySide6 外壳）。
"""
import os
import sys
import json
import shutil
import tempfile
import argparse
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))       # gim_device/tools
ROOT = os.path.dirname(HERE)                            # gim_device
sys.path.insert(0, ROOT)
import gim_core as gc

SHELL = os.path.join(ROOT, 'viewer_shell.html')
OUTDIR = os.path.join(ROOT, '_screenshots')   # 回归截图统一落这里


def make_page(gim_path):
    """生成自包含测试页面，返回 (临时html路径, 解析统计)"""
    work = tempfile.mkdtemp(prefix='gimtest_')
    data = gc.load(gim_path, work)
    shutil.rmtree(work, ignore_errors=True)

    with open(SHELL, encoding='utf-8') as f:
        html = f.read()
    for fn in ('three.min.js', 'OrbitControls.js'):
        with open(os.path.join(ROOT, fn), encoding='utf-8') as f:
            code = f.read()
        html = html.replace(f'<script src="{fn}"></script>',
                            f'<script>/* {fn} */\n{code}\n</script>')

    payload = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    html = html.replace('</body>', f'<script>window.loadModel({payload});</script></body>')

    out = os.path.join(work, 'render.html')
    os.makedirs(work, exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html)
    return out, work, data['meta']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('gim')
    ap.add_argument('--out', default=None)
    ap.add_argument('--views', default='iso')
    ap.add_argument('--w', type=int, default=1500)
    ap.add_argument('--h', type=int, default=1100)
    args = ap.parse_args()

    page_path, work, meta = make_page(args.gim)
    print(f"设备  : {meta['symbol'] or '(未命名)'}  容器={meta['container']}  mod={len(meta['mods'])}")
    print(f"实体  : {meta['entityCount']}  类型 {len(meta['types'])} 种")
    print(f"分布  : {dict(sorted(meta['types'].items(), key=lambda x:-x[1])[:8])}")

    errs = []
    out_base = args.out or os.path.splitext(os.path.basename(args.gim))[0]
    with sync_playwright() as p:
        b = p.chromium.launch(channel='chrome',
                              args=['--use-gl=angle', '--use-angle=swiftshader',
                                    '--enable-unsafe-swiftshader',
                                    '--allow-file-access-from-files', '--hide-scrollbars'])
        pg = b.new_page(viewport={'width': args.w, 'height': args.h}, device_scale_factor=2)
        pg.on('pageerror', lambda e: errs.append('PAGEERR: ' + str(e)))
        pg.on('console', lambda m: errs.append(f'[{m.type}] {m.text}') if m.type in ('error','warning') else None)
        pg.goto('file:///' + page_path.replace('\\', '/'), wait_until='load')
        pg.wait_for_timeout(2600)
        # 捕获未处理异常堆栈
        pg.add_init_script("window.__errs=[];window.onerror=function(m,s,l,c,e){window.__errs.push((e&&e.stack)||m);};")
        st = pg.evaluate("() => window.__errs || []")
        if st:
            print('JS 堆栈:')
            for x in st[:3]:
                print('  ', str(x)[:600])

        info = pg.evaluate("() => window.__api ? window.__api.stats() : null")
        print(f"渲染  : {info}")

        for v in args.views.split(','):
            v = v.strip()
            if not v:
                continue
            pg.evaluate(f"() => window.__api.view('{v}')")
            pg.wait_for_timeout(700)
            name = f'_r_{out_base}_{v}.png'
            os.makedirs(OUTDIR, exist_ok=True)
            pg.screenshot(path=os.path.join(OUTDIR, name))
            print('  ->', name)

        if errs:
            print('页面错误:')
            for e in errs[:8]:
                print('   ', e)
        b.close()
    shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
