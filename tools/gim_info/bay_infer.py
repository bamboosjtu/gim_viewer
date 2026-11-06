# -*- coding: utf-8 -*-
"""bay_infer —— IFC 散材（导线/母线/金具/绝缘子串等）间隔归属的平面坐标推断。

背景（2026-10-28 s01 实证）：GIM 侧给双键挂接（IFCFILE+IFCGUID）的散材建的 F4
几乎全部是「收纳位」锚点——根 TRANSFORMMATRIX 平移为 (0,0,0)，不含真实间隔
信息；而 IFC 侧实体沿 IfcLocalPlacement 链累积出工程场地坐标，与 GIM 的
F4 根平移处于同一坐标系（范围吻合、高度物理合理）。

算法四步：
  1) GIM 侧：真实放置（平移非零）的 F4 按 F3（间隔）聚类，≥min_pts 台取
     质心＝「间隔设备群」；
  2) IFC 侧：单遍扫描 IFC 文件，解析目标 GUID 实体的放置链 → 世界坐标；
  3) 平面最近归属：散材点 (x,y) → 最近间隔质心；
     区分度 ＝ 次近距离 − 最近距离，区分度 < MARGIN_LOW 标「低区分△」；
  4) 人工复核辅助：相数规律（耐张串每间隔×3、设备线夹×12）。

接口：
  gim_bays(p)            → {key: {'name','f3u','cx','cy','n'}}
  ifc_world_coords(path, want_guids) → {guid: (x,y,z)}
  infer(p, fuz)          → (bayinf, bays)
      bayinf = {guid: {'f3': 间隔名, 'f3u': 代表F3, 'fen': 分项名,
                       'd': 平面距离m, 'mg': 区分度m, 'low': bool}}
      只推断「IFC 命中 + 电气类名(IFC_ELEC_RX) + GIM 零位锚点」的散材。

主变合并（2026-10-29 用户定版）：一台主变在 GIM 里被拆成「N号主变本体系统」
与「N号主变中性点设备」两个 F3，本体往往只有 1 台真实放置设备，够不上
min_pts=2 的锚点门槛，它的散材只能被邻间隔吸走。这里先按 btv_class.fen_name()
把主变类分项归一到「N号主变」再聚类，一台本体＋两套中性点自然凑成群。

详见 05-模型树/IFC散材间隔归属坐标推断算法.md。
"""
import re, math

from gim_core import get1, fam_kv
from btv_class import IFC_ELEC_RX, fen_name, dev_class, volt_of_text

MARGIN_LOW = 3.0        # 区分度阈值（米）：低于此值标注低区分△
MIN_BAY_PTS = 1         # 每个归属单元的锚点设备数下限（2026-10-29 起逐台设备成锚点）

RX_ENT = re.compile(r'#(\d+) ?= ?(IFC\w+)\(([^\n]*)\)\s*;?\s*$', re.M)
RX_GUID = re.compile(r"'([0-9A-Za-z_$]{22})'")
RX_X2 = re.compile(r'\\X2\\([0-9A-Fa-f]+)\\X0\\')


def _split_args(s):
    """STEP 参数串 → 按位置切分的 token 列表（保留 `$` 占位，不跳位）。"""
    out, cur, dep, iq = [], [], 0, False
    for ch in s:
        if iq:
            cur.append(ch)
            if ch == "'":
                iq = False
            continue
        if ch == "'":
            iq = True
            cur.append(ch)
        elif ch == '(':
            dep += 1
            cur.append(ch)
        elif ch == ')':
            dep -= 1
            cur.append(ch)
        elif ch == ',' and dep == 0:
            out.append(''.join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    out.append(''.join(cur).strip())
    return out


def _ref(tok):
    """'#123' → 123；'$' / 空 → None。"""
    if tok and tok.startswith('#'):
        try:
            return int(tok[1:])
        except ValueError:
            return None
    return None


def _nums(tok):
    """'(1.,2.,3.)' 或 '1.,2.,3.' → [1.0,2.0,3.0]。"""
    s = tok.strip()
    if s.startswith('('):
        s = s[1:]
    if s.endswith(')'):
        s = s[:-1]
    out = []
    for v in s.split(','):
        v = v.strip()
        if not v or v == '$':
            continue
        try:
            out.append(float(v))
        except ValueError:
            pass
    return out


def _placed(d):
    """cbm 根 TRANSFORMMATRIX 平移非零 → 真实放置。"""
    t = d.get('TRANSFORMMATRIX')
    if not t:
        return False
    try:
        v = [float(x) for x in t.split(',')]
    except ValueError:
        return False
    if len(v) != 16:
        return False
    return abs(v[12]) + abs(v[13]) > 1


def _f3_of(p, u):
    """沿 parent 链向上找 F3（间隔）。"""
    seen = 0
    while u in p.parent and seen < 16:
        u = p.parent[u]
        seen += 1
        if p.level(u) == 'F3':
            return u
    return None


def _is_inst(d):
    """是否「一台设备」的节点。

    GIM 的设备层级不稳定（2026-10-29 用户口径）：有的工程把设备挂在 F3，
    有的挂在 F4。因此判据不看层级，而看节点自身有没有整台设备的几何指针
    （OBJECTMODELPOINTER 指向 .dev）或装配矩阵（TRANSFORMMATRIX）。
    部件实例（PI）层不带整台指针，天然被排除。
    """
    return bool(d.get('OBJECTMODELPOINTER')) or bool(d.get('TRANSFORMMATRIX'))


def _dev_volt(p, d):
    """设备额定电压（规范化，如 '10kV'）。

    取设备族文件（BASEFAMILY → .fam）里的「电压等级」字段（s01 开关柜写作
    `AC12V`，经 RATED2NOMINAL 归一成 10kV）。**不能用 F2 系统名判电压**：
    s01 全站 F3 的 SYSTEMNAME2 都是「220kV系统」，连 10kV 开关柜也叫 220kV。
    """
    bfv = next((v for k, v in d.items()
                if 'BASEFAMILY' in k.upper() and str(v).endswith('.fam')), None)
    if not bfv:
        return ''
    fk = bfv[:-4]
    if fk not in p.fam_paths:
        return ''
    if fk not in p.fam_cache:
        try:
            p.fam_cache[fk] = fam_kv(p.fam_paths[fk], p.bentley)
        except Exception:
            p.fam_cache[fk] = []
    try:
        kv = dict(p.fam_cache[fk] or [])
    except Exception:
        return ''
    raw = (kv.get('电压等级') or '').strip()
    if not raw or raw in ('/', '-100'):
        return ''
    v, _n = volt_of_text(raw)
    return v or ''


def gim_bays(p, include_bld=False, progress=None):
    """设备级锚点 → {key: {'name','f3u','cx','cy','n','devs'}}。

    2026-10-29 用户定版，替代「按 F3 分项聚类 + 要求 ≥2 台」的老口径：

    * **逐台设备成锚点**，不再把 F3 当铁板一块——同一 F3 里可能混着相距
      10 m 的「开关柜 + 接地变压器」（s01 的 #3JDXH），也可能只有 1 台设备
      （s01 的 36S / 24S / 40S 等单柜间隔）。老口径下这些单设备分项够不上
      ≥2 台门槛、直接不建锚点，其散材就被邻间隔（尤其主变）吸走。
    * **归属名**仍取设备所属 F3 经 fen_name 归一后的名字（主变本体 / 散热器 /
      中性点设备 → 「N号主变」），所以一台主变的 3 台设备合成一个归属名，
      但判距取「到该单元内最近设备」，不用质心。
    * **建构筑物不作为锚点**（include_bld=False）：构架、龙门架、油池等属建筑
      工程，不参与安装侧散材的竞争。

    返回的 devs 里带设备名与设备类别（btv_class.dev_class），供页面标注
    「这个间隔是开关柜还是主变」。
    """
    prog = progress or (lambda m: None)
    grp = {}
    n_inst = n_bld = 0
    for u, d in p.nodes.items():
        lv = p.level(u)
        if lv not in ('F3', 'F4') or not _is_inst(d) or not _placed(d):
            continue
        nm = p.disp(u) or ''
        kind, cls = dev_class(nm, get1(d, 'SYSCLASSIFYNAME'))
        if kind == '建构筑物' and not include_bld:
            n_bld += 1
            continue
        f3 = u if lv == 'F3' else _f3_of(p, u)
        if not f3:
            continue
        n_inst += 1
        disp = p.disp(f3) or f3[:8]
        nn = fen_name(disp)
        key = f3 if nn == disp else 'PH:' + nn
        s = grp.get(key)
        if s is None:
            s = grp[key] = {'name': nn, 'f3u': f3, 'devs': []}
        m = [float(x) for x in d['TRANSFORMMATRIX'].split(',')]
        s['devs'].append({'key': u, 'n': nm or '(未名)', 'x': m[12], 'y': m[13],
                          't': cls, 'k': kind, 'v': _dev_volt(p, d)})
    prog('设备实例 %d 台（排除建构筑物 %d）→ 归属单元 %d 个' %
         (n_inst, n_bld, len(grp)))
    out = {}
    for key, s in grp.items():
        ps = [(d['x'], d['y']) for d in s['devs']]
        out[key] = {'name': s['name'], 'f3u': s['f3u'],
                    'cx': sum(x for x, _ in ps) / len(ps),
                    'cy': sum(y for _, y in ps) / len(ps),
                    'n': len(ps), 'devs': s['devs'],
                    'types': sorted({d['t'] for d in s['devs'] if d['t']}),
                    'volts': sorted({d['v'] for d in s['devs'] if d['v']})}
    return out


def ifc_world_coords(path, want, progress=None):
    """单遍扫描 IFC 文件 → {guid: (x,y,z)}（仅 want 集合内的 GUID）。

    收集 IFCLOCALPLACEMENT / IFCAXIS2PLACEMENT3D / IFCCARTESIANPOINT 全集，
    再对 want 中 GUID 实体的放置链做记忆化递归求世界坐标（毫米，同 GIM）。
    """
    prog = progress or (lambda m: None)
    t = open(path, encoding='utf-8', errors='ignore').read()
    pts = {}        # point id -> [x,y,z]
    dirs = {}       # direction id -> [x,y,z]
    a2p = {}        # axis2placement3d id -> (loc, axis, ref)（按位置，$ → None）
    lp = {}         # localplacement id -> (parent, rel)
    targets = {}    # guid -> placement_id|None
    for m in RX_ENT.finditer(t):
        ty, i = m.group(2), int(m.group(1))
        if ty == 'IFCCARTESIANPOINT':
            v = _nums(m.group(3))
            if len(v) >= 2:
                pts[i] = (v + [0.0, 0.0])[:3]
        elif ty == 'IFCDIRECTION':
            v = _nums(m.group(3))
            if len(v) >= 2:
                dirs[i] = (v + [0.0, 0.0])[:3]
        elif ty == 'IFCAXIS2PLACEMENT3D':
            a = _split_args(m.group(3))
            a2p[i] = (_ref(a[0]) if len(a) > 0 else None,
                      _ref(a[1]) if len(a) > 1 else None,
                      _ref(a[2]) if len(a) > 2 else None)
        elif ty == 'IFCLOCALPLACEMENT':
            a = _split_args(m.group(3))
            lp[i] = (_ref(a[0]) if len(a) > 0 else None,
                     _ref(a[1]) if len(a) > 1 else None)
        else:
            a = _split_args(m.group(3))
            # 只有第一个参数就是 GUID 的实体才算本体；同一 GUID 还会出现在
            # IFCDISTRIBUTIONPORT（端口沿用母体 GlobalId）等行上，它们各自的
            # ObjectPlacement 指向端口局部坐标，必须排除，否则坐标整体偏移。
            if a and a[0].strip().strip("'") in want:
                g0 = a[0].strip().strip("'")
                prev = targets.get(g0)
                if prev is None or prev[0] == 'IFCDISTRIBUTIONPORT':
                    targets[g0] = (ty, _ref(a[5]) if len(a) > 5 else None)
    prog('放置表：local %d / axis2 %d / dir %d / point %d，目标 %d' %
         (len(lp), len(a2p), len(dirs), len(pts), len(targets)))

    def _norm3(v, dflt):
        n = math.sqrt(sum(a * a for a in v))
        return [a / n for a in v] if n > 1e-9 else list(dflt)

    def ax3(a2):
        """IfcAxis2Placement3D → 3x4 行主序（与 ifc_geo_extract.ax3 同口径）。"""
        loc_id, ax_id, rd_id = a2p.get(a2, (None, None, None))
        loc = pts.get(loc_id) or [0.0, 0.0, 0.0]
        z = _norm3(dirs.get(ax_id) or [0.0, 0.0, 1.0], (0.0, 0.0, 1.0))
        x0 = dirs.get(rd_id)
        if not x0:
            # 无 RefDirection：按 IFC 约定取不与 z 平行的默认轴
            x0 = (0.0, 0.0, 1.0) if abs(z[2]) < 0.9 else (1.0, 0.0, 0.0)
        d = sum(a * b for a, b in zip(x0, z))
        x = _norm3([a - d * b for a, b in zip(x0, z)], (1.0, 0.0, 0.0))
        y = (z[1] * x[2] - z[2] * x[1],
             z[2] * x[0] - z[0] * x[2],
             z[0] * x[1] - z[1] * x[0])
        return [[x[0], y[0], z[0], loc[0]],
                [x[1], y[1], z[1], loc[1]],
                [x[2], y[2], z[2], loc[2]]]

    def mul(A, B):
        return [[sum(A[r][k] * B[k][c] for k in range(3)) + (A[r][3] if c == 3 else 0.0)
                 for c in range(4)] for r in range(3)]

    wc = {}
    _I = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]

    def world(pid, seen=None):
        if pid is None:
            return None
        if pid in wc:
            return wc[pid]
        seen = seen or set()
        if pid in seen or pid not in lp:
            return None
        seen.add(pid)
        parent, rel = lp[pid]
        M = world(parent, seen) or [r[:] for r in _I]
        if rel is not None:
            M = mul(M, ax3(rel))
        wc[pid] = M
        return M

    out = {}
    for g, tp in targets.items():
        plc = tp[1] if isinstance(tp, tuple) else tp
        M = world(plc)
        if M:
            out[g] = (M[0][3], M[1][3], M[2][3])
    return out


def _bay_near(b, x, y):
    """散材点到锚点单元的最近设备 → (距离平方, 设备)。"""
    devs = b.get('devs') or []
    if not devs:
        return (x - b['cx']) ** 2 + (y - b['cy']) ** 2, None
    dv = min(devs, key=lambda d: (x - d['x']) ** 2 + (y - d['y']) ** 2)
    return (x - dv['x']) ** 2 + (y - dv['y']) ** 2, dv


def _bay_d2(b, x, y):
    """散材点到锚点的平面距离平方。

    一个归属单元＝同一分项下若干台真实放置设备，**不是**它们的质心：同一 F3 里
    可能混着相距 10 m 的「开关柜 + 接地变压器」，质心会落在两者之间的空地上，
    把远处的散材误吸过来。因此取「到单元内最近设备」的距离（2026-10-29 定版）。
    """
    return _bay_near(b, x, y)[0]


def infer(p, fuz, progress=None, bays=None):
    """主入口 → (bayinf, bays)。

    目标散材 = fuz.byfile 中 IFC 命中（guidrec 非 miss）+ 实体名匹配
    IFC_ELEC_RX + GIM 侧 F4 为零位锚点（未真实放置）。
    bays 可传入预计算的间隔群（gim_bays 结果，如可视化时强制纳入单设备间隔）。
    """
    prog = progress or (lambda m: None)
    bays = bays or gim_bays(p)
    if not bays:
        prog('无设备锚点（真实放置设备为 0），跳过推断')
        return {}, bays
    prog('归属单元 %d 个' % len(bays))
    bayinf = {}
    for fl, gm in fuz.byfile.items():
        ent = fuz.files.get(fl)
        if not ent:
            continue
        want = {}
        for g, u in gm.items():
            rec = fuz.guidrec.get(g)
            if not rec or rec.get('miss'):
                continue
            nm = rec.get('n') or ''
            if not nm or not IFC_ELEC_RX.search(nm):
                continue
            d = p.nodes.get(u)
            if d is None or _placed(d):
                continue          # 真实放置的设备不需要坐标推断
            want[g] = u
        if not want:
            continue
        prog('%s：%d 个散材待推断' % (ent[0], len(want)))
        try:
            xyz = ifc_world_coords(ent[1], set(want), prog)
        except Exception:
            xyz = {}
            prog('%s：坐标解析失败' % ent[0])
        n_hit = 0
        for g, (x, y, _z) in xyz.items():
            best = second = None
            for f3u, b in bays.items():
                d2, dv = _bay_near(b, x, y)
                if best is None or d2 < best[1]:
                    second = best
                    best = (f3u, d2, dv)
                elif second is None or d2 < second[1]:
                    second = (f3u, d2, dv)
            if best is None:
                continue
            d_m = math.sqrt(best[1]) / 1000.0
            mg = ((math.sqrt(second[1]) - math.sqrt(best[1])) / 1000.0
                  if second else 999.0)
            b = bays[best[0]]
            dv = best[2] or {}
            bayinf[g] = {'f3': b['name'], 'f3u': b['f3u'], 'fen': b['name'],
                         'key': best[0],
                         'dev': dv.get('n') or '', 'devtype': dv.get('t') or '',
                         'd': round(d_m, 1), 'mg': round(mg, 1),
                         'low': mg < MARGIN_LOW}
            n_hit += 1
        prog('%s：推断 %d/%d' % (ent[0], n_hit, len(want)))
    return bayinf, bays
