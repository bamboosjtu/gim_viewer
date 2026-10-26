# -*- coding: utf-8 -*-
"""
gim_core.py —— GIM 容器解析核心（无 UI 依赖，可独立测试）

职责：
  1. 容器解包（GIMPKGS/GIMPKGT 带头 或 裸 7z 两种都支持）
  2. 链条溯源 cbm -> dev -> fam / phm -> mod
  3. Device XML 实体抽取（保留全部 primitive 原始属性 + 局部矩阵 + 颜色）
  4. 输出中性 JSON，几何构造交给渲染端（各类型语义见 viewer_shell.html 的 PRIM 工厂）

设计原则：本模块不做几何计算，只做「忠实搬运 + 诊断」，
         这样新增 primitive 支持时只改渲染端，不必重打包。
"""
import os
import io
import re
import json
import shutil
import zipfile
import xml.etree.ElementTree as ET
import collections

MAGIC_7Z = b'7z\xbc\xaf\x27\x1c'
SKIP_TAGS = {'TransformMatrix', 'Color'}


# --------------------------------------------------------------------------
# 容器
# --------------------------------------------------------------------------
def sniff(path):
    """返回 (kind, detail)。kind: 'gimpkg' | 'raw7z' | 'unknown'"""
    with open(path, 'rb') as f:
        head = f.read(8)
    magic = head.rstrip(b'\x00')
    if magic.startswith(b'GIMPKG'):
        return 'gimpkg', magic.decode('ascii', 'replace')
    if head.startswith(MAGIC_7Z):
        return 'raw7z', ''
    # 少数导出器可能直接存 zip
    if head.startswith(b'PK'):
        return 'zip', ''
    return 'unknown', head.hex(' ')


def _find_7z_offset(path):
    """GIMPKGS/GIMPKGT：头长度厂商不一，搜索 7z 签名。返回 payload 起始偏移。"""
    with open(path, 'rb') as f:
        buf = f.read(8192)
    off = buf.find(MAGIC_7Z)
    if off < 0:
        return -1
    return off


def unpack(path, out_dir):
    """把 gim 解开到 out_dir，返回 (kind, entries, note)"""
    kind, _ = sniff(path)
    os.makedirs(out_dir, exist_ok=True)
    note = ''

    if kind == 'zip':
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            z.extractall(out_dir)
        return kind, [n for n in names if not n.endswith('/')], note

    if kind == 'gimpkg':
        off = _find_7z_offset(path)
        if off < 0:
            raise ValueError('未找到 7z 签名，容器可能损坏或加密')
        payload = os.path.join(out_dir, '_payload.7z')
        with open(path, 'rb') as f, open(payload, 'wb') as o:
            f.seek(off)
            shutil.copyfileobj(f, o)
        src = payload
    elif kind == 'raw7z':
        src = path
        note = '文件无 GIMPKGS 头，本体即裸 7z'
    else:
        raise ValueError(f'无法识别的容器格式: {_[:32]}')

    import py7zr
    with py7zr.SevenZipFile(src) as z:
        names = z.getnames()
        if z.needs_password():
            raise ValueError('压缩包已加密，暂不支持')
        z.extractall(out_dir)
    if src != path and os.path.exists(payload):
        try:
            os.remove(payload)
        except OSError:
            pass
    return kind, [n for n in names if n and not n.endswith('/')], note


def list_files(out_dir):
    """按扩展名归类已解包文件"""
    idx = collections.defaultdict(list)
    for dirpath, _, files in os.walk(out_dir):
        for fn in files:
            ext = os.path.splitext(fn)[1].lower()
            idx[ext].append(os.path.join(dirpath, fn))
    return idx


# --------------------------------------------------------------------------
# key=value 文本（cbm / dev / phm）
# --------------------------------------------------------------------------
def read_kv(path):
    d = {}
    try:
        with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
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


def _first(idx, *exts):
    for e in exts:
        if idx.get(e):
            return idx[e]
    return []


# --------------------------------------------------------------------------
# 4x4 矩阵（列主序，与 GIM TransformMatrix 一致）
# --------------------------------------------------------------------------
def _identity():
    return [1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0]


def parse_matrix(s, notes=None):
    """'1,0,0,0, 0,1,0,0, ...' -> 16 项列主序；非法时返回单位阵

    必须做两项校验，否则坏矩阵会沿装配链把整棵树算飞：
      1) 仿射形式 —— 列主序下第 4 行必须是 (0,0,0,1)，即 v[3]=v[7]=v[11]=0、v[15]=1。
         实测 CBM 的 TRANSFORMMATRIX 写成 `1,0,0,1,0,0,0,1,...`，不符合该形式
         （疑似 3×4 行主序布局），只能按单位阵回退。
      2) 线性部分非奇异 —— 行列式≈0 时 decompose 会产出 NaN 四元数。
    """
    try:
        v = [float(x) for x in (s or '').split(',') if x.strip() != '']
    except ValueError:
        if notes is not None:
            notes['badMatrixText'] += 1
        return _identity()
    if len(v) != 16:
        if notes is not None and len(v):
            notes['badMatrixLen'] += 1
        return _identity()
    if abs(v[3]) > 1e-6 or abs(v[7]) > 1e-6 or abs(v[11]) > 1e-6 or abs(v[15] - 1) > 1e-6:
        if notes is not None:
            notes['nonAffine'] += 1
        return _identity()
    a, b, c = v[0:3], v[4:7], v[8:11]
    det = (a[0] * (b[1] * c[2] - b[2] * c[1])
           - a[1] * (b[0] * c[2] - b[2] * c[0])
           + a[2] * (b[0] * c[1] - b[1] * c[0]))
    if abs(det) < 1e-9:
        if notes is not None:
            notes['singular'] += 1
        return _identity()
    return v


def mat_mul(a, b):
    """列主序 4x4 相乘：返回 a×b"""
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            s = 0.0
            for k in range(4):
                s += a[k * 4 + r] * b[c * 4 + k]
            out[c * 4 + r] = s
    return out


# 目标清单：(计数键, 目标键前缀)。2025 版 SOLIDMODELS.NUM + SOLIDMODELn，2018 版 SOLIDS.NUM + SOLIDSn
PREFIX_SOLID = (('SOLIDMODELS.NUM', 'SOLIDMODEL'), ('SOLIDS.NUM', 'SOLIDS'))
PREFIX_SUB = (('SUBDEVICES.NUM', 'SUBDEVICE'), ('SUBDEV.NUM', 'SUBDEV'))


def _key_kind(k):
    """判断块键属于 solid / sub / 其他，返回 (kind, 下标) 或 (None, None)"""
    for _ck, pre in PREFIX_SOLID:
        if k.startswith(pre) and k[len(pre):].isdigit():
            return 'solid', int(k[len(pre):])
    for _ck, pre in PREFIX_SUB:
        if k.startswith(pre) and k[len(pre):].isdigit():
            return 'sub', int(k[len(pre):])
    return None, None


def _targets(kv, pairs):
    """按 .NUM 声明取目标清单；无 .NUM 时按现存键兜底。返回 [(下标, 目标名)]"""
    for ck, pre in pairs:
        try:
            n = int(kv.get(ck, '') or 0)
        except ValueError:
            n = 0
        if n > 0:
            return [(i, kv.get(f'{pre}{i}', '')) for i in range(n) if kv.get(f'{pre}{i}', '')]
    out = []
    for _ck, pre in pairs:
        for k, v in kv.items():
            if k.startswith(pre) and k[len(pre):].isdigit() and v:
                out.append((int(k[len(pre):]), v))
    return sorted(out)


def parse_dev(path, notes=None):
    """解析 DEV 的有序块结构。

    DEV 是块文本，SOLIDMODELn / SUBDEVICEn **各自**紧跟一个 TRANSFORMMATRIXk，
    两类块都可能出现 TRANSFORMMATRIX0 —— 用扁平字典会互相覆盖，
    必须按源顺序把矩阵绑到最近的目标上（稀疏下标原样保留）。
    返回 {'symbol','type','baseFamily','solids':[[phm,M]],'subs':[[dev,M]]}
    """
    d = {'symbol': '', 'type': '', 'baseFamily': '', 'solids': [], 'subs': []}
    pending = None
    try:
        with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith(';') or line.startswith('[') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                k, v = k.strip().upper(), v.strip()
                kind, _i = _key_kind(k)
                if kind:
                    if not v:
                        pending = None
                        continue
                    d['solids' if kind == 'solid' else 'subs'].append([v, None])
                    pending = (kind, len(d['solids' if kind == 'solid' else 'subs']) - 1)
                elif k.startswith('TRANSFORMMATRIX') and k[15:].isdigit() and pending:
                    kind, i = pending
                    (d['solids'] if kind == 'solid' else d['subs'])[i][1] = parse_matrix(v, notes)
                    pending = None
                elif k == 'SYMBOLNAME':
                    d['symbol'] = v
                elif k in ('TYPE', 'DEVICETYPE'):
                    d['type'] = d['type'] or v
                elif k in ('BASEFAMILY', 'BASEFAMILYPOINTER'):
                    d['baseFamily'] = d['baseFamily'] or v
    except OSError:
        pass
    return d


def is_affine(m):
    """16 项列主序矩阵是否可直接用于 compose（仿射 + 非奇异）"""
    if not m or len(m) != 16:
        return False
    if abs(m[3]) > 1e-6 or abs(m[7]) > 1e-6 or abs(m[11]) > 1e-6 or abs(m[15] - 1) > 1e-6:
        return False
    a, b, c = m[0:3], m[4:7], m[8:11]
    det = (a[0] * (b[1] * c[2] - b[2] * c[1])
           - a[1] * (b[0] * c[2] - b[2] * c[0])
           + a[2] * (b[0] * c[1] - b[1] * c[0]))
    return abs(det) >= 1e-9


# --------------------------------------------------------------------------
# STL（PHM 可引用 MOD、STL 或混合）
# --------------------------------------------------------------------------
def parse_stl(path):
    """读取 STL，返回 (positions[flat xyz, mm], 三角形数)。二进制/ASCII 都支持。

    二进制：80 字节头 + uint32 三角数 + 每三角 50 字节（法向 12 + 3 顶点 36 + 属性 2）。
    长度校验 84 + 50*N，不匹配时回退 ASCII 解析（二进制头里也可能含 "solid"）。
    """
    with open(path, 'rb') as f:
        data = f.read()
    if len(data) >= 84:
        n = int.from_bytes(data[80:84], 'little')
        if n > 0 and 84 + 50 * n == len(data):
            import struct
            pos = []
            unpack = struct.Struct('<12f').unpack_from
            for i in range(n):
                v = unpack(data, 84 + 50 * i)
                pos.extend(v[3:12])          # 跳过法向
            return pos, n
    # ASCII
    pos = []
    for line in data.splitlines():
        s = line.strip()
        if s[:6].lower() == 'vertex':
            parts = s.split()
            if len(parts) >= 4:
                try:
                    pos.extend((float(parts[1]), float(parts[2]), float(parts[3])))
                except ValueError:
                    pass
    return pos, len(pos) // 9


def build_instances(idx):
    """递归装配：CBM → DEV(子DEV…) → PHM → MOD/STL，逐边累计矩阵

    矩阵语义：列主序、点为列向量，p_parent = M_edge × p_child，
    累计顺序 M_parent × M_child（见 gim_viewer/docs/schema/geometry-model.md）。
    同一 DEV/MOD 可被多次引用，每次都是一个独立 occurrence，**不能去重**。
    返回 [{mod, M, part, index, dev}]
    """
    dev_paths = {os.path.basename(p).lower(): p for p in idx['.dev']}
    phm_paths = {os.path.basename(p).lower(): p for p in idx['.phm']}
    mod_paths = {os.path.basename(p).lower(): p for p in idx['.mod']}
    stl_paths = {os.path.basename(p).lower(): p for p in idx.get('.stl', [])}

    insts, used_mods = [], set()
    notes = collections.Counter()
    dev_cache = {}

    def get_dev(name):
        key = (name or '').lower()
        if key not in dev_cache:
            dev_cache[key] = parse_dev(dev_paths[key], notes) if key in dev_paths else None
        return dev_cache[key]

    def emit_mod(mod_name, M, part, idx_in_parent, dev_name):
        mp = mod_paths.get((mod_name or '').lower())
        if not mp:
            notes['missingMod'] += 1
            return
        insts.append({'mod': mp, 'M': M, 'part': part,
                      'index': idx_in_parent, 'dev': dev_name})
        used_mods.add(os.path.basename(mp).lower())

    def emit_stl(stl_name, M, part, idx_in_parent):
        sp = stl_paths.get((stl_name or '').lower())
        if not sp:
            notes['missingStl'] += 1
            return
        insts.append({'stl': sp, 'M': M, 'part': part,
                      'index': idx_in_parent, 'dev': ''})

    def walk_phm(phm_name, M, part, depth=0):
        """PHM 也可继续指向 PHM，逐边累计；MOD 到位即出实例"""
        if depth > 8:
            notes['phmDepthLimit'] += 1
            return
        p = phm_paths.get((phm_name or '').lower())
        if not p:
            notes['missingPhm'] += 1
            return
        kv = read_kv(p)
        targets = _targets(kv, PREFIX_SOLID)       # 兼容 SOLIDMODELSn / SOLIDSn
        if not targets:
            notes['emptyPhm'] += 1
            return
        for i, tgt in targets:
            M_i = mat_mul(M, parse_matrix(kv.get(f'TRANSFORMMATRIX{i}'), notes))
            low = tgt.lower()
            if low.endswith('.mod'):
                emit_mod(tgt, M_i, part, i, '')
            elif low.endswith('.stl'):
                emit_stl(tgt, M_i, part, i)
            elif low.endswith('.phm'):
                walk_phm(tgt, M_i, part, depth + 1)
            else:
                notes['unsupportedTarget:' + os.path.splitext(low)[1]] += 1

    def walk_dev(dev_name, M_parent, branch, depth=0):
        key = (dev_name or '').lower()
        if key in branch:                      # 防环（只针对当前分支）
            notes['devCycle'] += 1
            return
        dv = get_dev(dev_name)
        if dv is None:
            notes['missingDev'] += 1
            return
        branch = branch | {key}
        part = dv['symbol'] or ''
        for phm, M in dv['solids']:
            M_s = mat_mul(M_parent, M or _identity())
            low = (phm or '').lower()
            if low.endswith('.stl'):
                emit_stl(phm, M_s, part, 0)
            elif low.endswith('.mod'):
                emit_mod(phm, M_s, part, 0, '')
            else:
                walk_phm(phm, M_s, part, 0)
        for sub, M in dv['subs']:
            walk_dev(sub, mat_mul(M_parent, M or _identity()), branch, depth + 1)

    # 根 DEV：优先用 CBM 的 OBJECTMODELPOINTER；否则挑没被别的 dev 引用的那个
    root = ''
    for p in idx['.cbm']:
        kv = read_kv(p)
        t = kv.get('OBJECTMODELPOINTER', '')
        if t.lower().endswith('.dev') and t.lower() in dev_paths:
            root = t
            M_cbm = parse_matrix(kv.get('TRANSFORMMATRIX'), notes)
            break
    else:
        M_cbm = _identity()

    if not root:
        referenced = set()
        for name, _p in dev_paths.items():
            dv = parse_dev(_p, notes)
            for sub, _m in dv['subs']:
                referenced.add(os.path.basename(sub).lower())
        for name in dev_paths:
            if name not in referenced:
                root = name
                break
        M_cbm = _identity()

    root_symbol = ''
    if root:
        rd = get_dev(root)
        root_symbol = (rd or {}).get('symbol', '')
        walk_dev(root, M_cbm, frozenset())

    # 没被装配链触达的 mod：单位阵兜底，几何不丢
    for name, mp in mod_paths.items():
        if name not in used_mods:
            insts.append({'mod': mp, 'M': _identity(), 'part': '', 'index': 0, 'dev': ''})
            notes['orphanMod'] += 1
    return insts, dict(notes), root_symbol


# --------------------------------------------------------------------------
# 设备 XML
# --------------------------------------------------------------------------
def parse_mod(path):
    """解析一个 .mod，返回 (entities, diag)。单实体异常不影响其余。"""
    ents = []
    diag = {'badEntity': 0, 'badMatrix': 0, 'noPrim': 0, 'hidden': 0, 'badXml': False}
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as e:
        return [], dict(diag, badXml=True, xmlError=str(e)[:160])
    except OSError as e:
        return [], dict(diag, badXml=True, xmlError=str(e)[:160])

    for e in root.iter('Entity'):
        # 隐藏实体仍需保留：Boolean 的 Entity1/Entity2 常指向 Visible=false 的操作数
        hidden = (e.get('Visible') or 'true').strip().lower() in ('false', '0')
        if hidden:
            diag['hidden'] += 1
        try:
            eid = int(e.get('ID'))
        except (TypeError, ValueError):
            diag['badEntity'] += 1
            continue

        prim = None
        for c in e:
            if c.tag not in SKIP_TAGS:
                prim = c
                break
        if prim is None:
            diag['noPrim'] += 1
            continue

        tm = e.find('TransformMatrix')
        m = None
        if tm is not None:
            raw = (tm.get('Value') or '').strip()
            if raw:
                try:
                    vals = [float(x) for x in raw.split(',')]
                    if len(vals) == 16:
                        m = vals
                    else:
                        diag['badMatrix'] += 1
                except ValueError:
                    diag['badMatrix'] += 1

        col = e.find('Color')
        color = None
        if col is not None:
            def ch(k, dv=190):
                try:
                    return int(float(col.get(k)))
                except (TypeError, ValueError):
                    return dv
            color = [ch('R'), ch('G'), ch('B'), ch('A', 0)]

        ents.append({
            'id': eid,
            'type': prim.tag,
            'attrs': dict(prim.attrib),
            'm': m,
            'color': color,
            'hidden': hidden,
        })
    return ents, diag


def build_chain(idx):
    """cbm -> dev -> fam / phm -> mod 溯源，返回摘要与 mod 清单"""
    cbms = _first(idx, '.cbm')
    devs = _first(idx, '.dev')
    fams = _first(idx, '.fam')
    phms = _first(idx, '.phm')
    mods = _first(idx, '.mod')

    chain = {'cbm': [], 'dev': [], 'fam': [], 'phm': [], 'mod': len(mods)}
    symbol = ''
    dtype = ''

    for p in cbms:
        kv = read_kv(p)
        if kv:
            chain['cbm'].append({
                'file': os.path.basename(p),
                'entity': kv.get('ENTITYNAME', ''),
                'baseFamily': kv.get('BASEFAMILY', ''),
                'model': kv.get('OBJECTMODELPOINTER', ''),
            })
    for p in devs:
        kv = read_kv(p)
        if kv:
            symbol = symbol or kv.get('SYMBOLNAME', '')
            dtype = dtype or kv.get('TYPE', '') or kv.get('DEVICETYPE', '')
            chain['dev'].append({
                'file': os.path.basename(p),
                'symbol': kv.get('SYMBOLNAME', ''),
                'type': kv.get('TYPE', ''),
                'solids': kv.get('SOLIDMODELS.NUM', ''),
            })
    for p in fams:
        kv = read_kv(p)
        chain['fam'].append({'file': os.path.basename(p), 'params': len(kv)})
    for p in phms:
        kv = read_kv(p)
        chain['phm'].append({
            'file': os.path.basename(p),
            'solids': kv.get('SOLIDMODELS.NUM', ''),
        })

    return chain, symbol, dtype, mods


# --------------------------------------------------------------------------
# 主入口
# --------------------------------------------------------------------------
def load(gim_path, work_dir):
    """完整解析一个 gim。返回可直接 json 化的 dict。

    work_dir: 解包暂存目录（调用方负责清理）
    """
    if not os.path.isfile(gim_path):
        raise FileNotFoundError(gim_path)
    kind, entries, note = unpack(gim_path, work_dir)
    idx = list_files(work_dir)
    chain, symbol, dtype, mods = build_chain(idx)
    insts, asm_notes, root_symbol = build_instances(idx)

    entities = []
    meshes = {}                                        # STL 三角网格：key -> {positions, tris}
    per_mod = []
    diag_total = collections.Counter()
    mod_cache = {}
    stl_next_id = -1
    for ins in insts:
        if 'stl' in ins:                               # STL：整份网格挂在 meshes 上，实体只做引用
            sp = ins['stl']
            key = os.path.basename(sp)
            if key not in meshes:
                try:
                    pos, tri = parse_stl(sp)
                except Exception:
                    pos, tri = [], 0
                if tri:
                    meshes[key] = {'positions': pos, 'tris': tri}
                else:
                    diag_total['badStl'] += 1
            if key in meshes:
                entities.append({
                    'id': stl_next_id, 'oid': stl_next_id, 'type': 'TriMesh',
                    'attrs': {'文件': key[:18], '三角面': meshes[key]['tris']},
                    'm': None, 'color': None, 'hidden': False,
                    'mod': key, 'part': ins['part'], 'inst': ins['index'],
                    'mesh': key, 'wm': ins['M'],
                })
                stl_next_id -= 1
                per_mod.append({'file': key, 'entities': 1, 'kind': '.stl',
                                'part': ins['part'], 'index': ins['index'],
                                'moved': ins['M'] != _identity()})
            continue
        mp = ins['mod']
        if mp not in mod_cache:                       # 同一 mod 多次实例化时只解析一次
            mod_cache[mp] = parse_mod(mp)
        ents_raw, diag = mod_cache[mp]
        # 不同实例/不同 mod 的实体 ID 可能重复，加偏移保证全局唯一；
        # oid 保留原始 ID —— Boolean 的 Entity1/Entity2 引用的是它
        base = len(entities)
        for e in ents_raw:
            e = dict(e)
            e['oid'] = e['id']
            e['id'] = e['id'] if base == 0 else e['id'] + base * 100000
            e['mod'] = os.path.basename(mp)
            e['part'] = ins['part']
            e['inst'] = ins['index']
            local = e['m'] if is_affine(e.get('m')) else _identity()
            e['wm'] = mat_mul(ins['M'], local)        # 世界矩阵 = 装配 × 实体自身
            entities.append(e)
        per_mod.append({'file': os.path.basename(mp), 'entities': len(ents_raw),
                        'kind': os.path.splitext(mp)[1].lower(),
                        'part': ins['part'], 'index': ins['index'],
                        'moved': ins['M'] != _identity()})
        for k, v in diag.items():
            if isinstance(v, int):
                diag_total[k] += v
            elif k == 'badXml' and v:
                diag_total['badXml'] += 1

    types = collections.Counter(e['type'] for e in entities)
    parts = collections.Counter(e['part'] or '(未归属)' for e in entities)

    meta = {
        'file': os.path.basename(gim_path),
        'dir': os.path.dirname(gim_path),
        'bytes': os.path.getsize(gim_path),
        'container': kind,
        'containerNote': note,
        'entries': len(entries),
        'symbol': root_symbol or symbol,
        'rootDev': root_symbol,
        'deviceType': dtype,
        'chain': chain,
        'mods': per_mod,
        'instances': len(insts),
        'parts': dict(parts),
        'assembly': asm_notes,
        'entityCount': len(entities),
        'types': dict(types),
        'diag': dict(diag_total),
        'entriesList': entries[:200],
    }
    if meshes:
        meta['meshCount'] = len(meshes)
        meta['meshTris'] = sum(m['tris'] for m in meshes.values())
    return {'meta': meta, 'entities': entities, 'meshes': meshes}


def load_to_json(gim_path, work_dir, cleanup=True):
    try:
        data = load(gim_path, work_dir)
        return json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    finally:
        if cleanup:
            shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == '__main__':
    import sys
    import tempfile
    src = sys.argv[1] if len(sys.argv) > 1 else r'D:/三维设计/LW36-72.5.gim'
    d = tempfile.mkdtemp(prefix='gimcore_')
    try:
        data = load(src, d)
        m = data['meta']
        print(f"文件     : {m['file']}  ({m['bytes']} B)")
        print(f"容器     : {m['container']} {m['containerNote']}")
        print(f"条目     : {m['entries']}")
        print(f"设备     : {m['symbol'] or '(未命名)'}  TYPE={m['deviceType'] or '-'}")
        print(f"mod      : {len(m['mods'])}  实体 {m['entityCount']}")
        print(f"类型分布 : {m['types']}")
        print(f"诊断     : {m['diag']}")
    finally:
        shutil.rmtree(d, ignore_errors=True)
