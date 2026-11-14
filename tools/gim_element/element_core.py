# -*- coding: utf-8 -*-
"""element_core —— GIM 统一工程实体库解析核心（无 UI 依赖，可 CLI 调用）

输入：.gim 文件（GIMPKGS / GIMPKGT / 裸 7z / zip）或已解包目录
输出：设备 / 装置性材料 / 构件 / 其他 四组实体台账

两条轨道（口径与《变电设备类型盘点》《变电DEV实体类型盘点》
《变电IFC实体类型盘点》《模型划分与实体解耦思路》一致）：
  dev 轨道  CBM 树节点 OBJECTMODELPOINTER → DEV。设备身份由 DEV 本体决定，
            与 F2/F3/F4 层级无关；变压器 = 本体 + 散热器 + 中性点成套装置，
            中性点成套装置虽是独立 F4/DEV，但并入主变压器、不单独计台；
            主变保护柜/测控柜/智能柜/电能表柜按目录归 15 二次设备（2026-10-31）；
            「设备_部件」式命名按父设备上卷；PI(PARTINDEX) 计材料实例与
            箱柜类独立设备（端子箱/汇控柜/机构箱等），其余对内封装。
  ifc 轨道  包内 *.ifc 只识别暴露层（空间骨架 / 产品实体），
            挂载层（几何 / 属性 / 材料 / 样式）与关系层对内封装，
            只计一条总数，不作为实体列出。

三分口径：两轨共用 devtype_class.three_way() 与同一张词表——
  设备       通用设备目录 2018+2025 并集 19 类；
  装置性材料 造价口径 9 大类（导线/母线/金具/绝缘子/电缆/接地材料/套管/槽盒/其他材料）；
  构件       4 大类 28 子类（建筑本体 / 结构构架与基础 / 水工与总图 / 附属设施），
             部件（灯端子板 / 接线盒 / 支架立柱）并入父件不单独计量；
  其他       词域外（无法识别 / 尺寸占位 / 几何壳名 / 分组容器 / 间隔名）、
             空间骨架、型号模板、端口与系统、ifc 无名称产品实体。

标准化层（entity_std，标准见同目录 01/02/03 三份 .md）：
  编码   E01–E19 / E-T（设备）、M01–M09（材料）、C-A1…C-D6（构件）、U-*（其他）；
  状态   已确认 / 候选 / 未确认 —— 不按来源轨道分，按目录映射的证据强度分；
  粒度   紧固件不进构件实体（记内部来源）；只有变压器类型、无主变/站用证据落 E-T。

方言兼容（2026-10-31 修）：
  ① 文件与指针的 GUID 大小写不统一（s01 小写、s03 大写），索引与查找一律按小写，
     否则整站名称解析全落空、设备报 0 台；
  ② IFC Name 的中文有两种转义：整串一段（s01）与逐字一段
     '\\X2\\4EE3\\X0\\\\X2\\7406\\X0\\'（s03，PKPM），后者段间不得插空格；
     名称只取实体第 3 属性 Name，不拼接 Description / Tag。
"""
import os
import re
import json
import shutil
import tempfile
import threading
import time
import collections
from concurrent.futures import ThreadPoolExecutor

import devtype_class as C
import entity_std as S

# ---------------------------------------------------------------------------
# 分组与轨道
# ---------------------------------------------------------------------------
G_DEV, G_MAT, G_STR, G_OTH = '设备', '装置性材料', '构件', '其他'
T_DEV, T_IFC = 'dev', 'ifc'
TRACK_NAME = {T_DEV: 'dev 轨道', T_IFC: 'ifc 轨道'}

# IFC 侧同名异物排除词（与 03-模型渲染/mat_ifc_cls.py 同一张表）
EXCL = {
    '电缆': re.compile(r'电缆隧道|电缆沟|电缆支架|电缆桥架|电缆井|电缆竖井|电缆埋管|'
                       r'电缆保护管|电缆清册|电缆防火'),
    # 「导线类型」「母线矩形标准/单相组导线」本身就是导线，不能因含「类型 / 母线」被排除
    # （2026-11-03 用户口径：U-EXCL 里的导线类应回 M01）。只排除真正异物的支架/金具。
    '导线': re.compile(r'配电箱|线夹|软导线穿墙|'
                       r'母线支架|母线桥架|母线金具|母线伸缩|母线固定|母线支撑'),
    '母线': re.compile(r'母线支架|母线桥架'),
    '金具': re.compile(r'金具基础|金具支架|金具房'),
    '绝缘子': re.compile(r'绝缘子基础|绝缘子支架|绝缘子包装'),
    '接地材料': re.compile(r'接地电阻|接地端子|接地开关|接地刀'),
}

# 型号代号兜底：名称归一后仍是纯型号（LW36-72.5、GW7B-252、JW10-252）时，
# 按国标型号命名惯例映射（L—SF6、W—户外；G—隔离开关；J—接地开关；
# Z—真空 / D—多油 / ZW—户外真空，均落在断路器）。仅词域外时使用。
MODEL_CODE = [
    (re.compile(r'^(lw|zn|zw|dw|vd|vs)\d', re.I), '断路器'),
    (re.compile(r'^gw\d', re.I), '隔离开关'),
    (re.compile(r'^jw\d', re.I), '接地开关'),
]


def model_code_fallback(name):
    for pat, cat in MODEL_CODE:
        if pat.match(name or ''):
            return cat
    return None

# ---------------------------------------------------------------------------
# kv 文本读取（cbm / dev / phm / fam）
# ---------------------------------------------------------------------------
def read_kv(path):
    """cbm / dev / phm：key=value 行文本，跳过 [节] 与 ; 注释。"""
    d = {}
    try:
        with open(path, encoding='utf-8-sig', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('[') or line.startswith(';'):
                    continue
                if '=' in line:
                    k, v = line.split('=', 1)
                    d[k.strip()] = v.strip()
    except OSError:
        pass
    return d


def read_fam(path):
    """fam：有序 (k, v) 列表（保留重复键）。"""
    out = []
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip().lstrip('\ufeff')
                if not line or (line.startswith('[') and line.endswith(']')):
                    continue
                if '=' in line:
                    k, v = line.split('=', 1)
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


def _split_eq(v):
    return v.split('=')[-1] if '=' in v else v


# ---------------------------------------------------------------------------
# 台账（聚合容器）
# ---------------------------------------------------------------------------
CAP_SAMPLES = 400          # 每个桶保留的名称样本上限
CAP_FILES = 40             # 每个桶保留的来源文件数上限


class Ledger:
    """(组, 类别, 子类, 模板) → dev/ifc 两轨计数 + 名称样本 + 来源文件。"""

    def __init__(self):
        self.buckets = {}

    def add(self, track, group, cat, sub, template, name, srcfile, ifctype='',
            status=None):
        key = (group, cat, sub or '', template or '')
        b = self.buckets.get(key)
        if b is None:
            b = self.buckets[key] = {'dev': 0, 'ifc': 0,
                                     'samples': [], 'files': collections.Counter(),
                                     'st': collections.Counter(), 'std_sub': ''}
        b[track] += 1
        st = status or S.status_of(track, group, cat, name, sub)
        b['st'][st] += 1
        if group == G_DEV and name and not b['std_sub']:
            b['std_sub'] = S.dev_sub(cat, name)[0]
        if name and len(b['samples']) < CAP_SAMPLES:
            b['samples'].append([track, name[:120], os.path.basename(srcfile or ''),
                                 ifctype or '', st])
        if srcfile and (len(b['files']) < CAP_FILES or srcfile in b['files']):
            b['files'][srcfile] += 1

    # ---- 收尾：宿主不明的组成改挂待归整体（标准 02 §2）----
    def settle_orphans(self):
        """主变附件（中性点成套装置）若没有任何主变宿主，改挂「待归整体」。

        标准 02 §2：中性点装置属于主变组成，但「属于哪台主变」需要实例证据；
        宿主不明时进入待归整体集合，不能直接挂在主变压器名下充数。
        """
        host = any(k[0] == G_DEV
                   and k[1] in ('主变压器', '变压器（用途待确认）')
                   and k[2] != '附件（并入本体）'
                   and (b['dev'] + b['ifc']) > 0 for k, b in self.buckets.items())
        if host:
            return
        for k in list(self.buckets):
            if k[0] == G_DEV and k[1] == '主变压器' and k[2] == '附件（并入本体）':
                b = self.buckets.pop(k)
                nk = (G_OTH, '待归整体（中性点装置）', '', k[3])
                if nk in self.buckets:
                    self.buckets[nk]['dev'] += b['dev']
                    self.buckets[nk]['ifc'] += b['ifc']
                    self.buckets[nk]['st'].update(b['st'])
                    self.buckets[nk]['samples'].extend(b['samples'])
                else:
                    b['st'] = collections.Counter({S.ST_CAND: b['dev'] + b['ifc']})
                    self.buckets[nk] = b

    # ---- 汇总 ----
    def group_count(self, group, track=None):
        n = 0
        for (g, _c, _s, _t), b in self.buckets.items():
            if g == group:
                n += b[track] if track else (b['dev'] + b['ifc'])
        return n

    def to_rows(self):
        rows = []
        for (g, cat, sub, tpl), b in self.buckets.items():
            code, stdcat = S.code_of(g, cat, sub)
            rows.append({
                'group': g, 'cat': cat, 'sub': sub, 'template': tpl,
                'code': code, 'stdcat': stdcat, 'std_sub': b['std_sub'],
                'dev': b['dev'], 'ifc': b['ifc'],
                'total': b['dev'] + b['ifc'],
                'st': dict(b['st']),
                'samples': b['samples'],
                'files': [[k, v] for k, v in b['files'].most_common()],
            })
        rows.sort(key=lambda r: (G_DEV, G_MAT, G_STR, G_OTH).index(r['group'])
                  if r['group'] in (G_DEV, G_MAT, G_STR, G_OTH) else 9)
        return rows


# ---------------------------------------------------------------------------
# 容器解包（与 gim_device/gim_core.unpack 同源）
# ---------------------------------------------------------------------------
MAGIC_7Z = b'7z\xbc\xaf\x27\x1c'


def sniff(path):
    with open(path, 'rb') as f:
        head = f.read(8)
    magic = head.rstrip(b'\x00')
    if magic.startswith(b'GIMPKG'):
        return 'gimpkg'
    if head.startswith(MAGIC_7Z):
        return 'raw7z'
    if head.startswith(b'PK'):
        return 'zip'
    return 'unknown'


def unpack(path, out_dir):
    """把 .gim 解开到 out_dir，返回 (kind, note)。"""
    kind = sniff(path)
    os.makedirs(out_dir, exist_ok=True)
    if kind == 'zip':
        import zipfile
        with zipfile.ZipFile(path) as z:
            z.extractall(out_dir)
        return kind, ''
    if kind == 'gimpkg':
        with open(path, 'rb') as f:
            buf = f.read(8192)
        off = buf.find(MAGIC_7Z)
        if off < 0:
            raise ValueError('未找到 7z 签名，容器可能损坏或加密')
        payload = os.path.join(out_dir, '_payload.7z')
        with open(path, 'rb') as f, open(payload, 'wb') as o:
            f.seek(off)
            shutil.copyfileobj(f, o)
        src = payload
    elif kind == 'raw7z':
        src = path
    else:
        raise ValueError('无法识别的容器格式（既非 GIMPKGS 头也非 7z/zip）')
    import py7zr
    with py7zr.SevenZipFile(src) as z:
        if z.needs_password():
            raise ValueError('压缩包已加密，暂不支持')
        z.extractall(out_dir)
    if kind == 'gimpkg':
        try:
            os.remove(payload)
        except OSError:
            pass
    return kind, ''


# ---------------------------------------------------------------------------
# dev 轨道：CBM 树 → 带 OBJECTMODELPOINTER 的设备位 → 词域分类
# ---------------------------------------------------------------------------
class DevTrack:
    """扫描一棵 CBM 树（工程）或散装 dev（单体设备包）。"""

    def __init__(self, root, ledger, progress=None):
        self.root = root
        self.ledger = ledger
        self.prog = progress or (lambda m: None)
        self.stats = collections.Counter()

        # 索引键统一小写：s01 文件名是 32 位小写 GUID，s03 是 32 位大写 GUID，
        # 而 cbm/dev 里的指针（OBJECTMODELPOINTER / BASEFAMILY）大小写随导出器，
        # 一律按小写建索引、按小写查找，否则整站名称解析全部落空（2026-10-31 s03）。
        cbm, fam, dev = {}, {}, {}
        self.disp = {}                       # 小写 stem → 原始文件名 stem（展示用）
        for base, _dirs, files in os.walk(root):
            for fn in files:
                stem, ext = os.path.splitext(fn)
                low = ext.lower()
                p = os.path.join(base, fn)
                key = stem.lower()
                if low == '.cbm':
                    cbm[key] = p
                elif low == '.fam':
                    fam[key] = p
                elif low == '.dev':
                    dev[key] = p
                else:
                    continue
                self.disp.setdefault(key, stem)
        self.fam_paths, self.dev_paths = fam, dev
        self.fam_cache = {}
        self.dev_cache = {}
        self.stats['cbm文件'] = len(cbm)
        self.stats['fam文件'] = len(fam)
        self.stats['dev文件'] = len(dev)

        if not cbm:
            self._fallback_root_devs()
            return

        # 并行读 cbm（文件 IO 远大于解析耗时，16 线程与 gim_info 同策略）
        self.prog('读取 cbm（%d 个）…' % len(cbm))
        self.nodes = {}
        done = [0]
        lock = threading.Lock()

        def _read(item):
            u, p = item
            r = (u, read_kv(p))
            with lock:
                done[0] += 1
                if done[0] % 2000 == 0:
                    self.prog('读取 cbm %d/%d…' % (done[0], len(cbm)))
            return r

        with ThreadPoolExecutor(max_workers=16) as ex:
            for u, d in ex.map(_read, cbm.items()):
                self.nodes[u] = d

        self.parent = {}
        for u, d in self.nodes.items():
            for k, v in d.items():
                ku = k.upper()
                if (ku.startswith('SUBSYSTEM') or ku.startswith('SUBDEVICE')) \
                        and v.endswith('.cbm') and v[:-4].lower() in self.nodes:
                    self.parent[v[:-4].lower()] = u

        # F3 名（供「随间隔」兜底）
        self.f3name = {}
        for u, d in self.nodes.items():
            en = (d.get('ENTITYNAME') or '').upper()
            if en == 'F3SYSTEM':
                s = get1(d, 'SYSTEMNAME3')
                if nm_ok(s):
                    self.f3name[u] = s

        # 收集设备位：带 OBJECTMODELPOINTER 的节点。层级不限，但分两路：
        #   F2/F3/F4 —— 设备与实体位（与层级无关，设备身份由 DEV 本体决定）
        #   PI(PARTINDEX) —— 装配内部部件：只把「装置性材料」实例计入材料台账
        #                    （口径同 mat_dev.py：材料实例 F4+PI 都计），
        #                    设备/构件等其他 PI 部件对内封装、不单独计
        targets = []
        for u, d in self.nodes.items():
            en = (d.get('ENTITYNAME') or '').upper()
            omp = next((v for k, v in d.items()
                        if 'OBJECTMODELPOINTER' in k.upper() and v.endswith('.dev')), None)
            if not omp:
                continue
            is_pi = (en == 'PARTINDEX')
            targets.append((u, omp, is_pi))
            self.stats['PI部件dev' if is_pi else 'dev位'] += 1

        # 构件部件归并（《变电DEV实体类型盘点》§5.3）：父 DEV 的 SUBDEVICEn 指向的
        # 子 DEV 若也占一个 dev 位，它只是父件的部件（灯端子板 / 支架立柱），不上计。
        self.dev_parent = {}
        stems = {omp[:-4].lower() for _u, omp, pi in targets if not pi}
        for _u, omp, is_pi in targets:
            if is_pi:
                continue
            stem = omp[:-4].lower()
            for k, v in self._dev_kv(omp).items():
                if k.upper().startswith('SUBDEVICE') and v.lower().endswith('.dev'):
                    child = v[:-4].lower()
                    if child in stems and child != stem:
                        self.dev_parent[child] = stem

        # 并行解析名称 + 分类
        self.prog('解析 %d 个 dev 位…' % len(targets))
        done2 = [0]

        def _one(item):
            r = self._resolve(item)
            with lock:
                done2[0] += 1
                if done2[0] % 1000 == 0:
                    self.prog('解析 dev 位 %d/%d…' % (done2[0], len(targets)))
            return r

        with ThreadPoolExecutor(max_workers=16) as ex:
            for row in ex.map(_one, targets):
                self._classify(row)

    # ---- 名称解析：节点 fam 通道 → dev 的 fam 设计参数 → dev SYMBOLNAME → 随间隔 ----
    def _fam_name(self, u):
        d = self.nodes[u]
        bfv = next((v for k, v in d.items()
                    if 'BASEFAMILY' in k.upper() and v.endswith('.fam')), None)
        if bfv and bfv[:-4].lower() in self.fam_paths:
            return self._fam_channel(bfv[:-4].lower())
        return None

    def _fam_channel(self, fam_stem):
        """fam 的名称通道：工程中名称 / 设备名称 / DeviceName / Name。"""
        fam_stem = (fam_stem or '').lower()
        if fam_stem not in self.fam_cache:
            p = self.fam_paths.get(fam_stem)
            self.fam_cache[fam_stem] = read_fam(p) if p else []
        for k, v in self.fam_cache[fam_stem]:
            if re.search(r'工程中名称|设备名称|DeviceName|^Name$', k, re.I):
                v = _split_eq(v)
                if nm_ok(v):
                    return v
        return None

    def _dev_kv(self, dev_name):
        key = (dev_name or '')[:-4].lower()
        if key not in self.dev_cache:
            p = self.dev_paths.get(key)
            self.dev_cache[key] = read_kv(p) if p else {}
        return self.dev_cache[key]

    def _dev_fam_name(self, dev_kv):
        """DEV 自身 BASEFAMILY 的 fam 设计参数（2025 目录包：设备名在这里）。"""
        bfv = next((v for k, v in dev_kv.items()
                    if 'BASEFAMILY' in k.upper() and v.endswith('.fam')), None)
        if bfv and bfv[:-4].lower() in self.fam_paths:
            return self._fam_channel(bfv[:-4])
        return None

    def _resolve(self, item):
        u, omp, is_pi = item
        d = self.nodes[u]
        dev_kv = self._dev_kv(omp)
        # 层级归属：向上找最近 F3（「随间隔」标注）
        f3 = ''
        p, seen = u, set()
        while p in self.parent and p not in seen:
            seen.add(p)
            p = self.parent[p]
            if p in self.f3name:
                f3 = self.f3name[p]
                break
        return {
            'is_pi': is_pi,
            'name': self._fam_name(u) or self._dev_fam_name(dev_kv)
                    or (dev_kv.get('SYMBOLNAME') if nm_ok(dev_kv.get('SYMBOLNAME')) else None) or '',
            'dev_type': dev_kv.get('TYPE') or dev_kv.get('DEVICETYPE') or '',
            'f3': f3,
            'cbm': os.path.basename(self.disp.get(u, u) + '.cbm'),
            'raw': d.get('NAME') or d.get('OBJECTNAME') or '',
            'is_part_child': omp[:-4].lower() in self.dev_parent,
        }

    # ---- 分类入账：设备 / 装置性材料 / 构件（4 大类 28 子类）/ 词域外 ----
    def _classify(self, row):
        name = row['name'] or row['raw']
        srcfile = row['cbm']
        if not nm_ok(name):
            name = row['raw']
        if not name:
            self.stats['未命名dev位'] += 1
            return
        # 紧固件（螺栓/螺母/垫圈…）：标准 03 §3 —— 不因独立暴露就新建工程实体，
        # 只记内部来源。但「独立基础地脚螺栓」这类名称中心词是基础/柱等构件，
        # 仍按构件计，故只对词域外的纯紧固件降级（判定见下方 g == '词域外'）
        # 两轨同一把尺子：three_way 先设备/材料，未命中再构件 28 子类兜底
        g, c, sub, part = C.three_way(name, row['dev_type'])
        if g == '词域外' and S.is_fastener(name):
            self.ledger.add(T_DEV, G_OTH, '内部来源（紧固件）', '',
                            C.template(name), name, srcfile, status=S.ST_UNC)
            self.stats['紧固件(内部来源)'] += 1
            return
        weak = False                     # 仅靠型号代号判类 → 候选
        if g == '词域外' and not row['is_pi']:
            mc = model_code_fallback(name)
            if mc:
                g, c, sub = '设备', mc, ''
                weak = True
        # 只有「变压器」类型、没有主变/站用用途证据 → E-T 候选（标准 02 §1）
        if g == '设备' and c == '主变压器' and S.transformer_unresolved(name):
            c = '变压器（用途待确认）'
        if row['is_pi']:
            # PI 部件：装置性材料实例进材料台账（口径同 mat_dev.py：F4+PI 都计）；
            # 箱柜类独立设备（端子箱/汇控柜/机构箱/电源切换箱/电缆终端箱…）有独立
            # 子装配身份（自己的 .dev + OMP），按标准 02 §2 不吞入母体，计 E16/E17；
            # 其余（断路器/隔离开关/CT 等装配内部部件）对内封装
            if g == '装置性材料':
                self.ledger.add(T_DEV, G_MAT, c, sub or '本体', C.template(name),
                                name, srcfile)
                self.stats['PI材料实例'] += 1
            elif g == '设备' and re.search(r'[箱柜]$', name):
                self.ledger.add(T_DEV, G_DEV, c, '', C.template(name), name, srcfile)
                self.stats['PI箱柜设备'] += 1
            else:
                self.stats['PI封装(非材料)'] += 1
            return
        if g == '设备':
            if C.is_attachment(name):
                # 中性点成套装置等：并入主变压器，不单独计台
                self.ledger.add(T_DEV, G_DEV, '主变压器', '附件（并入本体）',
                                C.template(name), name, srcfile)
                self.stats['主变附件'] += 1
                return
            head, ispart = C.split_part(name)
            if ispart:
                gh, ch, _sh, _ph = C.three_way(head, row['dev_type'])
                if gh == '设备':
                    # 「设备_部件」式命名：上卷到父设备，不单独计台
                    self.ledger.add(T_DEV, G_DEV, ch, '部件（上卷）',
                                    C.template(head), name, srcfile)
                    self.stats['部件上卷'] += 1
                    return
            self.ledger.add(T_DEV, G_DEV, c, '', C.template(name), name, srcfile,
                            status=S.ST_CAND if weak else None)
        elif g == '装置性材料':
            self.ledger.add(T_DEV, G_MAT, c, sub or '本体', C.template(name), name, srcfile)
        elif g == '构件':
            # 部件归并：灯端子板 / 接线盒 / 支架立柱等挂在父件上，不单独计量
            if part or row.get('is_part_child'):
                self.ledger.add(T_DEV, G_STR, '部件（并入父件）', c,
                                C.template(name), name, srcfile)
                self.stats['构件部件'] += 1
            else:
                self.ledger.add(T_DEV, G_STR, c, sub, C.template(name), name, srcfile)
        else:
            self.ledger.add(T_DEV, G_OTH, c or '未识别', '', C.template(name), name,
                            srcfile, status=S.ST_UNC)
            self.stats['词域外'] += 1

    # ---- 单体设备包兜底（2018 裸包：无 CBM，只有 dev 装配链）----
    def _fallback_root_devs(self):
        if not self.dev_paths:
            return
        self.prog('无 CBM 树，按单体设备包解析根 DEV…')
        referenced = set()
        kv_of = {}
        for stem, p in self.dev_paths.items():
            d = read_kv(p)
            kv_of[stem] = d
            for k, v in d.items():
                ku = k.upper()
                if ku.startswith('SUBDEVICE') and v.lower().endswith('.dev'):
                    referenced.add(v[:-4].lower())
        roots = [s for s in kv_of if s.lower() not in referenced]
        if not roots:
            roots = list(kv_of)[:1]
        for stem in roots:
            d = kv_of[stem]
            name = ''
            bfv = next((v for k, v in d.items()
                        if 'BASEFAMILY' in k.upper() and v.endswith('.fam')), None)
            if bfv and bfv[:-4].lower() in self.fam_paths:
                for k, v in read_fam(self.fam_paths[bfv[:-4].lower()]):
                    if re.search(r'工程中名称|设备名称|DeviceName|^Name$', k, re.I):
                        v = _split_eq(v)
                        if nm_ok(v):
                            name = v
                            break
            if not nm_ok(name):
                name = d.get('SYMBOLNAME') or ''
            if not nm_ok(name):
                name = os.path.basename(self.root.rstrip('\\/'))
            dtype = d.get('TYPE') or d.get('DEVICETYPE') or ''
            g, c, sub, part = C.three_way(name, dtype)
            if g == '词域外' and S.is_fastener(name):
                self.ledger.add(T_DEV, G_OTH, '内部来源（紧固件）', '',
                                C.template(name), name, stem + '.dev', status=S.ST_UNC)
                self.stats['紧固件(内部来源)'] += 1
                continue
            if g == '设备' and c == '主变压器' and S.transformer_unresolved(name):
                c = '变压器（用途待确认）'
            if g == '设备' and C.is_attachment(name):
                self.ledger.add(T_DEV, G_DEV, '主变压器', '附件（并入本体）',
                                C.template(name), name, stem + '.dev')
                self.stats['主变附件'] += 1
            elif g == '装置性材料':
                self.ledger.add(T_DEV, G_MAT, c, sub or '本体', C.template(name),
                                name, stem + '.dev')
            elif g == '构件':
                self.ledger.add(T_DEV, G_STR,
                                '部件（并入父件）' if part else c,
                                c if part else sub, C.template(name), name, stem + '.dev')
            else:
                self.ledger.add(T_DEV, G_DEV if g == '设备' else G_OTH, c, '',
                                C.template(name), name, stem + '.dev')
            self.stats['dev位'] += 1


# ---------------------------------------------------------------------------
# ifc 轨道：流式扫描暴露层，挂载/关系层对内封装
# ---------------------------------------------------------------------------
# 构件标准类 → 构件子类（实例；依据《变电IFC实体类型盘点》§5.2/5.3）
IFC_ELEM_CAT = {
    'IFCWALLSTANDARDCASE': '墙', 'IFCWALL': '墙', 'IFCCURTAINWALL': '墙',
    'IFCSLAB': '板与屋面', 'IFCROOF': '板与屋面', 'IFCCOVERING': '板与屋面',
    'IFCBEAM': '梁', 'IFCCOLUMN': '柱',
    'IFCOPENINGELEMENT': '门窗与洞口', 'IFCWINDOW': '门窗与洞口', 'IFCDOOR': '门窗与洞口',
    'IFCSTAIR': '楼梯与坡道', 'IFCSTAIRFLIGHT': '楼梯与坡道',
    'IFCRAMP': '楼梯与坡道', 'IFCRAMPFLIGHT': '楼梯与坡道',
    'IFCPILE': '基础', 'IFCFOOTING': '基础',
    'IFCMECHANICALFASTENER': '钢结构与钢筋', 'IFCMEMBER': '钢结构与钢筋',
    'IFCPLATE': '钢结构与钢筋', 'IFCREINFORCINGBAR': '钢结构与钢筋',
    'IFCFASTENER': '钢结构与钢筋', 'IFCREINFORCINGMESH': '钢结构与钢筋',
    'IFCTENDONANCHOR': '钢结构与钢筋',
    'IFCELEMENTASSEMBLY': '分组与装配',
    'IFCFURNISHINGELEMENT': '其他建筑构件', 'IFCRAILING': '其他建筑构件',
    'IFCTRANSPORTELEMENT': '其他建筑构件', 'IFCBUILDINGELEMENTPART': '其他建筑构件',
    'IFCTYPEPRODUCT': '其他建筑构件', 'IFCDISCRETEACCESSORY': '其他建筑构件',
    'IFCBUILDINGELEMENTPROXY': '兜底（Proxy）',
    'IFCFLOWSEGMENT': '机电·管段与管件', 'IFCFLOWFITTING': '机电·管段与管件',
    'IFCDUCTSEGMENT': '机电·管段与管件', 'IFCPIPESEGMENT': '机电·管段与管件',
    'IFCCABLESEGMENT': '机电·管段与管件', 'IFCCABLECARRIERSEGMENT': '机电·管段与管件',
    'IFCPIPEFITTING': '机电·管段与管件', 'IFCDUCTFITTING': '机电·管段与管件',
    'IFCCABLECARRIERFITTING': '机电·管段与管件',
    'IFCFLOWTERMINAL': '机电·终端与设备', 'IFCFLOWCONTROLLER': '机电·终端与设备',
    'IFCFLOWMOVINGDEVICE': '机电·终端与设备', 'IFCFLOWSTORAGEDEVICE': '机电·终端与设备',
    'IFCDISTRIBUTIONCONTROLELEMENT': '机电·终端与设备',
    'IFCDISTRIBUTIONELEMENT': '机电·终端与设备', 'IFCELECTRICAPPLIANCE': '机电·终端与设备',
    'IFCTANK': '机电·终端与设备', 'IFCLIGHTFIXTURE': '机电·终端与设备',
    'IFCAIRTERMINAL': '机电·终端与设备', 'IFCSANITARYTERMINAL': '机电·终端与设备',
    'IFCFIRESUPPRESSIONTERMINAL': '机电·终端与设备', 'IFCOUTLET': '机电·终端与设备',
    'IFCSWITCHINGDEVICE': '机电·终端与设备', 'IFCJUNCTIONBOX': '机电·终端与设备',
    'IFCVALVE': '机电·终端与设备', 'IFCPUMP': '机电·终端与设备', 'IFCFAN': '机电·终端与设备',
    'IFCALARM': '机电·终端与设备', 'IFCSENSOR': '机电·终端与设备',
    'IFCDISTRIBUTIONBOARD': '机电·终端与设备', 'IFCMOTORCONNECTION': '机电·终端与设备',
    'IFCENERGYCONVERSIONDEVICE': '机电·终端与设备', 'IFCTRANSFORMER': '机电·终端与设备',
    'IFCELECTRICDISTRIBUTIONPOINT': '机电·终端与设备',
}
IFC_SPATIAL = {
    'IFCPROJECT': '工程', 'IFCSITE': '场地', 'IFCBUILDING': '建筑',
    'IFCBUILDINGSTOREY': '楼层', 'IFCSPACE': '空间',
}
IFC_PORTSYS = {'IFCDISTRIBUTIONPORT': '端口', 'IFCPORT': '端口', 'IFCSYSTEM': '系统'}
IFC_OTHER = {'IFCGROUP': '分组', 'IFCANNOTATION': '标注'}

# 类型信息表：bytes 键（每行查表，避免解码开销）
_TYPEINFO = {}
for _t, _c in IFC_ELEM_CAT.items():
    _TYPEINFO[_t.encode()] = ('elem', _c)
    _TYPEINFO[(_t + 'TYPE').encode()] = ('template', _c)
for _t, _c in IFC_SPATIAL.items():
    _TYPEINFO[_t.encode()] = ('spatial', _c)
for _t, _c in IFC_PORTSYS.items():
    _TYPEINFO[_t.encode()] = ('portsys', _c)
for _t, _c in IFC_OTHER.items():
    _TYPEINFO[_t.encode()] = ('other', _c)
_TYPEINFO[b'IFCDOORSTYLE'] = ('template', '门窗与洞口')
_TYPEINFO[b'IFCWINDOWSTYLE'] = ('template', '门窗与洞口')

X2S = re.compile(rb'\\X2\\([0-9A-Fa-f]+)\\X0\\')
QF = re.compile(rb"'((?:[^']|'')*)'")
PROG_STEP = 500000                            # 每多少行报一次进度


def _x2(m):
    try:
        return bytes.fromhex(m.group(1).decode('ascii')).decode('utf-16-be', 'ignore')
    except Exception:
        return ''


CJK = re.compile(r'[\u3400-\u9fff]')


def _decode_x2_field(f):
    """把一个引号字段内的 \\X2\\..\\X0\\ 段就地解码（相邻段直接相连，不加分隔符）。

    s03 导出器把每个汉字各包一段：'\\X2\\4EE3\\X0\\\\X2\\7406\\X0\\...' = 「代理构件」。
    段间若插空格，名称变「代 理 构 件」，词表按中心词匹配会全部落空（2026-10-31）。
    """
    parts, pos = [], 0
    for m in X2S.finditer(f):
        parts.append(f[pos:m.start()].decode('utf-8', 'ignore'))
        parts.append(_x2(m))
        pos = m.end()
    parts.append(f[pos:].decode('utf-8', 'ignore'))
    return ''.join(parts)


def line_name(line):
    """提取 IFC 产品行的中文名。

    取实体的第 3 个属性（`Name`）——《变电IFC实体类型盘点》§6：「不能把行内所有
    `\\X2\\` 片段拼起来，那会把 Description / Tag 也当名字」。`Name` 为空或 `$` 时
    才退回「含中文的字段」，仍为空即无名称产品实体。
    """
    if not line:
        return ''
    fields = []
    for i, f in enumerate(QF.findall(line)):
        if i == 0 and len(f) == 22:          # GlobalId
            continue
        s = _decode_x2_field(f).replace("''", "'").strip()
        fields.append('' if s == '$' else s)
    if not fields:
        return ''
    if fields[0]:                            # 第 3 属性 = Name（含型钢截面等纯 ASCII 名）
        return fields[0][:120]
    for s in fields[1:]:
        if s and CJK.search(s):
            return s[:120]
    return ''


def scan_ifc_file(path, ledger, stats, progress=None):
    fname = os.path.basename(path)
    n_ent = n_exposed = n_encap = 0
    with open(path, 'rb') as f:
        for line in f:
            if line[:1] != b'#':
                continue
            n_ent += 1
            if progress and n_ent % PROG_STEP == 0:
                progress('IFC %s：%d 行' % (fname, n_ent))
            eq = line.find(b'=', 1)
            lp = line.find(b'(', eq + 1) if eq > 0 else -1
            if lp < 0:
                n_encap += 1
                continue
            info = _TYPEINFO.get(line[eq + 1:lp].strip())
            if info is None:
                n_encap += 1                 # 挂载层 / 关系层 / 全局层 —— 对内封装
                continue
            kind, val = info
            ifctype = line[eq + 1:lp].strip().decode('ascii', 'replace')   # IFC 实体类型
            if kind == 'template':
                ledger.add(T_IFC, G_OTH, '型号模板', val, val + '·模板', '', fname, ifctype)
                continue
            if kind == 'spatial':
                ledger.add(T_IFC, G_OTH, '空间骨架', val, val, '', fname, ifctype)
                continue
            if kind == 'portsys':
                ledger.add(T_IFC, G_OTH, '端口与系统', val, val, '', fname, ifctype)
                continue
            if kind == 'other':
                ledger.add(T_IFC, G_OTH, val, '', val, '', fname, ifctype)
                continue
            # ---- 产品实例（暴露层构件/机电/散材）----
            n_exposed += 1
            nm = line_name(line)
            if not nm:
                # 无名称产品实体：只能按 IFC 类型识别（《变电IFC实体类型盘点》§6），
                # 单列「其他·无名称」，不进构件子类统计
                ledger.add(T_IFC, G_OTH, '无名称产品实体', val, '（无名称）', '', fname, ifctype)
                continue
            g, c, sub, part = C.three_way(nm)
            # 紧固件：标准 03 §3 —— IFC 独立暴露也不新建工程实体；
            # 仅对词域外的纯紧固件降级，「独立基础地脚螺栓」这类仍按构件计
            if g == '词域外' and S.is_fastener(nm):
                ledger.add(T_IFC, G_OTH, '内部来源（紧固件）', '', C.template(nm), nm,
                           fname, ifctype, status=S.ST_UNC)
                stats['紧固件(内部来源)'] += 1
                continue
            if g == '装置性材料' and c in EXCL and EXCL[c].search(nm):
                ledger.add(T_IFC, G_OTH, '同名异物（排除词）', c, C.template(nm), nm,
                           fname, ifctype, status=S.ST_UNC)
                continue
            # 只有变压器类型、没有用途证据 → E-T 候选（标准 02 §1）
            if g == '设备' and c == '主变压器' and S.transformer_unresolved(nm):
                c = '变压器（用途待确认）'
            if g == '设备':
                ledger.add(T_IFC, G_DEV, c, '', C.template(nm), nm, fname, ifctype)
            elif g == '装置性材料':
                ledger.add(T_IFC, G_MAT, c, sub or '本体', C.template(nm), nm, fname, ifctype)
            elif g == '构件':
                if part:
                    ledger.add(T_IFC, G_STR, '部件（并入父件）', c,
                               C.template(nm), nm, fname, ifctype)
                else:
                    ledger.add(T_IFC, G_STR, c, sub, C.template(nm), nm, fname, ifctype)
            else:
                ledger.add(T_IFC, G_OTH, c or '无法识别', '', C.template(nm), nm, fname,
                           ifctype, status=S.ST_UNC)
    stats['ifc实体行'] += n_ent
    stats['ifc暴露层'] += n_exposed
    stats['ifc封装内部'] += n_encap
    progress('IFC %s 完成：%d 实体 / %d 暴露层' % (fname, n_ent, n_exposed))


def scan_ifc_track(root, ledger, progress=None):
    prog = progress or (lambda m: None)
    paths = []
    for base, _dirs, files in os.walk(root):
        for fn in files:
            if fn.lower().endswith('.ifc'):
                paths.append(os.path.join(base, fn))
    stats = collections.Counter()
    stats['ifc文件'] = len(paths)
    # 大文件先扫，进度体感更好
    paths.sort(key=lambda p: -os.path.getsize(p))
    for i, p in enumerate(paths):
        prog('IFC %d/%d：%s' % (i + 1, len(paths), os.path.basename(p)))
        scan_ifc_file(p, ledger, stats, prog)
    return stats


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------
def scan(path, progress=None, work_dir=None, cleanup=True, engine='standard'):
    """解析一个 GIM 工程或单体设备包。

    path: .gim 文件或已解包目录
    返回 result dict（可 json 化）。
    """
    prog = progress or (lambda m: None)
    t0 = time.time()
    tmp = work_dir or tempfile.mkdtemp(prefix='gimelem_')
    own = work_dir is None
    try:
        container, note = '', ''
        if os.path.isfile(path):
            prog('解包 %s…' % os.path.basename(path))
            container, note = unpack(path, tmp)
            root = tmp
        else:
            root = path

        if engine == 'standard':
            from standard_recognition import scan_standard, ledger_from_standard
            import hashlib
            scope = None
            if os.path.isfile(path):
                digest = hashlib.sha256()
                with open(path, 'rb') as source:
                    for block in iter(lambda: source.read(1024 * 1024), b''):
                        digest.update(block)
                scope = digest.hexdigest()
            prog('运行工具内置标准实体识别算法…')
            data = scan_standard(root, scope)
            result = ledger_from_standard(data)
            result['meta'] = {'source': os.path.abspath(path), 'kind': 'gim文件' if os.path.isfile(path) else '解包目录',
                              'container': container, 'containerNote': note, 'elapsed': round(time.time() - t0, 1),
                              'engine': 'independent-python', 'engineRulesVersion': data['engine']['rulesVersion'],
                              'complete': data['complete'], 'incompleteReasons': data['incompleteReasons']}
            prog('标准实体识别完成；整体 %s，待归 %s' % (result['stats']['整体'], result['stats']['待归整体']))
            return result
        if engine != 'legacy':
            raise ValueError('Unknown recognition engine: ' + engine)
        ledger = Ledger()
        stats = collections.Counter()
        prog('扫描 dev 轨道…')
        dt = DevTrack(root, ledger, prog)
        stats.update(dt.stats)
        prog('扫描 ifc 轨道…')
        stats.update(scan_ifc_track(root, ledger, prog))

        ledger.settle_orphans()
        rows = ledger.to_rows()
        totals = {}
        for g in (G_DEV, G_MAT, G_STR, G_OTH):
            totals[g] = {'dev': ledger.group_count(g, T_DEV),
                         'ifc': ledger.group_count(g, T_IFC)}
        # 设备台数：附件与部件上卷的桶不计台
        att = sum(r['dev'] + r['ifc'] for r in rows
                  if r['group'] == G_DEV and r['sub'] == '附件（并入本体）')
        part = sum(r['dev'] + r['ifc'] for r in rows
                   if r['group'] == G_DEV and r['sub'] == '部件（上卷）')
        totals[G_DEV]['附件并入'] = att
        totals[G_DEV]['部件上卷'] = part
        totals[G_DEV]['台数'] = totals[G_DEV]['dev'] + totals[G_DEV]['ifc'] - att - part

        # 证据状态（标准 02 §4）：已确认 / 候选 / 未确认，设备按台套、其余按件
        for g in (G_DEV, G_MAT, G_STR, G_OTH):
            st = collections.Counter()
            for r in rows:
                if r['group'] != g:
                    continue
                if g == G_DEV and r['sub'] in ('附件（并入本体）', '部件（上卷）'):
                    continue
                st.update(r['st'])
            totals[g]['已确认'] = st.get(S.ST_OK, 0)
            totals[g]['候选'] = st.get(S.ST_CAND, 0)
            totals[g]['未确认'] = st.get(S.ST_UNC, 0)

        elapsed = time.time() - t0
        result = {
            'meta': {
                'source': os.path.abspath(path),
                'kind': 'gim文件' if os.path.isfile(path) else '解包目录',
                'container': container, 'containerNote': note,
                'elapsed': round(elapsed, 1),
            },
            'stats': dict(stats),
            'totals': totals,
            'rows': rows,
        }
        prog('完成：用时 %.1f 秒' % elapsed)
        return result
    finally:
        if own and cleanup:
            shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# HTML 报告
# ---------------------------------------------------------------------------
_STYLE = """
body{font-family:"Microsoft YaHei",sans-serif;max-width:1080px;margin:0 auto;
padding:0 20px 50px;color:#1c1c1e;line-height:1.65;font-size:14px;background:#fff}
h1{font-size:22px;margin:26px 0 4px}h2{font-size:16px;color:#1a5fb4;margin:30px 0 8px;
padding-left:10px;border-left:4px solid #1a5fb4}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.kpi div{background:#f4f8fd;border:1px solid #c9dbf5;border-radius:10px;padding:10px 14px}
.kpi b{display:block;font-size:22px;color:#1a5fb4}
.kpi span{font-size:12px;color:#5b6472}
table{border-collapse:collapse;width:100%;font-size:12.5px;margin:10px 0}
th,td{border:1px solid #d8dee8;padding:4px 8px;text-align:left}
th{background:#f4f7fc}.n{text-align:right;font-variant-numeric:tabular-nums}
.small{font-size:12px;color:#5b6472}
"""


def build_html(result):
    from html import escape
    text = lambda value: escape(str(value), quote=True)
    m, st, tt, rows = result['meta'], result['stats'], result['totals'], result['rows']
    out = ['<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
           '<title>GIM 实体盘点报告</title><style>', _STYLE, '</style></head><body>']
    out.append('<h1>GIM 实体盘点报告</h1>')
    out.append('<p class="small">来源：%s（%s%s） · 用时 %.1f 秒 · 生成 %s</p>'
               % (text(m['source']), text(m['kind']),
                  '，容器 ' + text(m['container']) if m['container'] else '',
                  m['elapsed'], time.strftime('%Y-%m-%d %H:%M')))
    out.append('<div class="kpi">')
    out.append('<div><b>%s</b><span>设备（台，已确认 %s · 候选 %s；另附件 %s + 部件上卷 %s）</span></div>'
               % (format(tt[G_DEV]['台数'], ','),
                  format(tt[G_DEV].get('已确认', 0), ','),
                  format(tt[G_DEV].get('候选', 0), ','),
                  format(tt[G_DEV].get('附件并入', 0), ','),
                  format(tt[G_DEV].get('部件上卷', 0), ',')))
    for g, unit in ((G_MAT, '装置性材料（件）'), (G_STR, '构件（件）'), (G_OTH, '其他（条）')):
        n = tt[g]['dev'] + tt[g]['ifc']
        out.append('<div><b>%s</b><span>%s · 已确认 %s / 候选 %s / 未确认 %s</span></div>'
                   % (format(n, ','), unit, format(tt[g].get('已确认', 0), ','),
                      format(tt[g].get('候选', 0), ','),
                      format(tt[g].get('未确认', 0), ',')))
    out.append('</div>')
    out.append('<p class="small">dev 轨道：dev位 %s · cbm %s · fam %s · dev %s ｜ '
               'ifc 轨道：文件 %s · 实体行 %s · 暴露层 %s · 封装内部 %s</p>'
               % (format(st.get('dev位', 0), ','), format(st.get('cbm文件', 0), ','),
                  format(st.get('fam文件', 0), ','), format(st.get('dev文件', 0), ','),
                  format(st.get('ifc文件', 0), ','), format(st.get('ifc实体行', 0), ','),
                  format(st.get('ifc暴露层', 0), ','), format(st.get('ifc封装内部', 0), ',')))
    for g in (G_DEV, G_MAT, G_STR, G_OTH):
        sub = [r for r in rows if r['group'] == g and (r['dev'] or r['ifc'])]
        if not sub:
            continue
        # 报告与界面同口径：按目录编码排序（E01→E19→E-T；M01→M09；C-A1→C-D6），
        # 设备内 E16 细分按标准顺序，其余同编码内按数量降序。
        sub.sort(key=lambda r: (S.order_key(r.get('code', '')),
                                S.E16_SEQ.get(r.get('std_sub') or '', 99) if g == G_DEV else 99,
                                r['cat'], -r['total']))
        out.append('<h2>%s</h2><table><tr><th>编码</th><th>类别</th><th>子类</th>'
                   '<th>名称模板</th><th class="n">dev 轨道</th><th class="n">ifc 轨道</th>'
                   '<th class="n">合计</th><th>状态</th></tr>' % g)
        for r in sub:
            stt = r.get('st') or {}
            stxt = ' / '.join('%s %s' % (k, format(v, ','))
                              for k, v in ((S.ST_OK, stt.get(S.ST_OK, 0)),
                                           (S.ST_CAND, stt.get(S.ST_CAND, 0)),
                                           (S.ST_UNC, stt.get(S.ST_UNC, 0))) if v)
            out.append('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td>'
                       '<td class="n">%s</td><td class="n">%s</td><td class="n">%s</td>'
                       '<td class="small">%s</td></tr>'
                       % (text(r.get('code', '')), text(r['cat']), text(r['sub'] or '—'),
                          text(r['template'] or '—'),
                          format(r['dev'], ','), format(r['ifc'], ','),
                          format(r['total'], ','), text(stxt or '—')))
        out.append('</table>')
    if result.get('entityTree'):
        out.append('<h2>整体—部件与来源关系</h2><p class="small">属性引用不生成物理根；归属候选与未决结果保留，原始父级不会被改写。</p>')
        for entity in result['entityTree']:
            out.append('<details><summary>%s · %s</summary><table><tr><th>来源名称</th><th>类型/角色</th><th>归属状态</th><th>原始父级</th><th>sourceId</th></tr>' % (text(entity['name']),text(entity['category'])))
            for part in entity['parts']:
                interpretation=part['interpretation']
                out.append('<tr><td>%s</td><td>%s · %s</td><td>%s</td><td>%s</td><td>%s</td></tr>' % (text(part['name']),text(part['type']),text(interpretation['meaning']),text(interpretation.get('membershipStatus','')),text(part['rawParent']),text(part['sourceId'])))
            out.append('</table></details>')
    out.append('</body></html>')
    return '\n'.join(out)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    import argparse
    ap = argparse.ArgumentParser(description='GIM 实体盘点（设备/装置性材料/构件/其他）')
    ap.add_argument('path', help='.gim 文件或解包目录')
    ap.add_argument('--json', dest='json_out', help='输出 JSON 路径')
    ap.add_argument('--html', dest='html_out', help='输出 HTML 报告路径')
    ap.add_argument('--csv', dest='csv_out', help='输出 CSV 路径')
    ap.add_argument('--engine', choices=['standard', 'legacy'], default='standard', help='默认运行工具内置标准算法；legacy 用于历史盘点口径对照')
    args = ap.parse_args()

    last = ['']
    def prog(msg):
        last[0] = msg
        print(msg, flush=True)

    result = scan(args.path, prog, engine=args.engine)
    tt = result['totals']
    print('\n===== 盘点结果 =====')
    print('设备        : %s 台（已确认 %s · 候选 %s；dev %s + ifc %s；附件 %s 并入本体、部件 %s 上卷）'
          % (format(tt[G_DEV]['台数'], ','),
             format(tt[G_DEV].get('已确认', 0), ','), format(tt[G_DEV].get('候选', 0), ','),
             format(tt[G_DEV]['dev'], ','),
             format(tt[G_DEV]['ifc'], ','), format(tt[G_DEV].get('附件并入', 0), ','),
             format(tt[G_DEV].get('部件上卷', 0), ',')))
    for g in (G_MAT, G_STR, G_OTH):
        print('%s : %s（dev %s + ifc %s；已确认 %s · 候选 %s · 未确认 %s）'
              % (g.ljust(6, '　'), format(tt[g]['dev'] + tt[g]['ifc'], ','),
                 format(tt[g]['dev'], ','), format(tt[g]['ifc'], ','),
                 format(tt[g].get('已确认', 0), ','), format(tt[g].get('候选', 0), ','),
                 format(tt[g].get('未确认', 0), ',')))
    if args.json_out:
        with open(args.json_out, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        print('JSON ->', args.json_out)
    if args.html_out:
        with open(args.html_out, 'w', encoding='utf-8') as f:
            f.write(build_html(result))
        print('HTML ->', args.html_out)
    if args.csv_out:
        import csv
        with open(args.csv_out, 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.writer(f)
            w.writerow(['组', '编码', '类别', '子类', '名称模板', 'dev轨道', 'ifc轨道', '合计',
                        '已确认', '候选', '未确认'])
            for r in result['rows']:
                stt = r.get('st') or {}
                w.writerow([r['group'], r.get('code', ''), r['cat'], r['sub'], r['template'],
                            r['dev'], r['ifc'], r['total'],
                            stt.get(S.ST_OK, 0), stt.get(S.ST_CAND, 0), stt.get(S.ST_UNC, 0)])
        print('CSV ->', args.csv_out)


if __name__ == '__main__':
    main()
