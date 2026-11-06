# -*- coding: utf-8 -*-
"""dev_inst —— 设备实例索引（粒度对齐 gim_element）

口径完全沿用 `gim_element`（element_core.DevTrack + devtype_class + entity_std）：
  · **设备身份由 DEV 本体决定**，与 F2/F3/F4 层级无关；没有 `OBJECTMODELPOINTER`
    的 F4 只是挂接/占位节点，不产生实体；
  · **变压器 = 本体 + 散热器 + 中性点成套装置**，中性点等附件并入所属变压器、不单独计台；
  · 「设备_部件」式命名（`避雷器模型01_土建接口`）上卷到父设备，不单独计台；
  · **PI(PARTINDEX) 层**：装置性材料计材料实例；箱柜类（…箱 / …柜）有独立子装配身份，
    释放为设备；其余装配内部件封装，不计数；
  · 词域外（无法识别 / 尺寸占位 / 占位名）落「其他」，**不上业务树**，只做统计。

本模块只做「判定 + 索引」，不建树：BTV 树（btv_dev）与文件视图（btv_file）共用同一份
实例索引，保证两边看到的是同一批设备。

与 gim_element 的差别只在数据来源：这里直接吃 `gim_core.Project` 已解析好的 cbm 树，
不重复解包、不重复读 fam（名字走 Project.build_display 的 fam 通道）。
"""
import collections
import os
import re
import sys

from gim_core import fam_kv, get1, kv, nm_ok

# 词表唯一真源在 gim_element：直接引用，不复制（避免两份词表漂移）
_HERE = os.path.dirname(os.path.abspath(__file__))
_EL = os.path.normpath(os.path.join(_HERE, '..', 'gim_element'))
if os.path.isdir(_EL) and _EL not in sys.path:
    sys.path.insert(0, _EL)
import devtype_class as DT        # noqa: E402
import entity_std as ES          # noqa: E402

G_DEV, G_MAT, G_STR, G_OTH = '设备', '装置性材料', '构件', '其他'
UNC = ('词域外', '未分类', '未分类(名占位)', '占位')


def _fmt_code(group, cat, sub):
    try:
        return ES.code_of(group, cat, sub or '')
    except Exception:
        return ('', cat or '')


class DeviceIndex:
    """cbm 树 → 设备实例索引。

    属性：
      insts   有序实例列表（设备 / 材料 / 构件，已排除附件、部件与「其他」）
      by_uuid cbm 节点 uuid → 实例
      attached 附件实例（中性点成套装置等），带 attach_of=所属主变分项名
      stats   计数器：f4 / f4无模型 / 设备 / 材料 / 构件 / 其他 / 附件 / 部件上卷 / PI封装
    """

    def __init__(self, p, progress=None):
        self.p = p
        self.prog = progress or (lambda m: None)
        self.insts = []
        self.by_uuid = {}
        self.attached = []
        self.stats = collections.Counter()
        self._dev_kv = {}
        self._fam_cache = {}
        self._build()

    # ---- fam 名称通道（PI 节点没有 NAME，只有 PARTNAME；真实设备名在 fam 设计参数）----
    def _fam_path(self, stem):
        if not stem:
            return ''
        p = self.p
        if stem in p.fam_paths:
            return p.fam_paths[stem]
        low = stem.lower()
        for k, v in p.fam_paths.items():
            if k.lower() == low:
                return v
        return ''

    def _fam_name(self, fam_stem):
        if not fam_stem:
            return ''
        key = fam_stem.lower()
        if key in self._fam_cache:
            return self._fam_cache[key]
        path = self._fam_path(fam_stem)
        out = ''
        if path:
            for k, v in fam_kv(path, self.p.bentley):
                if re.search(r'工程中名称|工程名称|设备名称|DeviceName|^Name$', k, re.I):
                    if '=' in v:
                        v = v.split('=')[-1]
                    if nm_ok(v):
                        out = v
                        break
        self._fam_cache[key] = out
        return out

    # ---- dev 文件属性（TYPE 兜底分类、SYMBOLNAME 兜底命名）----
    def _dev_kv_full(self, dev_stem):
        if not dev_stem:
            return {}
        key = dev_stem.lower()
        if key not in self._dev_kv:
            path = self.p.dev_paths.get(dev_stem) or self.p.dev_paths.get(key)
            if not path:
                for k, v in self.p.dev_paths.items():
                    if k.lower() == key:
                        path = v
                        break
            self._dev_kv[key] = kv(path) if path else {}
        return self._dev_kv[key]

    def _dev_type(self, dev_stem):
        d = self._dev_kv_full(dev_stem)
        return d.get('TYPE') or d.get('DEVICETYPE') or ''

    def _dev_name(self, dev_stem):
        """DEV 名字通道：dev 的 BASEFAMILY fam 设计参数 → SYMBOLNAME。

        与 gim_element.DevTrack._resolve 同序；PI 节点没有 NAME，只能走这里。
        """
        d = self._dev_kv_full(dev_stem)
        if not d:
            return ''
        bfv = next((v for k, v in d.items()
                    if 'BASEFAMILY' in k.upper() and v.endswith('.fam')), None)
        if bfv:
            n = self._fam_name(bfv[:-4])
            if n:
                return n
        sym = (d.get('SYMBOLNAME') or '').strip()
        return sym if nm_ok(sym) else ''

    def _node_name(self, u, lv, d):
        p = self.p
        if lv == 'F4':
            n = p.disp(u) or ''
            if not nm_ok(n):
                n = d.get('NAME') or d.get('OBJECTNAME') or ''
            return n
        # PI：PARTNAME 多为「&其他」占位，真实名走 fam → dev 的 SYMBOLNAME
        n = (d.get('PARTNAME') or '').strip()
        if nm_ok(n):
            return n
        fam = next((v[:-4] for k, v in d.items()
                    if 'BASEFAMILY' in k.upper() and v.endswith('.fam')), '')
        omp = next((v[:-4] for k, v in d.items()
                    if 'OBJECTMODELPOINTER' in k.upper() and v.endswith('.dev')), '')
        return self._fam_name(fam) or self._dev_name(omp) or ''

    def _f3_of(self, u):
        """向上找最近的 F3 节点 uuid。"""
        p = self.p
        cur, seen = u, set()
        while cur in p.parent and cur not in seen:
            seen.add(cur)
            cur = p.parent[cur]
            if p.level(cur) == 'F3':
                return cur
        return ''

    def _build(self):
        p = self.p
        for u in p.nodes:
            lv = p.level(u)
            if lv not in ('F4', 'PI'):
                continue
            d = p.nodes[u]
            omp = next((v for k, v in d.items()
                        if 'OBJECTMODELPOINTER' in k.upper() and v.endswith('.dev')), None)
            dev = omp[:-4] if omp else ''
            fam = next((v[:-4] for k, v in d.items()
                        if 'BASEFAMILY' in k.upper() and v.endswith('.fam')), '')
            if lv == 'F4':
                self.stats['f4'] += 1
                if not dev:
                    self.stats['f4无模型'] += 1     # 挂接/占位节点，不产生实体
                    continue
            name = self._node_name(u, lv, d)
            if not name:
                self.stats['未命名'] += 1
                continue
            g, c, sub, part = DT.three_way(name, self._dev_type(dev))
            inst = {
                'u': u, 'lv': lv, 'name': name,
                'group': g, 'cat': c, 'sub': sub or '',
                'dev': dev, 'fam': fam,
                'f3': self._f3_of(u),
                'ifc_file': get1(d, 'IFCFILE') or '',
                'guid': get1(d, 'IFCGUID') or '',
            }
            inst['code'], inst['std'] = _fmt_code(g, c, inst['sub'])

            # ---- PI：材料实例 / 箱柜释放为设备，其余封装 ----
            if lv == 'PI':
                if g == G_MAT:
                    self._add(inst)
                    self.stats['PI材料'] += 1
                elif g == G_DEV and name.rstrip().endswith(('箱', '柜')):
                    self._add(inst)
                    self.stats['PI箱柜设备'] += 1
                else:
                    self.stats['PI封装'] += 1
                continue

            # ---- F4 ----
            if g in UNC:
                self.stats['其他'] += 1
                continue
            if g == G_DEV:
                if DT.is_attachment(name):
                    inst['attach_of'] = ''      # 由 BTV 侧按分项归并
                    self.attached.append(inst)
                    self.stats['附件(并入本体)'] += 1
                    continue
                head, is_part = DT.split_part(name)
                if is_part:
                    hg, _hc, _hs, _hp = DT.three_way(head, self._dev_type(dev))
                    if hg == G_DEV:
                        self.stats['部件上卷'] += 1
                        continue
                self._add(inst)
                self.stats['设备'] += 1
            elif g == G_MAT:
                self._add(inst)
                self.stats['材料'] += 1
            elif g == G_STR:
                if part:
                    self.stats['构件部件'] += 1
                    continue
                self._add(inst)
                self.stats['构件'] += 1
            else:
                self.stats['其他'] += 1
        self.prog('实例索引：设备 %d · 材料 %d · 构件 %d · 附件 %d · 其他 %d'
                  % (self.stats['设备'], self.stats['材料'], self.stats['构件'],
                     self.stats['附件(并入本体)'], self.stats['其他']))

    def _add(self, inst):
        self.insts.append(inst)
        self.by_uuid[inst['u']] = inst

    # ---- 视图辅助 ----
    def groups(self):
        """→ {组: [实例]}"""
        out = collections.defaultdict(list)
        for it in self.insts:
            out[it['group']].append(it)
        return out

    def attach_count(self, f3_uuid):
        """某个 F3 下并入主变的附件台数（BTV 分项计数用）。"""
        return sum(1 for a in self.attached if a.get('f3') == f3_uuid)


def dev_stats(idx):
    """索引摘要（分轨报告 / 状态栏用）。"""
    st = dict(idx.stats)
    st['上树'] = len(idx.insts)
    st['台数'] = st.get('设备', 0)
    return st
