# -*- coding: utf-8 -*-
"""ifc_probe —— IFC 空间探针（移植 05-模型树/fusion_ifc_probe.py，mmap 快扫）：
空间容器/楼层/挂接 GUID 命中/残余构件，输出供融合树使用。"""
import re, mmap

# ---------------- IFC 空间探针（移植 fusion_ifc_probe.py，mmap 快扫） ----------------

_X2_RX = re.compile(r'\\X2\\([0-9A-Fa-f]+)\\X0\\')

def ifc_unescape(s):
    """解码 IFC 的 \\X2\\十六进制\\X0\\ 转义（UTF-16BE 码元序列）。"""
    def rep(m):
        h = m.group(1)
        return ''.join(chr(int(h[i:i + 4], 16))
                       for i in range(0, len(h) - 3, 4))
    return _X2_RX.sub(rep, s)

PSEUDO_NAMES = {'总轴网', '无', '(无名)', ''}
RX_WEAK = re.compile(r'^标高\s*\d*$')


def probe_line_of(mm, pos):
    s = mm.rfind(b'\n#', 0, pos + 1) + 1
    if s == 0 and mm[:1] == b'#':
        s = 0
    e = mm.find(b';', pos)
    if e < 0:
        return mm[s:].decode('utf-8', errors='ignore')
    return mm[s:e + 1].decode('utf-8', errors='ignore')


def probe_parse_def(line):
    """'#n=IFCTYPE(args)' → (n, TYPE, args_list) | None（容忍等号/逗号后空格）"""
    m = re.match(r'\s*#(\d+)\s*=\s*(IFC[A-Z0-9_]+)\s*\(', line)
    if not m:
        return None
    i = m.end()                      # '(' 之后
    depth, iq = 1, False
    for j in range(i, len(line)):
        ch = line[j]
        if iq:
            if ch == "'":
                iq = False
        elif ch == "'":
            iq = True
        elif ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0:
                break
    inner = line[i:j]
    args, depth2, cur, iq2 = [], 0, [], False
    for ch in inner:
        if iq2:
            cur.append(ch)
            if ch == "'":
                iq2 = False
            continue
        if ch == "'":
            iq2 = True
            cur.append(ch)
        elif ch == '(':
            depth2 += 1
            cur.append(ch)
        elif ch == ')':
            depth2 -= 1
            cur.append(ch)
        elif ch == ',' and depth2 == 0:
            args.append(''.join(cur))
            cur = []
        else:
            cur.append(ch)
    if cur:
        args.append(''.join(cur))
    return int(m.group(1)), m.group(2), args


def probe_quality(storeys):
    """楼层质量分档：real / weak / pseudo / none。"""
    names = [s['name'] for s in storeys]
    if not names:
        return 'none'
    if len(names) == 1 and (names[0] in PSEUDO_NAMES):
        return 'pseudo'
    if all(RX_WEAK.match(n or '') for n in names):
        return 'weak'
    if len(names) >= 2:
        return 'real'
    return 'pseudo'


def _make_type_at(mm, table):
    """实体号→类型查询：先查预建表，未命中退回游标 find。
    注意：table 由调用方传入并共享（不能 table = table or {}——空 dict falsy 会被换新对象）。"""
    state = {'pos': 0}

    def type_at(num):
        ty = table.get(num)
        if ty:
            return ty
        key = ('#%d' % num).encode()
        pos = mm.find(key, state['pos'])
        if pos < 0:
            pos = mm.find(key)          # 乱序回退：从头找
            if pos < 0:
                return '?'
        if pos > state['pos']:
            state['pos'] = pos
        m = re.match(rb'#\d+\s*=\s*([A-Za-z0-9_]+)', mm[pos:pos + 80])
        ty = m.group(1).decode() if m else '?'
        table[num] = ty                 # 回退结果缓存，防重复全扫
        return ty
    return type_at


def ifc_probe_file(path, guid_set):
    """IFC 文件原生空间结构探针（移植 fusion_ifc_probe.probe_file）。
    guid_set: {guid: cbm_uuid}；返回 storeys/buildings/quality/guids/resid/outside。"""
    f = open(path, 'rb')
    mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    table = {}
    type_at = _make_type_at(mm, table)
    out = {'size_mb': round(len(mm) / 1048576, 1)}

    # ---- 1) 空间容器：IFCPROJECT / IFCSITE / IFCBUILDING / IFCBUILDINGSTOREY ----
    containers = {}
    for kw, tywant in ((b'IFCPROJECT(', 'IFCPROJECT'), (b'IFCSITE(', 'IFCSITE'),
                       (b'IFCBUILDING(', 'IFCBUILDING'),
                       (b'IFCBUILDINGSTOREY(', 'IFCBUILDINGSTOREY')):
        pos = mm.find(kw)
        while pos >= 0:
            d = probe_parse_def(probe_line_of(mm, pos))
            if d and d[1] == tywant:
                n, ty, aa = d
                nm = ''
                for x in aa[2:4]:
                    x = ifc_unescape(x.strip().strip("'"))
                    if x and x != '$':
                        nm = x
                        break
                gid = aa[0].strip().strip("'") if aa and aa[0].startswith("'") else None
                elev = None
                if ty == 'IFCBUILDINGSTOREY' and len(aa) >= 5:
                    m2 = re.match(r'(-?\d+(\.\d+)?)', aa[4].strip())
                    elev = float(m2.group(1)) if m2 else None
                containers[n] = {'ty': ty, 'name': nm, 'guid': gid, 'elev': elev}
            pos = mm.find(kw, pos + 1)
    out['storeys'] = sorted([{'id': k, 'name': v['name'] or '(无名)', 'elev': v['elev'],
                              'guid': v['guid']}
                             for k, v in containers.items() if v['ty'] == 'IFCBUILDINGSTOREY'],
                            key=lambda s: (s['elev'] is None, s['elev'] or 0))
    out['buildings'] = [{'id': k, 'name': v['name'], 'guid': v['guid']}
                        for k, v in containers.items() if v['ty'] == 'IFCBUILDING']
    out['sites'] = [{'id': k, 'name': v['name']} for k, v in containers.items()
                    if v['ty'] == 'IFCSITE']
    out['quality'] = probe_quality(out['storeys'])

    # ---- 2) REL 行：聚合 / 空间包含（行尾锚定，容忍 s03 导出器空格方言） ----
    parent = {}                     # child ent → parent ent
    for kw, tywant in ((b'IFCRELAGGREGATES(', 'IFCRELAGGREGATES'),
                       (b'IFCRELCONTAINEDINSPATIALSTRUCTURE(',
                        'IFCRELCONTAINEDINSPATIALSTRUCTURE')):
        pos = mm.find(kw)
        while pos >= 0:
            # 定义行判定：'=' 紧邻关键字（#n=IFCREL…）或等号后带空格（#n = IFCREL…）
            if pos >= 1 and (mm[pos - 1:pos] == b'=' or mm[pos - 2:pos] == b'= '):
                s = mm.rfind(b'\n#', 0, pos + 1) + 1
                e = mm.find(b';', pos)
                if e < 0:
                    e = len(mm)
                seg = mm[s:e].decode('utf-8', errors='ignore')
                if tywant == 'IFCRELAGGREGATES':
                    m_agg = re.search(r',\s*#(\d+)\s*,\s*\((#[\d,\s#\$]*)\)\s*\)$', seg)
                    if m_agg:
                        reln = int(m_agg.group(1))
                        for o in re.findall(r'#(\d+)', m_agg.group(2)):
                            parent.setdefault(int(o), reln)
                else:
                    m_con = re.search(r',\s*\((#[\d,\s#\$]*)\)\s*,\s*#(\d+)\s*\)\s*$', seg)
                    if m_con:
                        reln = int(m_con.group(2))
                        for o in re.findall(r'#(\d+)', m_con.group(1)):
                            parent.setdefault(int(o), reln)
            pos = mm.find(kw, pos + len(kw))

    # ---- 2.5) 预建 child→type 表：一遍 finditer，避免逐个回扫大文件 ----
    if parent:
        targets = set(parent)
        targets.update(parent.values())     # 链上容器节点也预建（up_storey 高频查）
        for m in re.finditer(rb'\n#(\d+)\s*=\s*([A-Za-z0-9_]+)', mm):
            n2 = int(m.group(1))
            if n2 in targets:
                table[n2] = m.group(2).decode()

    def up_storey(ent):
        seen = 0
        while ent is not None and seen < 12:
            ty = type_at(ent)
            if ty == 'IFCBUILDINGSTOREY':
                return containers.get(ent, {}).get('name') or '(无名)'
            ent = parent.get(ent)
            seen += 1
        return None

    # ---- 3) GUID 命中实体明细 ----
    guids = {}
    for g, cbm in guid_set.items():
        pos = mm.find(g.encode())
        hit = None
        while pos >= 0:
            d = probe_parse_def(probe_line_of(mm, pos))
            if d and d[2] and d[2][0].strip("'") == g:
                hit = d
                break
            pos = mm.find(g.encode(), pos + 1)
        if not hit:
            guids[g] = {'miss': True, 'cbm': cbm}
            continue
        n, ty, aa = hit
        nm = ifc_unescape(aa[2].strip("'")) if len(aa) > 2 and aa[2].startswith("'") else ''
        st = up_storey(n)
        rec = {'t': ty, 'cbm': cbm}
        if nm:
            rec['n'] = nm[:80]
        if st:
            rec['st'] = st
        guids[g] = rec
    out['guids'] = guids
    hit_n = sum(1 for v in guids.values() if not v.get('miss'))
    out['guid_hit'] = hit_n
    out['guid_miss'] = len(guids) - hit_n

    # ---- 4) 未挂接残余：CONTAINED 直接包含元素中非 GUID 命中者，按 (楼层,类型) 聚合 ----
    hit_ents = set()
    for g, rec in guids.items():
        if not rec.get('miss'):
            pos = mm.find(g.encode())
            while pos >= 0:
                d = probe_parse_def(probe_line_of(mm, pos))
                if d and d[2] and d[2][0].strip("'") == g:
                    hit_ents.add(d[0])
                    break
                pos = mm.find(g.encode(), pos + 1)
    storey_of_id = {k: (v.get('name') or '(无名)') for k, v in containers.items()
                    if v['ty'] == 'IFCBUILDINGSTOREY'}
    resid = {}
    outside = {}
    for child, par in parent.items():
        if child in hit_ents:
            continue
        ty = type_at(child)
        stn = storey_of_id.get(par) if par in storey_of_id else up_storey(par)
        if stn:
            resid.setdefault(stn, {}).setdefault(ty, 0)
            resid[stn][ty] += 1
        else:
            outside[ty] = outside.get(ty, 0) + 1
    out['resid'] = resid
    out['outside'] = outside
    try:
        mm.close()
    except Exception:
        pass
    f.close()
    return out


IFC_CN = {
    'IFCBEAM': '梁', 'IFCCOLUMN': '柱', 'IFCSLAB': '板', 'IFCWALL': '墙',
    'IFCWALLSTANDARDCASE': '墙(标准)', 'IFCCURTAINWALL': '幕墙', 'IFCDOOR': '门',
    'IFCWINDOW': '窗', 'IFCSTAIR': '楼梯', 'IFCSTAIRFLIGHT': '梯段',
    'IFCROOF': '屋面', 'IFCPILE': '桩', 'IFCFOOTING': '底脚基础',
    'IFCMEMBER': '型钢撑杆', 'IFCPLATE': '节点板', 'IFCRAILING': '栏杆',
    'IFCCOVERING': '覆面层', 'IFCREINFORCINGMESH': '钢筋网',
    'IFCREINFORCINGBAR': '钢筋', 'IFCELEMENTASSEMBLY': '组合件',
    'IFCBUILDINGELEMENTPROXY': '通用构件', 'IFCBUILDINGELEMENTPART': '构件局部',
    'IFCFLOWSEGMENT': '管段/桥架', 'IFCFLOWFITTING': '管件',
    'IFCFLOWTERMINAL': '末端设备', 'IFCFLOWMOVINGDEVICE': '动力设备(泵/风机)',
    'IFCFLOWCONTROLLER': '阀件/控制', 'IFCFLOWSTORAGEDEVICE': '储运设备',
    'IFCDISTRIBUTIONCONTROLELEMENT': '自控元件', 'IFCDISTRIBUTIONELEMENT': '配电元件',
    'IFCFURNISHINGELEMENT': '家具', 'IFCLIGHTFIXTURE': '灯具',
    'IFCANNOTATION': '注记', 'IFCSPACE': '空间', 'IFCGRIDAXIS': '轴网线',
    'IFCDISTRIBUTIONPORT': '连接端口(非构件)', 'IFCRAMP': '坡道', 'IFCRAMPFLIGHT': '坡道段',
    'IFCOPENINGELEMENT': '洞口', 'IFCGROUP': '逻辑组',
}


# 伪/弱楼层占位名（s02 总轴网 / s03 无 / 未命名层）：文件级残余注记不标 @层名
PSEUDO_NAMES = {'总轴网', '无', '(无名)', '(伪层)', '(未分层)'}


def cn_type(ty):
    return '%s·%s' % (IFC_CN.get((ty or '').upper(), ''), ty or '?')


