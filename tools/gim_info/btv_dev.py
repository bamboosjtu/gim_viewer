# -*- coding: utf-8 -*-
"""btv_dev —— BTV 业务树的 **dev 轨道**（只读 cbm / fam / dev 属性）

分轨背景（2026-11-03）：原来 `btv_class.py` 把两条轨道揉在一棵树里——
cbm 的 F3/F4 定骨架，IFC 的实体名回填类别、电气白名单又反过来改桶。
现在按轨道拆开：

  · **本模块（dev 轨道）**：只吃 `gim_core.Project` 的 cbm 层级（F1–F4）、
    SYSTEMNAME / SYSCLASSIFYNAME、fam 族属性与标识编码，独立产出一棵业务树。
    IFC 的东西默认一概不看；需要时由调用方显式注入：
        hints  = {guid: (kind, cat)}      IFC 实体名回填（btv_ifc.fill_hints 产出）
        rehome = {guid: {'f3u','fen'}}    坐标推断归属（bay_infer.infer 产出）
        elec   = {guid}                   电气散材白名单（btv_ifc.fill_hints 产出）
  · **btv_ifc.py（ifc 轨道）**：IFC 文件角色、楼层、构件、GUID 挂接，独立成树。
  · **btv_class.py**：融合兼容层，保留 `build_btv()` 旧签名，内部组合两条轨道；
    旧文件不删，GUI / bay_infer 的 import 不受影响。

分类通道（优先级不变）：名称词表 → 标识编码段位（仅未分类/占位）→（可选）IFC Name。
"""
import re

from gim_core import get1, fam_kv, _natkey

VOLT_RX = re.compile(r'(?:≥|>=)?\s*(\d+(?:\.\d+)?)\s*(kV|V)', re.I)
RATED2NOMINAL = {'3.6': '3', '7.2': '10', '12': '10', '40.5': '35', '72.5': '110',
                 '126': '110', '252': '220', '363': '330', '550': '500',
                 '800': '750', '1100': '1000'}


def volt_of_text(t):
    if not t or t.strip() in ('/', ''):
        return None, None
    m = VOLT_RX.search(t)
    if not m:
        return None, None
    num, unit = m.group(1), m.group(2).lower()
    if unit == 'v' and num.replace('.', '').isdigit() and float(num) > 1000:
        return num + 'kV', 'typo-kV'
    note = 'typo-kV?' if unit == 'v' else None
    nom = RATED2NOMINAL.get(num)
    if nom:
        return nom + 'kV', 'rated-normalized'
    return num + 'kV', note


def scn_mid(scn):
    if not scn:
        return None
    m = re.match(r'[GA]_([A-Z])_', scn) or re.match(r'[GA]([A-Z])[A-Z]', scn)
    return m.group(1) if m else None


def unit_bucket(sysname2, sysname1, scn_mid_):
    """F2 系统名（+SCN 中段）→ (工程类别, 桶名, 电压)。"""
    t = sysname2 or ''
    if re.search(r'主变|变压器系统', t) or scn_mid_ == 'T':
        return ('安装工程', '主变压器系统', None)
    v, _n = volt_of_text(t)
    if v:
        return ('安装工程', '配电装置(%s)' % v, v)
    if re.search(r'监控|保护|测控|测量|直流|表计|通信|远动|调度', t) \
            or (sysname1 and re.search(r'二次', sysname1)):
        return ('安装工程', '控制及直流/二次系统', None)
    if re.search(r'接地|防雷', t):
        return ('安装工程', '电缆及接地', None)
    if re.search(r'站用', t):
        return ('安装工程', '站用电系统', None)
    if re.search(r'跨电压', t):
        # 2026-10-28 实证：该分支 105 台 F4 的 FAM 工程中名称全部为二次专业
        # （保护/测控/录波/时钟/智能辅控/火灾报警/通信/直流…），桶名按 GIM 分类定名。
        return ('安装工程', '二次/控制直流设备', None)
    if re.search(r'构筑物|建筑|给排水|暖通|消防|空调|总图|道路', t) \
            or (sysname1 and re.search(r'构筑物|建筑物|建筑', sysname1)):
        return ('建筑工程', '建筑工程(按F3专业)', None)
    return (None, None, None)


# ---- 名称词域（v3：设备 / 装置性材料 / 建构筑物 三分） ----
RX_ZXD = re.compile(r'中性点|中性成套|NEUTRAL', re.I)
RX_CLS = [
    (r'消弧线圈|接地变|小电阻',                     '设备', '消弧线圈/小电阻/接地变成套(类4)'),
    (r'组合电器|HGIS|\bGIS\b',                      '设备', '组合电器GIS/HGIS(类5)'),
    (r'断路器|CIRCUIT\s*BREAKER|\bBREAKER\b',       '设备', '断路器(类6)'),
    (r'接地开关|接地刀|EARTH\s*SWITCH|GROUND(?:ING)?\s*SWITCH', '设备', '接地开关(类8)'),
    (r'隔离开关|刀闸|DISCONNECTOR|ISOLATOR',        '设备', '隔离开关(类7)'),
    (r'开关柜|充气柜|环网柜|融冰柜|SWITCHGEAR|SWITCH\s*GEAR|kV馈线柜', '设备', '开关柜(类9)'),
    (r'站用变|AUX(?:ILIARY)?\s*TRANSFORMER',        '设备', '站用变压器(类3)'),
    (r'高抗|高压并联电抗器',                         '设备', '高压并联电抗器(类2)'),
    (r'电容器|CAPACITOR',                            '设备', '并联电容器成套(类11)'),
    (r'电抗器|REACTOR',                              '设备', '并联电抗器/低抗(类12)'),
    (r'SVG|静止无功|动态无功|STATCOM',               '设备', 'SVG(类13)'),
    (r'电流互感器|CURRENT\s*TRANSFORMER',            '设备', '电流互感器(类14)'),
    (r'电压互感器|CVT|VOLTAGE\s*TRANSFORMER|POTENTIAL\s*TRANSFORMER', '设备', '电压互感器(类15)'),
    (r'避雷器|ARRESTER',                             '设备', '避雷器(类16)'),
    (r'主变|号主变|变压器|TRANSFORMER',              '设备', '主变压器(类1)'),
    (r'预制舱',                                      '设备', '预制舱开关设备(2025类10)'),
    # 2026-10-29 口径变更：支柱绝缘子(目录11)/穿墙套管(目录13)/绝缘子串(附录) 虽在
    # 《通用设备目录》单列条目，但按造价口径属施工方采购安装的散材 → 装置性材料。
    # 类别名统一为 MAT_L1 的 8 大类名（与 03-模型渲染/devtype_class.py 同口径）。
    (r'支柱绝缘子|柱式绝缘子|针式绝缘子|瓷横担',      '装置性材料', '绝缘子'),
    (r'穿墙套管',                                    '装置性材料', '其他材料'),
    (r'绝缘子串|耐张串',                             '装置性材料', '绝缘子'),
    (r'电缆终端',                                    '设备', '电缆终端(2018类16)'),
    (r'接地箱|动力照明箱|检修箱|低压配电屏|配电箱',   '设备', '动力辅助设施(2018类16)'),
    (r'风机|消防泵|灭火器|气压罐|启动瓶|水泵接合器|泡沫消防', '设备', '水工暖通设施(2018类17)'),
    (r'保护|测控|屏柜|直流|蓄电池|录波|远动|智能|监控|汇控|端子箱|计量|网关|合并单元|后台|摄像头|门禁|防火|火灾|烟雾|报警|通信|控制|配线|电源柜|馈线|进线柜|联络屏|电能表|电度表|同步|服务器|记录分析|数据网|监测|UPS|调度|检修|油色谱|备用柜|预留柜', '设备', '二次/控制直流设备'),
    (r'母线',                                        '装置性材料', '母线'),
    (r'金具|线夹|间隔棒|接线盒|耐张|NAIZHANG|XIANJ|引流', '装置性材料', '金具'),
    (r'导线|绞线|软导体',                             '装置性材料', '导线'),
    (r'绝缘子',                                      '装置性材料', '绝缘子'),
    (r'套管',                                        '装置性材料', '其他材料'),
    (r'电力电缆|电缆',                               '装置性材料', '电缆'),
    (r'封堵|铜排|铝排|支(撑)架|抱箍|槽盒|桥架',      '装置性材料', '其他材料'),
    (r'构架|龙门架',                                 '建构筑物', '构架/龙门架'),
    (r'PD\d|PL\d|PIP\d|^L\d|槽钢|檩条|角钢|钢板', '建构筑物', '构架/龙门架'),
    (r'接地网|避雷带|接地扁钢|接地体|接地装置|均压环|接地系统|扁钢|扁铜|扁铝|圆钢|铜棒|铜排|铝排|接地极|接地线', '装置性材料', '接地材料'),
    (r'灯具|投光灯|照明(?!箱|柜|盘|屏|配电|集中)|疏散指示|安全出口', '装置性材料', '照明器具'),
    (r'油池|水池|化粪池|构筑物',                     '建构筑物', '构筑物(事故油池等)'),
]

KIND_TAG = {'设备': '[设]', '装置性材料': '[材]', '构件': '[构]', '建构筑物': '[构]',
            '占位': '[?]', '未分类': '[?]', '未分类(名占位)': '[?]'}


def dev_class(name, scn):
    """名称（+SCN）→ (性质, 类别)。与 btv_build_v2.dev_class 同源。"""
    from gim_core import nm_ok
    if not nm_ok(name):
        if scn and scn.startswith('&'):
            return '占位', '&占位'
        return '未分类(名占位)', '(名称占位,需编码映射表)'
    if RX_ZXD.search(name):
        return '设备', '主变中性点成套装置'
    for rx, kind, cat in RX_CLS:
        if re.search(rx, name):
            return kind, cat
    return '未分类', name[:16]


BUCKET_OVERRIDE = {
    '并联电容器成套(类11)':  ('安装工程', '无功补偿'),
    '并联电抗器/低抗(类12)': ('安装工程', '无功补偿'),
    '高压并联电抗器(类2)':   ('安装工程', '无功补偿'),
    'SVG(类13)':             ('安装工程', '无功补偿'),
    '消弧线圈/小电阻/接地变成套(类4)': ('安装工程', '无功补偿'),
    '站用变压器(类3)':       ('安装工程', '站用电系统'),
    '动力辅助设施(2018类16)': ('安装工程', '站用电系统'),
    '水工暖通设施(2018类17)': ('建筑工程', '建筑工程(按F3专业)'),
}


def f4_bucket(cls_cat, base_cat, base_bucket):
    if cls_cat == '主变中性点成套装置':
        return ('安装工程', '主变压器系统')
    hit = BUCKET_OVERRIDE.get(cls_cat)
    if hit:
        return hit
    return (base_cat, base_bucket)


# ---- v4 标识编码段位规则（名称判定失败时回填，冲突不改判） ----
CODE_RULES = {
    'GSN': '开关柜(类9)', 'GSK': '组合电器GIS/HGIS(类5)', 'GIS': '组合电器GIS/HGIS(类5)',
    'GG': '组合电器GIS/HGIS(类5)', 'GSB': '隔离开关(类7)',
    'GH': '开关柜(类9)', 'GHC': '开关柜(类9)',
    'GYAA': '避雷器(类16)', 'GYA': '避雷器(类16)', 'GY': '避雷器(类16)',
    'GNB': '并联电容器成套(类11)', 'GN': '并联电容器成套(类11)',
    'GNA': '并联电抗器/低抗(类12)', 'GTJ': '消弧线圈/小电阻/接地变成套(类4)',
    'GTEA': '电压互感器(类15)', 'GT': '电压互感器(类15)',
    'EZR': '主变压器(类1)', 'ANXK': '主变压器(类1)',
    'ATB': '主变中性点成套装置', 'GTN': '主变中性点成套装置', 'ZBZXD': '主变中性点成套装置',
    'CCB': '二次/控制直流设备', 'ANXU': '二次/控制直流设备', 'FBA': '二次/控制直流设备',
    'ANXG': '二次/控制直流设备', 'HBC': '二次/控制直流设备', 'YWBJ': '二次/控制直流设备',
    'ANXC': '二次/控制直流设备', 'ANXJ': '二次/控制直流设备', 'ANXA': '二次/控制直流设备',
    'PK': '金具', 'PH': '金具', 'PJ': '导线',
    'GJAA': '绝缘子', 'GJCA': '绝缘子', 'GJ': '绝缘子',
    'BLD': '接地材料', 'GV': '接地材料',
    'GP': '照明器具', 'JG': '构架/龙门架',
    'GD': '其他材料', 'DLZD': '电缆终端(2018类16)',
}
# 八类装置性材料（与 devtype_class.MAT_L1 同口径）；其余编码类别按设备计
_CODE_MAT = {'导线', '母线', '金具', '绝缘子', '电缆', '接地材料', '照明器具', '其他材料'}
_CODE_BLD = {'构架/龙门架', '构筑物(事故油池等)'}
RX_CODE_KEY = re.compile(r'标识系统编码|模型编码|IDENTIFICATION.*CODE|MODELCODE|GRIDIDENT', re.I)
RX_TOK = re.compile(r'[A-Za-z]{2,}')


def code_rule(pairs):
    """fam 键值对 → (段位, 类别) 或 None。长段位优先。"""
    v = None
    for k, val in pairs:
        if RX_CODE_KEY.search(k):
            v = val
            break
    if not v:
        return None
    if '=' in v:
        v = v.split('=')[-1]
    v = v.strip()
    if not v or v == '-100':
        return None
    toks = sorted(set(t.upper() for t in RX_TOK.findall(v)), key=lambda t: -len(t))
    for t in toks:
        if t in CODE_RULES:
            return t, CODE_RULES[t]
    return None


# ---- 分项名归一：主变本体 / 散热器 / 中性点 → 同一个「N号主变」（2026-10-29 用户定版）----
# 业务树上主变只应有一个分项：工程 → 主变压器系统 → 1号主变。
# GIM 的 F3 把一台主变拆成「1号主变本体系统」「1号主变中性点设备」（有时还有
# 「…本体及散热器」），装置性材料/散材又按这些分项各归各的，同一台主变的
# 母线、线夹、绝缘子串被拆到两个节点下。归一后它们回到同一条主变。
# 注意只匹配「主变 + 部件后缀」整名：配电装置里的「#1主变进线间隔」「#2主变 110kV
# 进线间隔」是进线间隔，不能并进来。
RX_TRF_FEN = re.compile(
    r'^\s*#?\s*(\d+)\s*号?\s*(?:备用\s*)?主变\s*'
    r'(?:本体系统|本体及散热器|本体|散热器|中性点设备|中性点成套装置|中性点)\s*$')


def fen_name(s3):
    """分项（F3）名归一：主变相关分项统一成「N号主变」，其余原样返回。"""
    if not s3:
        return s3 or ''
    m = RX_TRF_FEN.match(s3)
    return ('%s号主变' % m.group(1)) if m else s3


def _slot(btv, cat, bucket, fen):
    return btv[cat].setdefault(bucket, {}).setdefault(
        'fens', {}).setdefault(fen, {'dev': 0, 'mat': 0, 'f4s': []})


def build_dev_btv(p, hints=None, rehome=None, elec=None, idx=None,
                  granularity='device', progress=None):
    """**dev 轨道**建树：只读 cbm / fam / dev，IFC 信息需调用方显式注入。

    granularity='device'（默认，2026-11-03 起）：叶子 = `dev_inst.DeviceIndex`
        按 **gim_element** 口径判出的实例——设备（DEV 本体；主变附件并入、
        「设备_部件」上卷、PI 箱柜释放）、装置性材料、构件；
        词域外与无模型指针的 F4 **不上树**，只计入跳过统计。
    granularity='f4'：旧口径，每个 F4 一个叶子（对照 / 回归用）。

    返回 {'安装工程': {桶: {'fens': {分项: {'dev','mat','att','f4s':[…]}}}},
          '建筑工程': {…}}；叶子 = {'n','k','c','s','d','u','f','g','lv'}。

    hints   {guid: (kind, cat)}  IFC 实体名回填（默认 None：不回填）
    rehome  {guid: {'f3u','fen'}} 坐标推断归属（默认 None：不搬迁）
    elec    {guid}  电气散材白名单：仅影响「建筑工程桶 → 电气装置(IFC挂接)」的改判
    idx     dev_inst.DeviceIndex；granularity='device' 时缺省自动构建
    """
    nodes, children, level = p.nodes, p.children, p.level
    hints = hints or {}
    rehome = rehome or {}
    elec = elec or set()
    prog = progress or (lambda m: None)
    btv = {'安装工程': {}, '建筑工程': {}}
    pend = []                        # (目标F3, 分项名, 叶子, 性质) 待归入推断间隔
    UNC = ('未分类', '未分类(名占位)', '占位')
    if granularity == 'device' and idx is None:
        from dev_inst import DeviceIndex
        idx = DeviceIndex(p, prog)
    n_f3 = n_f4 = n_code = n_hint = n_home = n_skip = 0

    def _bucket_of(kind, cls_cat, bcls, base_cat, base_bucket, g=''):
        """性质 + 桶覆盖 → (工程类别, 桶)。bcls 是 btv 词表类别（override 键用）。"""
        if kind == '装置性材料' and '接地' in (cls_cat or ''):
            return '安装工程', '电缆及接地'
        fcat, fbucket = f4_bucket(bcls, base_cat, base_bucket)
        if kind in ('构件', '建构筑物'):
            # 构件/建构筑物属建筑部分，不因 F3 在安装侧就被拽进设备桶
            if fcat == '安装工程' or not fcat:
                fcat, fbucket = '建筑工程', '建筑工程(按F3专业)'
        elif fcat == '建筑工程' and g in elec:
            fcat, fbucket = '安装工程', '电气装置(IFC挂接)'
        return fcat, fbucket

    for u in nodes:
        if level(u) != 'F3':
            continue
        n_f3 += 1
        d = nodes[u]
        s1 = get1(d, 'SYSTEMNAME1')
        s2 = get1(d, 'SYSTEMNAME2')
        s3 = get1(d, 'SYSTEMNAME3')
        scn = get1(d, 'SYSCLASSIFYNAME')
        mid = scn_mid(scn)
        cat, bucket, _v = unit_bucket(s2, s1, mid)
        fen = fen_name(s3 or '(无名F3)')
        for c in children.get(u, []):
            if level(c) != 'F4':
                continue
            n_f4 += 1
            dd = nodes[c]
            cscn = get1(dd, 'SYSCLASSIFYNAME') or ''
            cmid = scn_mid(cscn)
            ccat, cbucket, _x = unit_bucket(s2, s1, cmid if cmid else mid)
            if idx is not None:                  # ---- 实例粒度（gim_element 口径）----
                inst = idx.by_uuid.get(c)
                if not inst:
                    n_skip += 1
                    continue
                nm = inst['name']
                kind, cls_cat = inst['group'], inst['cat']
                g = inst.get('guid') or ''
                bcls = dev_class(nm, cscn)[1]
                leaf = {'n': nm, 'k': kind, 'c': cls_cat,
                        's': inst.get('sub') or '', 'd': inst.get('code') or '',
                        'u': c, 'f': inst.get('ifc_file') or '', 'g': g, 'lv': inst['lv']}
            else:                                # ---- 旧 F4 粒度 ----
                nm = p.display.get(c) or ''
                kind, cls_cat = dev_class(nm, cscn)
                # v4 码回填：仅未分类/占位
                if kind in UNC:
                    bfv = next((v for k, v in dd.items()
                                if 'BASEFAMILY' in k.upper() and v.endswith('.fam')), None)
                    if bfv and bfv[:-4] in p.fam_paths:
                        fk = bfv[:-4]
                        if fk not in p.fam_cache:
                            p.fam_cache[fk] = fam_kv(p.fam_paths[fk], p.bentley)
                        hit = code_rule(p.fam_cache[fk])
                        if hit:
                            ccls = hit[1]
                            kind = ('装置性材料' if ccls in _CODE_MAT else
                                    '建构筑物' if ccls in _CODE_BLD else '设备')
                            cls_cat = ccls
                            n_code += 1
                # 可选：IFC 名称回填（hints 由 btv_ifc.fill_hints 提供）
                g = get1(dd, 'IFCGUID')
                if kind in UNC and g and hints:
                    hk = hints.get(g)
                    if hk:
                        kind, cls_cat = hk
                        n_hint += 1
                bcls = cls_cat
                leaf = {'n': nm, 'k': kind, 'c': cls_cat, 'u': c,
                        'f': get1(dd, 'IFCFILE') or '', 'g': g or ''}
            # 坐标推断归入目标间隔：收纳位散材不再留在原收纳分项
            inf = rehome.get(g) if g else None
            if inf and inf.get('f3u') and inf['f3u'] != u:
                pend.append((inf['f3u'], inf.get('fen') or '', leaf, kind))
                n_home += 1
                continue
            fcat, fbucket = _bucket_of(kind, cls_cat, bcls,
                                       ccat or cat, cbucket or bucket, g)
            if not fcat:
                continue
            slot = _slot(btv, fcat, fbucket, fen)
            if kind == '设备':
                slot['dev'] += 1
            else:
                slot['mat'] += 1
            slot['f4s'].append(leaf)
        # 主变附件（中性点成套装置等）：并入本分项，不另计台
        att = idx.attach_count(u) if idx is not None else 0
        if att:
            slot = _slot(btv, cat or '安装工程', bucket or '主变压器系统', fen)
            slot['att'] = slot.get('att', 0) + att
    # ---- PI 实例：材料实例与释放的箱柜设备，挂到所属 F3 ----
    if idx is not None:
        for inst in idx.insts:
            if inst['lv'] != 'PI':
                continue
            d3 = nodes.get(inst.get('f3') or '')
            if not d3:
                n_skip += 1
                continue
            t1 = get1(d3, 'SYSTEMNAME1')
            t2 = get1(d3, 'SYSTEMNAME2')
            t3 = get1(d3, 'SYSTEMNAME3')
            tcat, tbucket, _v = unit_bucket(t2, t1, scn_mid(get1(d3, 'SYSCLASSIFYNAME')))
            if not tcat:
                tcat, tbucket = '安装工程', '电气装置(IFC挂接)'
            bcls = dev_class(inst['name'], '')[1]
            fcat, fbucket = _bucket_of(inst['group'], inst['cat'], bcls,
                                       tcat, tbucket, inst.get('guid') or '')
            if not fcat:
                continue
            slot = _slot(btv, fcat, fbucket, fen_name(t3 or '(无名F3)'))
            if inst['group'] == '设备':
                slot['dev'] += 1
            else:
                slot['mat'] += 1
            slot['f4s'].append({'n': inst['name'], 'k': inst['group'], 'c': inst['cat'],
                                's': inst.get('sub') or '', 'd': inst.get('code') or '',
                                'u': inst['u'], 'f': inst.get('ifc_file') or '',
                                'g': inst.get('guid') or '', 'lv': 'PI'})
    # 归入批次：按目标 F3 的上下文（F2/F3 名）算桶，并入既有分项槽
    for f3u, fen, leaf, kind in pend:
        d3 = nodes.get(f3u)
        if not d3:
            continue
        t1 = get1(d3, 'SYSTEMNAME1')
        t2 = get1(d3, 'SYSTEMNAME2')
        tscn = get1(d3, 'SYSCLASSIFYNAME')
        tcat, tbucket, _v = unit_bucket(t2, t1, scn_mid(tscn))
        if not tcat:                     # 目标间隔上下文不可辨 → 兜底桶
            tcat, tbucket = '安装工程', '电气装置(IFC挂接)'
        elif tcat == '建筑工程':
            # 装置性材料属安装侧，不能因为目标分项上下文是建筑就落进建筑工程
            tcat, tbucket = '安装工程', '电气装置(IFC挂接)'
        slot = _slot(btv, tcat, tbucket,
                     fen or fen_name(get1(d3, 'SYSTEMNAME3') or '(无名F3)'))
        if kind == '设备':
            slot['dev'] += 1
        else:
            slot['mat'] += 1
        slot['f4s'].append(leaf)
    prog('dev 轨道（%s）：F3 %d · F4 %d · 上树 %d · 跳过 %d · 编码回填 %d · 名称回填 %d · 坐标归位 %d'
         % ('实例' if idx is not None else 'F4', n_f3, n_f4,
            sum(len(s['f4s']) for bs in btv.values() for b in bs.values()
                for s in b['fens'].values()), n_skip, n_code, n_hint, n_home))
    return btv


def dev_stats(btv):
    """dev 树摘要：桶/分项/叶子数与性质分布（供分轨报告用）。

    实例粒度下 `叶子` 只含 gim_element 认定的设备/材料/构件；
    `附件` 是并入主变的台数（中性点成套装置等），不计入叶子。
    """
    st = {'桶': 0, '分项': 0, '叶子': 0, '设备': 0, '装置性材料': 0,
          '构件': 0, '建构筑物': 0, '未分类': 0, '附件': 0}
    for cname, buckets in btv.items():
        st['桶'] += len(buckets)
        for bname, b in buckets.items():
            st['分项'] += len(b['fens'])
            for fen, slot in b['fens'].items():
                st['叶子'] += len(slot['f4s'])
                st['附件'] += slot.get('att', 0)
                for leaf in slot['f4s']:
                    k = leaf.get('k') or '未分类'
                    st[k if k in st else '未分类'] += 1
    return st


def bk_key(n):
    """桶排序：主变最先 → 配电装置按电压降序 → 固定次序 → 其余殿后。"""
    if n.startswith('配电装置'):
        m = re.search(r'(\d+)', n)
        return (1, -int(m.group(1)) if m else 0, _natkey(n))
    rank = {'主变压器系统': 0, '电气装置(IFC挂接)': 1.5, '无功补偿': 2,
            '控制及直流/二次系统': 3, '站用电系统': 4, '电缆及接地': 5}.get(n, 9)
    return (rank, 0, _natkey(n))


# 间隔类型优先级（2026-10-28 用户定版）：出线→进线→EM/PT(母线设备)→母联→分段→其它
BAY_ORDER = [
    (re.compile(r'出线'), 0),
    (re.compile(r'进线'), 1),
    (re.compile(r'EM|PT|母线设备|避雷器'), 2),
    (re.compile(r'母联'), 3),
    (re.compile(r'分段'), 4),
]


def bay_rank(name):
    for rx, r in BAY_ORDER:
        if rx.search(name):
            return r
    return 5


def fen_sort_key(item):
    """分项（间隔）排序：同类间隔聚在一起——
    出线→进线→EM/PT→母联→分段→其它；其它类按尾部类型字母归组
    （10kV 如 1-1C/1-2C 电容器相邻、1-1L 低抗相邻），组内编号升序，无编号殿后。"""
    name, slot = item
    r = bay_rank(name)
    nk = _natkey(name)
    has_num = any(isinstance(t, int) for t in nk)
    n_dev = -(slot['dev'] + slot['mat'])
    if r == 5:
        tail = re.search(r'([A-Za-z]+)\s*$', name)
        tkey = tail.group(1) if tail else '\uffff'   # 无类型字母殿后
        return (r, tkey, nk if has_num else [], name, n_dev)
    return (r, nk if has_num else [], name, n_dev)
