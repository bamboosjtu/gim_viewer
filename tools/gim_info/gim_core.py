# -*- coding: utf-8 -*-
"""gim_core —— GIM 解析核心：cbm/fam/dev 键值解析 + Project 树模型
（与 05-模型树/btv_build_v2.py 同源口径，无 UI 依赖，可 CLI 调用）。"""
import os, re, threading, collections

# ---------------- 解析核心（与 btv_build_v2.py 同源） ----------------

def kv(path):
    d = {}
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                if '=' in line:
                    k, v = line.split('=', 1)
                    d[k.strip()] = v.strip()
    except OSError:
        pass
    return d

def fam_kv(path, bentley):
    out = []
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip().lstrip('\ufeff')
                if not line or (line.startswith('[') and line.endswith(']')):
                    continue
                if '=' in line:
                    k, v = line.split('=', 1)
                    if bentley and '=' in v:
                        v = v.split('=')[-1]
                    out.append((k.strip(), v.strip()))
    except OSError:
        pass
    return out

LV_MAP = {'F1SYSTEM': 'F1', 'F2SYSTEM': 'F2', 'F3SYSTEM': 'F3',
          'F4SYSTEM': 'F4', 'PARTINDEX': 'PI'}
NM_INVALID = re.compile(r'^(|/|-|X|NULL1?|NAIZHANG|22\?|\?.*)$')

def nm_ok(n):
    return bool(n) and not NM_INVALID.match(n) and not n.startswith('&')

def get1(d, prefix):
    for k, v in d.items():
        if k.upper().startswith(prefix.upper()):
            if '=' in v:
                v = v.split('=')[-1]
            if v and v != '$':
                return v
    return None

def _natkey(s):
    return [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', s)]

class Project:
    """GIM 样本目录的解析结果：树 + 属性 + 搜索索引。"""

    def __init__(self, root_dir, progress=None):
        progress = progress or (lambda msg: None)
        self.root_dir = root_dir
        self.bentley = False
        cbm_paths, fam_paths, dev_paths, ifc_paths = {}, {}, {}, {}
        for base, _, files in os.walk(root_dir):
            for fn in files:
                stem, ext = os.path.splitext(fn)
                low = ext.lower()
                p = os.path.join(base, fn)
                if low == '.cbm':
                    cbm_paths[stem] = p
                elif low == '.fam':
                    fam_paths[stem] = p
                elif low == '.dev':
                    dev_paths[stem] = p
                elif low == '.ifc':
                    ifc_paths[stem] = p
        self.fam_paths, self.dev_paths = fam_paths, dev_paths
        self.ifc_paths = {k.lower(): v for k, v in ifc_paths.items()}
        self.ifc_files = ifc_paths
        self.fam_cache = {}              # 提前初始化：显示名/排序阶段即会读 fam
        progress('读取 cbm（%d 个）…' % len(cbm_paths))
        self.nodes = {}
        # 并行读 cbm：文件 IO（含杀软实时扫描等待）远大于解析耗时，
        # 串行会把首扫延迟放大成数分钟（2026-10-28 卡死实测），16 线程与 fam/dev 同策略
        from concurrent.futures import ThreadPoolExecutor
        items = list(cbm_paths.items())
        done = [0]
        lock = threading.Lock()

        def _read_cbm(up):
            u, p = up
            r = (u, kv(p))
            with lock:
                done[0] += 1
                n = done[0]
            if n % 2000 == 0:
                progress('读取 cbm %d/%d…' % (n, len(items)))
            return r

        with ThreadPoolExecutor(max_workers=16) as ex:
            for u, d in ex.map(_read_cbm, items):
                self.nodes[u] = d
        self.cbm_paths = cbm_paths

        progress('构建树…')
        self.children = collections.defaultdict(list)
        self.parent = {}
        for u, d in self.nodes.items():
            for k, v in d.items():
                ku = k.upper()
                if (ku.startswith('SUBSYSTEM') or ku.startswith('SUBDEVICE')) \
                        and v.endswith('.cbm') and v[:-4] in self.nodes:
                    self.children[u].append(v[:-4])
                    self.parent[v[:-4]] = u
        # F1/F2 系统名继承：F1/F2 节点自身常无 SYSTEMNAME 键，名字记录在
        # 子孙 F3 的 SYSTEMNAME1/SYSTEMNAME2（与 btv_build_v2 同一口径）
        f1n, f2n = {}, {}
        for u in self.nodes:
            if self.level(u) != 'F3':
                continue
            d = self.nodes[u]
            p2 = self.parent.get(u)
            p1 = self.parent.get(p2) if p2 else None
            s1, s2 = get1(d, 'SYSTEMNAME1'), get1(d, 'SYSTEMNAME2')
            if nm_ok(s2) and p2:
                f2n.setdefault(p2, s2)
            if nm_ok(s1) and p1:
                f1n.setdefault(p1, s1)
        self.f1_names, self.f2_names = f1n, f2n

        for u in self.children:
            self.children[u].sort(key=lambda x: _natkey(self.disp_raw(x)))

        # 根：project.cbm 的 SUBSYSTEM* → F1
        self.roots = []
        if 'project' in self.nodes:
            for k, v in self.nodes['project'].items():
                if k.upper().startswith('SUBSYSTEM') and v.endswith('.cbm') \
                        and v[:-4] in self.nodes:
                    self.roots.append(v[:-4])

        # 工程名（F1 的 fam）
        self.proj_name = os.path.basename(root_dir.rstrip('\\/'))
        for f1 in self.roots:
            bfv = next((v for k, v in self.nodes[f1].items()
                        if 'BASEFAMILY' in k.upper() and v.endswith('.fam')), None)
            if bfv and bfv[:-4] in fam_paths:
                for k, v in fam_kv(fam_paths[bfv[:-4]], self.bentley):
                    if re.search(r'工程中名称|工程名称|PROJECTNAME', k):
                        if '=' in v:
                            v = v.split('=')[-1]
                        if nm_ok(v):
                            self.proj_name = v
                            break

        progress('解析设备名称（并行读 fam/dev）…')
        self.display = {}
        self.build_display(progress)

        progress('建立搜索索引…')
        self.index_name = collections.defaultdict(list)   # 名称 → nodes
        self.index_guid = {}                              # IFCGUID → nodes
        for u, d in self.nodes.items():
            nm = self.disp(u)
            if nm:
                self.index_name[nm].append(u)
            g = d.get('IFCGUID')
            if g:
                self.index_guid.setdefault(g, []).append(u)

    # ---- 基础 ----
    def level(self, u):
        en = (self.nodes[u].get('ENTITYNAME') or '').upper()
        return LV_MAP.get(en, 'OTHER')

    def _fam_name(self, u):
        """BASEFAMILY → fam 的工程中名称通道（F1/F2/F3 显示名兜底）。"""
        d = self.nodes[u]
        bfv = next((v for k, v in d.items()
                    if 'BASEFAMILY' in k.upper() and v.endswith('.fam')), None)
        if bfv and bfv[:-4] in self.fam_paths:
            if bfv[:-4] not in self.fam_cache:
                self.fam_cache[bfv[:-4]] = fam_kv(self.fam_paths[bfv[:-4]], self.bentley)
            for k, v in self.fam_cache[bfv[:-4]]:
                if re.search(r'工程中名称|工程名称|设备名称|DeviceName|^Name$', k, re.I):
                    if '=' in v:
                        v = v.split('=')[-1]
                    if nm_ok(v):
                        return v
        return None

    def disp_raw(self, u):
        """树的显示名（不读 fam 的快速版，用于排序）。"""
        d = self.nodes[u]
        lv = self.level(u)
        if lv in ('F1', 'F2', 'F3'):
            n = ''
            if lv == 'F1':
                n = get1(d, 'SYSTEMNAME1') or self.f1_names.get(u) or ''
            elif lv == 'F2':
                n = get1(d, 'SYSTEMNAME2') or self.f2_names.get(u) or ''
            else:
                n = get1(d, 'SYSTEMNAME3') or ''
            if not nm_ok(n):
                n = self._fam_name(u) or ''
            if not nm_ok(n):
                n = get1(d, 'SYSTEMNAME') or ''
            if nm_ok(n):
                return n
            return '%s(%s)' % (lv, u[:8])
        return d.get('NAME') or d.get('OBJECTNAME') or u[:8]

    def f3_names(self):
        out = {}
        for u in self.nodes:
            if self.level(u) == 'F3':
                out[u] = get1(self.nodes[u], 'SYSTEMNAME3') or ''
        return out

    def build_display(self, progress=None, workers=16):
        """并行解析 F4 显示名（fam 名称通道 → dev 图元 → 随间隔）。"""
        from concurrent.futures import ThreadPoolExecutor
        f3name = self.f3_names()
        f4s = [u for u in self.nodes if self.level(u) == 'F4']
        prog = progress or (lambda m: None)
        done = [0]
        def one(u):
            return u, self.f4_name(u, f3name)
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for u, nm in ex.map(one, f4s):
                self.display[u] = nm
                done[0] += 1
                if done[0] % 1000 == 0:
                    prog('设备名称 %d/%d…' % (done[0], len(f4s)))

    def f4_name(self, u, f3name):
        """与 btv_build_v2.f4_name 同源：fam 名称通道 → dev 图元 → 随间隔。"""
        d = self.nodes[u]
        bfv = next((v for k, v in d.items()
                    if 'BASEFAMILY' in k.upper() and v.endswith('.fam')), None)
        if bfv and bfv[:-4] in self.fam_paths:
            if bfv[:-4] not in self.fam_cache:
                self.fam_cache[bfv[:-4]] = fam_kv(self.fam_paths[bfv[:-4]], self.bentley)
            for k, v in self.fam_cache[bfv[:-4]]:
                if re.search(r'工程中名称|设备名称|DeviceName|^Name$', k, re.I):
                    if '=' in v:
                        v = v.split('=')[-1]
                    if nm_ok(v):
                        return v
        omp = next((v for k, v in d.items()
                    if 'OBJECTMODELPOINTER' in k.upper() and v.endswith('.dev')), None)
        if omp and omp[:-4] in self.dev_paths:
            sym = get1(kv(self.dev_paths[omp[:-4]]), 'SYMBOLNAME')
            if nm_ok(sym):
                return sym
        # F3 祖先
        p, seen = u, set()
        while p in self.parent and p not in seen:
            seen.add(p)
            p = self.parent[p]
            if p in f3name:
                return '(随间隔)%s' % f3name[p]
        return ''

    def disp(self, u):
        if self.level(u) == 'F4':
            return self.display.get(u) or self.disp_raw(u)
        return self.disp_raw(u)

    def attrs(self, u):
        """右侧属性表内容：[(组, 键, 值), ...]（组名即来源标记）"""
        d = self.nodes[u]
        rows = [('基本信息', '层级', self.level(u)),
                ('基本信息', 'cbm 文件', u + '.cbm')]
        for k in sorted(d):
            rows.append(('GIM·cbm 属性', k, d[k]))
        bfv = next((v for k, v in d.items()
                    if 'BASEFAMILY' in k.upper() and v.endswith('.fam')), None)
        if bfv and bfv[:-4] in self.fam_paths:
            if bfv[:-4] not in self.fam_cache:
                self.fam_cache[bfv[:-4]] = fam_kv(self.fam_paths[bfv[:-4]], self.bentley)
            for k, v in self.fam_cache[bfv[:-4]]:
                rows.append(('GIM·fam 族属性(%s)' % bfv, k, v))
        omp = next((v for k, v in d.items()
                    if 'OBJECTMODELPOINTER' in k.upper() and v.endswith('.dev')), None)
        if omp and omp[:-4] in self.dev_paths:
            for k, v in sorted(kv(self.dev_paths[omp[:-4]]).items()):
                rows.append(('GIM·dev 图元(%s)' % omp, k, v))
        return rows

    def search(self, text):
        """返回命中的节点列表。支持 name:xx / guid:xx / ifcguid:xx。"""
        text = text.strip()
        if not text:
            return []
        m = re.match(r'(?i)^(guid|ifcguid|name)[:：]\s*(.+)$', text)
        if m:
            mode, q = m.group(1).lower(), m.group(2).strip()
        else:
            mode, q = None, text
        if mode == 'name':
            return [u for u in self.index_name if q.lower() in u.lower()]
        if mode == 'guid' or (mode is None and re.fullmatch(r'[0-9A-Fa-f-]{8,}', text)):
            return [u for u in self.nodes if u.lower().startswith(q.lower())]
        if mode == 'ifcguid':
            hits = list(self.index_guid.get(q, []))
            if not hits:   # 前缀匹配
                hits = [u for g, us in self.index_guid.items()
                        if g.startswith(q) for u in us]
            return hits
        # 默认：名称包含 + IFCGUID 精确 + 属性包含
        out = set(u for u in self.index_name if text.lower() in u.lower())
        out.update(self.index_guid.get(text, []))
        if len(text) >= 3:
            for u, d in self.nodes.items():
                for k, v in d.items():
                    if text.lower() in v.lower():
                        out.add(u)
                        break
        return sorted(out, key=lambda x: _natkey(self.disp(x)))

    def stats(self):
        c = collections.Counter(self.level(u) for u in self.nodes)
        return c

    def ifc_source(self, u):
        """由 IFCFILE 属性解析 IFC 文件路径；返回 (path, 原始值)。"""
        ff = self.nodes[u].get('IFCFILE') or ''
        if not ff:
            return None, ''
        stem = ff[:-4] if ff.lower().endswith('.ifc') else ff
        path = (self.ifc_paths.get(stem)
                or self.ifc_paths.get(stem.lower())
                or self.ifc_paths.get(os.path.basename(stem).lower()))
        return path, ff

    def ifc_entity_rows(self, u, lookup):
        """选中节点挂接 IFCGUID 时，查 IFC 实体属性行；无挂接返回 None。"""
        g = self.nodes[u].get('IFCGUID')
        if not g:
            return None
        path, ff = self.ifc_source(u)
        if not path:
            return [('IFC 实体', 'IFCGUID', g),
                    ('IFC 实体', '源 IFC 文件',
                     '%s（目录内未找到该文件）' % (ff or '未登记'))]
        return lookup.find(path, g) or [
            ('IFC 实体', 'IFCGUID', g),
            ('IFC 实体', '源 IFC 文件', ff),
            ('IFC 实体', '结果', '该 IFC 文件中未找到此 GUID 的实体')]

    def ifc_reverse_rows(self, u, lookup):
        """反向关联行（楼层/类型/属性集/材料）；无挂接返回 None。"""
        g = self.nodes[u].get('IFCGUID')
        if not g:
            return None
        path, _ff = self.ifc_source(u)
        if not path:
            return None
        return lookup.reverse_rows(path, g)


