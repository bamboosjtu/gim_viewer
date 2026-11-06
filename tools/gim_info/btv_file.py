# -*- coding: utf-8 -*-
"""btv_file —— 另一种模型组织方式：**按文件**（cbm 工程节点 → dev 模型文件）

两种组织方式分工：
  · `btv_dev` / BTV 业务树：按「组成层级」组织——工程 → 设备类别桶 → 间隔(F3) → 设备；
  · **本模块**：按「文件」组织——一个 cbm 工程节点 → 它引用的 dev 模型文件 → 设备实例。
    适合核对「哪个工程节点对应哪个图元」「同一图元被几个节点复用」。

数据来源与 BTV 完全一致（`gim_core.Project` + `dev_inst.DeviceIndex`），
所以两种视图里的设备名、类别、编码是同一套。

两级结构：
    CBM 节点（xxx.cbm，带 F1/F2/F3 路径）
      └ DEV 模型文件（yyy.dev）→ 设备实例（名称 · 组 · 编码；附件标「并入主变」）
没有 OBJECTMODELPOINTER 的 cbm（挂接位 / 占位节点）不列，只计数。
"""
import collections

from gim_core import get1

G_DEV = '设备'


def _f_path(p, u):
    """→ (F1 名, F2 名, F3 名)；缺名时用层级占位。"""
    names = {'F1': '', 'F2': '', 'F3': ''}
    cur, seen = u, set()
    while cur in p.parent and cur not in seen:
        seen.add(cur)
        cur = p.parent[cur]
        lv = p.level(cur)
        if lv in names:
            names[lv] = p.disp_raw(cur) or ''
        if lv == 'F1':
            break
    return names['F1'], names['F2'], names['F3']


def build_file_tree(p, idx=None):
    """→ [{'cbm','dev','f1','f2','f3','insts':[…],'reuse':n}]（按 F1→F2→F3→cbm 排序）。

    一个 cbm 节点通常只引一个 dev（1:1）；`reuse` 标出同一 dev 被几个 cbm 引用。
    """
    rows = []
    dev_use = collections.Counter()
    by_uuid = idx.by_uuid if idx is not None else {}
    attached = {a['u']: a for a in (idx.attached if idx is not None else [])}
    for u in p.nodes:
        if p.level(u) != 'F4':
            continue
        d = p.nodes[u]
        omp = next((v for k, v in d.items()
                    if 'OBJECTMODELPOINTER' in k.upper() and v.endswith('.dev')), None)
        if not omp:
            continue                       # 挂接位 / 占位节点，没有模型文件
        dev = omp[:-4]
        dev_use[dev] += 1
        inst = by_uuid.get(u) or attached.get(u)
        if inst:
            node = {'name': inst['name'], 'group': inst['group'], 'cat': inst['cat'],
                    'code': inst.get('code') or '', 'sub': inst.get('sub') or '',
                    'attached': u in attached}
        else:                              # 未入索引（其他/跳过）仍列出文件名层
            node = {'name': p.disp(u) or d.get('NAME') or '', 'group': '', 'cat': '',
                    'code': '', 'sub': '', 'attached': False}
        f1, f2, f3 = _f_path(p, u)
        rows.append({'cbm': u, 'dev': dev, 'f1': f1, 'f2': f2, 'f3': f3,
                     'inst': node, 'reuse': 0})
    for r in rows:
        r['reuse'] = dev_use[r['dev']]
    rows.sort(key=lambda r: (r['f1'], r['f2'], r['f3'], r['dev'], r['cbm']))
    return rows


def group_by_cbm(rows):
    """→ [{cbm, f1, f2, f3, devs: [row…], reuse_max}]，cbm 一级、dev 二级。"""
    out = collections.OrderedDict()
    for r in rows:
        g = out.setdefault(r['cbm'], {'cbm': r['cbm'], 'f1': r['f1'], 'f2': r['f2'],
                                      'f3': r['f3'], 'devs': []})
        g['devs'].append(r)
    return list(out.values())


def file_stats(p, rows):
    """文件视图摘要。"""
    devs = {r['dev'] for r in rows}
    shared = [r for r in rows if r['reuse'] > 1]
    f4 = sum(1 for u in p.nodes if p.level(u) == 'F4')
    return {
        'cbm节点': f4,
        '有模型文件': len(rows),
        '无模型文件': f4 - len(rows),
        '唯一dev': len(devs),
        '复用dev': len({r['dev'] for r in shared}),
        '设备': sum(1 for r in rows if r['inst']['group'] == G_DEV and not r['inst']['attached']),
        '材料': sum(1 for r in rows if r['inst']['group'] == '装置性材料'),
        '构件': sum(1 for r in rows if r['inst']['group'] == '构件'),
        '附件并入': sum(1 for r in rows if r['inst']['attached']),
    }
