# -*- coding: utf-8 -*-
"""btv_split —— BTV 分轨导出：dev 轨道 / ifc 轨道各自一份文件

拆分后 btv 的两条轨道可以单独跑、单独核对：
  · dev 轨道（btv_dev.build_dev_btv）：只吃 cbm/fam/dev，产出「工程→桶→分项→F4」树；
  · ifc 轨道（btv_ifc.build_ifc_tree）：只吃 IFC 探针，产出「角色·目标→文件→楼层/挂接」树；
  · 融合视图（btv_class.build_btv）：dev 树 + IFC 名称回填 + 电气划桶 + 坐标归位，
    仅作对照，不参与分轨统计。

用法：
    python btv_split.py D:/三维设计/sample/substation01
    python btv_split.py <目录> --outdir ./btv_out --fused
    python btv_split.py <目录> --no-scan          # 不扫 IFC，只导 dev 轨道

产物（默认写到当前目录）：
    btv_dev.json   dev 轨道树 + 摘要
    btv_ifc.json   ifc 轨道树 + 摘要
    btv_fused.json 融合树（--fused 时）
"""
import argparse
import json
import os
import sys
import time

import bay_infer
import btv_dev
import btv_ifc
from fusion import Fusion
from gim_core import Project
from ifc_probe import ifc_probe_file


def _log(msg):
    print(msg, flush=True)


def scan_ifc(p, fuz, log=_log):
    """全量扫 IFC + 坐标推断（与 GUI 后台流程同口径）。"""
    todo = sorted(fuz.files.items(), key=lambda kv: os.path.getsize(kv[1][1]))
    t0 = time.time()
    for i, (fl, (disp, path)) in enumerate(todo, 1):
        log('IFC %d/%d %s' % (i, len(todo), disp))
        try:
            r = ifc_probe_file(path, fuz.byfile.get(fl, {}))
        except Exception as exc:                       # 单文件失败不拖垮整条轨道
            r = {'error': repr(exc)[-300:], 'resid': {}, 'outside': {}, 'guids': {},
                 'storeys': []}
        fuz.probe[fl] = r
        for g, rec in r.get('guids', {}).items():
            fuz.guidrec.setdefault(g, rec)
    log('IFC 扫描完成：%d 文件 / %.1fs' % (len(todo), time.time() - t0))
    bayinf = {}
    if fuz.files:
        t1 = time.time()
        try:
            bayinf, bays = bay_infer.infer(p, fuz, log)
            log('坐标推断：%d 个散材 / %d 个间隔群 / %.1fs'
                % (len(bayinf), len(bays), time.time() - t1))
        except Exception as exc:
            log('坐标推断失败（dev 轨道不受影响）：%r' % exc)
    return bayinf


def main():
    ap = argparse.ArgumentParser(
        description='BTV 分轨导出：dev 轨道 / ifc 轨道分别成文件')
    ap.add_argument('path', help='.gim 解包目录（含 cbm/dev/fam/ifc）')
    ap.add_argument('--outdir', default='.', help='输出目录（默认当前目录）')
    ap.add_argument('--fused', action='store_true', help='额外导出融合树 btv_fused.json')
    ap.add_argument('--no-scan', action='store_true', help='不扫 IFC，只导 dev 轨道')
    args = ap.parse_args()

    d = args.path.rstrip('\\/')
    if not os.path.isdir(d):
        sys.exit('不是目录：%s' % d)
    os.makedirs(args.outdir, exist_ok=True)
    t_all = time.time()

    p = Project(d, _log)
    fuz = Fusion(p)
    _log('工程 %s ｜ cbm %d ｜ ifc %d ｜ 挂接键 %d'
         % (p.proj_name, len(p.cbm_paths), len(fuz.files), fuz.join_n))

    # ---- 1) dev 轨道：纯 GIM，不看 IFC ----
    t0 = time.time()
    dev_tree = btv_dev.build_dev_btv(p, progress=_log)
    dev_st = btv_dev.dev_stats(dev_tree)
    dev_meta = {
        'track': 'dev',
        'source': d,
        'project': p.proj_name,
        'elapsed_s': round(time.time() - t0, 1),
        'rule': '只读 cbm F1–F4 / SYSTEMNAME / SYSTEMCLASSIFYNAME / fam 族属性 / 标识编码；'
                '叶子按 gim_element 口径的设备实例（DEV 本体；主变附件并入、部件上卷、'
                'PI 箱柜释放），词域外与无模型节点不上树；不回填 IFC 名称、不按 IFC 白名单改桶',
        'stats': dev_st,
        'buckets': {c: sorted(bs) for c, bs in dev_tree.items()},
    }
    dev_out = os.path.join(args.outdir, 'btv_dev.json')
    json.dump({'meta': dev_meta, 'tree': dev_tree}, open(dev_out, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1, sort_keys=True)
    _log('dev 轨道 → %s（桶 %d · 分项 %d · 叶子 %d · 设备 %d 台 + 并入附件 %d · '
         '材料 %d · 构件 %d）'
         % (dev_out, dev_st['桶'], dev_st['分项'], dev_st['叶子'], dev_st['设备'],
            dev_st['附件'], dev_st['装置性材料'], dev_st['构件']))

    if args.no_scan:
        _log('已跳过 IFC 扫描（--no-scan），用时 %.1fs' % (time.time() - t_all))
        return

    # ---- 2) ifc 轨道：只读 IFC 探针 ----
    bayinf = scan_ifc(p, fuz)
    t1 = time.time()
    ifc_tree = btv_ifc.build_ifc_tree(fuz)
    ifc_st = btv_ifc.ifc_stats(fuz, ifc_tree)
    ifc_meta = {
        'track': 'ifc',
        'source': d,
        'project': p.proj_name,
        'elapsed_s': round(time.time() - t1, 1),
        'rule': '只读 IFC 探针：文件角色 / 楼层 / GUID 挂接 / 未挂接类型组；'
                '不建 cbm 业务树，不改 dev 分类',
        'stats': ifc_st,
    }
    ifc_out = os.path.join(args.outdir, 'btv_ifc.json')
    json.dump({'meta': ifc_meta, 'groups': ifc_tree}, open(ifc_out, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1, sort_keys=True)
    _log('ifc 轨道 → %s（文件 %d · 楼层 %d · 挂接 %d · 未命中 %d · 未挂接组 %d）'
         % (ifc_out, ifc_st['文件'], ifc_st['楼层'], ifc_st['挂接命中'],
            ifc_st['挂接未命中'], ifc_st['未挂接类型组']))

    # ---- 3) 融合视图（可选，只作对照） ----
    if args.fused:
        hints, elec = btv_ifc.fill_hints(fuz)
        fused = btv_dev.build_dev_btv(p, hints=hints, rehome=bayinf, elec=elec)
        fs = btv_dev.dev_stats(fused)
        fused_out = os.path.join(args.outdir, 'btv_fused.json')
        json.dump({'meta': {'track': 'fused', 'source': d, 'project': p.proj_name,
                            'rule': 'dev 树 + IFC 名称回填(%d) + 电气白名单(%d) + 坐标归位(%d)'
                                    % (len(hints), len(elec), len(bayinf)),
                            'stats': fs},
                   'tree': fused},
                  open(fused_out, 'w', encoding='utf-8'), ensure_ascii=False,
                  indent=1, sort_keys=True)
        _log('融合视图 → %s（叶子 %d · 设备 %d / 材料 %d / 建构 %d / 未分类 %d）'
             % (fused_out, fs['叶子'], fs['设备'], fs['装置性材料'],
                fs['建构筑物'], fs['未分类']))

    _log('完成，用时 %.1fs' % (time.time() - t_all))


if __name__ == '__main__':
    main()
