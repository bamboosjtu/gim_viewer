# -*- coding: utf-8 -*-
"""btv_ifc —— BTV 的 **ifc 轨道**（只读 IFC 侧：文件角色 / 楼层 / 构件 / GUID 挂接）

分轨背景（2026-11-03）：原来 `btv_class.build_btv()` 把 IFC 的三件事混进 dev 业务树——
 ① IFC 实体名回填 F4 类别；
 ② 电气散材白名单（`线夹/导线/金具/绝缘子/母线…`）把建筑工程桶改判到安装侧；
 ③ 坐标推断把散材挂到别的间隔。
现在这些**只作为可选的注入项**：本模块负责产出 IFC 侧自己的树与回填字典，
由调用方决定是否交给 `btv_dev.build_dev_btv(hints=…, rehome=…, elec=…)`。

本模块不做分类裁决、不写 cbm 树，只回答：
  · 这个 IFC 文件是什么角色、目标分组是什么（fusion.file_role）；
  · 文件里有哪些楼层、每个楼层挂了多少 GIM 构件、还剩哪些未挂接类型；
  · GUID → IFC 实体名/类型/楼层（供 dev 轨道回填）。
"""
import os
import re

from btv_dev import dev_class

# ---- IFC 电气类白名单（沿挂接点划入安装工程） ----
# 2026-10-29 用户口径收紧：安装侧的「散材」只归**装置性材料**（灯具除外），
# 所以白名单只放材料词。端子箱 / 检修箱是设备（箱柜），不在此列——否则它们会被
# 当成散材走坐标归属、混进主变区域的散材明细里。
IFC_ELEC_RX = re.compile(r'线夹|绝缘子|母线|导线|金具|引流|穿墙套管|设备连接|接线')

UNC = ('未分类', '未分类(名占位)', '占位')
# 楼层质量口径（ifc_probe.probe_quality 的取值）
REAL_QUALITY = ('real',)


def fill_hints(fuz):
    """IFC 轨道 → dev 轨道的回填字典。

    返回 (hints, elec)：
      hints = {guid: (kind, cat)}  IFC 实体名能判出类别时才收（未分类不入）
      elec  = {guid}               电气散材白名单命中

    与旧 build_btv 的差别只在「显式」：旧版在 dev 循环里顺手查 fuz.guidrec，
    现在由调用方把这两个字典传进去，dev 模块自己不碰 IFC。
    """
    hints, elec = {}, set()
    for g, rec in (getattr(fuz, 'guidrec', {}) or {}).items():
        if rec.get('miss'):
            continue
        nm = rec.get('n') or ''
        if not nm:
            continue
        if IFC_ELEC_RX.search(nm):
            elec.add(g)
        inm = nm.split(':')[0]          # 旧口径：族名:类型名:实例号 → 取族名
        k, c = dev_class(inm, None)
        if k not in UNC:
            hints[g] = (k, c)
    return hints, elec


def hooked_items(probe):
    """一个文件的 probe 结果 → 已挂接构件列表 + 未命中数。"""
    guids = (probe or {}).get('guids') or {}
    hit = [{'guid': g, 'name': rec.get('n') or '', 'type': rec.get('t') or '',
            'storey': rec.get('st') or '', 'cbm': rec.get('cbm') or ''}
           for g, rec in guids.items() if not rec.get('miss')]
    miss = sum(1 for rec in guids.values() if rec.get('miss'))
    return hit, miss


def build_ifc_tree(fuz):
    """纯 IFC 树数据：角色·目标分组 → 文件 → 楼层/挂接/未挂接。

    结构：
      [{'role': '建筑', 'target': '主控通信楼(推断)',
        'files': [{'file','path','inferred','size_mb','quality',
                   'storeys': [{'name','elev','guid'}],
                   'hooked': [{'guid','name','type','storey','cbm'}],
                   'miss': n, 'resid': {楼层: {类型: n}}, 'outside': {类型: n}}]}]
    角色顺序：安装 → 建筑 → 构筑物 → 总图 → 其他。
    """
    groups = {}
    for fl, (disp, path) in sorted((getattr(fuz, 'files', {}) or {}).items()):
        role, target, inferred = fuz.roles.get(fl, ('其他', fl, True))
        probe = (getattr(fuz, 'probe', {}) or {}).get(fl) or {}
        hit, miss = hooked_items(probe)
        groups.setdefault((role, target), []).append({
            'file': disp,
            'path': path,
            'inferred': bool(inferred),
            'size_mb': probe.get('size_mb'),
            'quality': probe.get('quality'),
            'storeys': probe.get('storeys') or [],
            'buildings': probe.get('buildings') or [],
            'hooked': hit,
            'miss': miss,
            'resid': probe.get('resid') or {},
            'outside': probe.get('outside') or {},
            'error': probe.get('error'),
        })
    order = {'安装': 0, '建筑': 1, '构筑物': 2, '总图': 3}
    out = [{'role': role, 'target': target, 'files': files}
           for (role, target), files in groups.items()]
    out.sort(key=lambda g: (order.get(g['role'], 9), g['target']))
    return out


def ifc_stats(fuz, tree=None):
    """ifc 轨道摘要：文件/楼层/挂接命中/未挂接组数。"""
    tree = tree if tree is not None else build_ifc_tree(fuz)
    st = {'文件': 0, '已扫描': 0, '楼层': 0, '挂接命中': 0,
          '挂接未命中': 0, '未挂接类型组': 0, '角色': {}}
    for g in tree:
        st['角色'][g['role']] = st['角色'].get(g['role'], 0) + len(g['files'])
        for f in g['files']:
            st['文件'] += 1
            if (getattr(fuz, 'probe', {}) or {}).get(
                    os.path.splitext(f['file'])[0].lower()) is not None:
                st['已扫描'] += 1
            st['楼层'] += len(f['storeys'])
            st['挂接命中'] += len(f['hooked'])
            st['挂接未命中'] += f['miss']
            st['未挂接类型组'] += (len(f['resid']) + len(f['outside']))
    return st
