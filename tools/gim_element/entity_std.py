# -*- coding: utf-8 -*-
"""entity_std.py —— 工程实体标准化层（标准见同目录 01/02/03 三份 .md）

职责：把 devtype_class 判出的「目录类别」再翻译成标准的三样东西——
  1. 编码：设备 E01–E19 / E-T，材料 M01–M09，构件 C-A1…C-D6，其他 U-*；
  2. 标准类别名：目录出处（2018/2025 条目）与工程类别分开保留；
  3. 状态：confirmed（已确认）/ candidate（候选）/ unresolved（未确认）。

粒度原则（01 §1、02 §1）：
  - 工程实体以「施工运维可整体识别」为单位，源文件的 F2/F3/F4、CBM/DEV 拆件都不是粒度依据；
  - 整体内部组成（单相本体、散热器、柜体、端子排、螺栓、绝缘子串内金具球）只作来源成员；
  - 有独立子装配/对象身份的（如主变 DEV 内嵌、但自己有 .dev 与 OMP 的端子箱）不吞入本体。

本模块只读词表、不改词表：devtype_class 仍是词域唯一真源（03-模型渲染 同源副本）。
"""
import re
import json
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# 1. 目录编码
# ---------------------------------------------------------------------------
# 目录类别（devtype_class 的 cat） → (编码, 标准类别名)
DEV_CODE = {
    '主变压器': ('E01', '主变压器'),
    '高压并联电抗器': ('E02', '高压并联电抗器'),
    '站用变压器': ('E03', '站用变压器'),
    '消弧线圈及接地变成套': ('E04', '消弧线圈、小电阻及接地变成套装置'),
    '组合电器（GIS/HGIS）': ('E05', '组合电器 GIS/HGIS'),
    '断路器': ('E06', '断路器'),
    '隔离开关': ('E07', '隔离开关'),
    '接地开关': ('E08', '接地开关'),
    '开关柜': ('E09', '开关柜'),
    '并联电容器成套装置': ('E10', '并联电容器成套装置'),
    '低压并联电抗器': ('E11', '低压并联电抗器'),
    '静止无功发生器（SVG）': ('E12', '静止无功发生器 SVG'),
    '电流互感器': ('E13', '电流互感器'),
    '电压互感器': ('E14', '电压互感器'),
    '避雷器': ('E15', '避雷器'),
    '二次设备': ('E16', '二次设备'),
    '动力辅助设施': ('E17', '动力辅助设备'),
    '预制舱': ('E18', '预制舱开关设备'),
    '水工暖通设施': ('E19', '水工暖通设备'),
    '变压器（用途待确认）': ('E-T', '变压器（用途待确认）'),
}

MAT_CODE = {
    '导线': ('M01', '导线'),
    '母线': ('M02', '母线'),
    '金具': ('M03', '金具'),
    '绝缘子': ('M04', '绝缘子'),
    '电缆': ('M05', '电缆'),
    '接地材料': ('M06', '接地材料'),
    '套管': ('M07', '套管'),
    '槽盒': ('M08', '槽盒'),
    '其他材料': ('M09', '其他材料'),
}

# (构件大类, 子类) → (编码, 标准子类名)；编码沿用 03-材料与构件目录 §2
CON_CODE = {
    ('建筑本体构件', '墙体'): ('C-A1', '墙体'),
    ('建筑本体构件', '楼板'): ('C-A2', '楼板'),
    ('建筑本体构件', '柱'): ('C-A3', '柱'),
    ('建筑本体构件', '梁'): ('C-A4', '梁'),
    ('建筑本体构件', '板'): ('C-A5', '板'),
    ('建筑本体构件', '屋面'): ('C-A6', '屋面'),
    ('建筑本体构件', '门'): ('C-A7', '门'),
    ('建筑本体构件', '窗'): ('C-A8', '窗'),
    ('建筑本体构件', '楼梯与栏杆'): ('C-A9', '楼梯与栏杆'),
    ('建筑本体构件', '面层与装修'): ('C-A10', '面层与装修'),
    ('结构构架与基础', '设备支架'): ('C-B1', '设备支架'),
    ('结构构架与基础', '设备基础'): ('C-B2', '设备基础'),
    ('结构构架与基础', '建筑物基础'): ('C-B3', '建筑物基础'),
    ('结构构架与基础', '基础（未分）'): ('C-B4', '基础（未分）'),
    ('结构构架与基础', '型钢与钢板'): ('C-B5', '型钢与钢板'),
    ('结构构架与基础', '檩条'): ('C-B6', '檩条'),
    ('结构构架与基础', '构架与支撑'): ('C-B7', '构架与支撑'),
    ('水工与总图构件', '电缆沟'): ('C-C1', '电缆沟'),
    ('水工与总图构件', '排水沟'): ('C-C2', '排水沟'),
    ('水工与总图构件', '检查井与池'): ('C-C3', '检查井与池'),
    ('水工与总图构件', '围墙与围栏'): ('C-C4', '围墙与围栏'),
    ('水工与总图构件', '道路与地坪'): ('C-C5', '道路与地坪'),
    ('附属设施', '照明器具'): ('C-D1', '照明器具'),
    ('附属设施', '消防设施'): ('C-D2', '消防设施'),
    ('附属设施', '安防监控'): ('C-D3', '安防监控'),
    ('附属设施', '暖通设施'): ('C-D4', '暖通设施'),
    ('附属设施', '给排水设施'): ('C-D5', '给排水设施'),
    ('附属设施', '其他附属设施'): ('C-D6', '其他附属设施'),
    ('建筑本体构件', '其他构件'): ('U-OBJECT', '构件（未细分）'),
}

# Category labels are the shared project catalog; occurrence/ledger policies
# intentionally remain independent between this reference tool and desktop.
_catalog_path = (Path(sys._MEIPASS) / 'catalog.json') if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent / 'catalog.json'
_catalog = json.loads(_catalog_path.read_text(encoding='utf-8'))
_labels = {entry['code']: entry['label'] for entry in _catalog['categories']}
DEV_CODE = {key: (code, _labels[code]) for key, (code, _) in DEV_CODE.items()}
MAT_CODE = {key: (code, _labels[code]) for key, (code, _) in MAT_CODE.items()}
CON_CODE = {key: (code, _labels[code] if code != 'U-OBJECT' else label) for key, (code, label) in CON_CODE.items()}
for _entry in _catalog['categories']:
    if '.' in _entry['code'] or _entry['code'] == 'U-OBJECT':
        continue
    if _entry['group'] == 'equipment':
        DEV_CODE.setdefault(_entry['label'], (_entry['code'], _entry['label']))
    elif _entry['group'] == 'materials':
        MAT_CODE.setdefault(_entry['label'], (_entry['code'], _entry['label']))
    elif _entry['group'] == 'components':
        CON_CODE.setdefault(('标准索引构件', _entry['label']), (_entry['code'], _entry['label']))

# 其他组的性质编码（01 §2 分层：来源 / 组织包装 / 未识别）
OTH_CODE = {
    '空间骨架': ('U-SPACE', '空间骨架'),
    '型号模板': ('U-TYPE', '型号模板'),
    '端口与系统': ('U-PORT', '端口与系统'),
    '无名称产品实体': ('U-NONAME', '无名称产品实体'),
    '同名异物（排除词）': ('U-EXCL', '同名异物'),
    '内部来源（紧固件）': ('U-INTERNAL', '内部来源·紧固件'),
    '待归整体（中性点装置）': ('U-PENDING', '待归整体·中性点装置'),
    '间隔/系统名': ('U-ORG', '组织包装·间隔系统名'),
    '分组': ('U-ORG', '组织包装·IFC 组'),
    '尺寸占位名': ('U-SIZE', '尺寸占位名'),
    '无法识别': ('U-OBJECT', '未识别（词域外）'),
}

# ---------------------------------------------------------------------------
# 2. E16 / E17 / E19 的细分类（标准 §1「E16 至少细分…E17、E19 保留具体设备类型」）
# ---------------------------------------------------------------------------
E16_SUB = [
    (r'端子箱', 'terminal_box', '端子箱'),
    (r'蓄电池|电池组', 'battery_set', '蓄电池组'),
    (r'控制柜|汇控柜|智能控制|监控柜|监测柜', 'control_cabinet', '控制柜'),
    (r'屏柜|保护屏|测控屏|二次屏|通信屏|电能表屏|辅助屏|机柜|'
     r'保护[a-z0-9]*柜|测控柜|智能柜|电能表柜|就地柜|故障录波', 'panel_cabinet', '屏柜'),
]
E16_LABEL = {code: label for _p, code, label in E16_SUB}


def dev_sub_label(code):
    """E16 子类编码 → 中文名（供界面显示，未知原样返回）。"""
    return E16_LABEL.get(code, code or '')
E17_WORDS = r'检修箱|照明箱|配电箱|动力箱|接地箱|分支箱|动力照明箱|馈线箱|机构箱|电源切换箱|' \
            r'电源系统柜|电缆终端|低压配电屏|配电屏|直流屏|交流电源'
E19_WORDS = r'风机|水泵|潜水泵|灭火器|空调|除湿机|通风|喷淋|雨淋|水喷雾|消防|水暖'

# ---------------------------------------------------------------------------
# 3. 边界判定（01 §1 / 03 §3）
# ---------------------------------------------------------------------------
# 紧固件：不因 IFC 独立暴露就新建工程实体，保留为内部/待归来源
FASTENER = re.compile(
    r'螺栓|螺母|垫圈|螺钉|螺柱|锚栓|销轴|开口销|膨胀螺栓|化学锚栓|'
    r'(?<![a-z])bolt|nut|washer|screw(?![a-z])', re.I)

# 只有变压器类型、没有主变/站用用途证据 → E-T（不能一律归 E01）
TRANS_ONLY = re.compile(r'变压器')
TRANS_MAIN = re.compile(r'主变|站用|所用|接地变|厂用|启备|箱变|干式变|油浸变')
TRANS_GENERIC = re.compile(r'变压器模型|变压器组件|变压器本体|变压器样品|变压器$')


def is_fastener(name):
    """是否紧固件（螺栓/螺母/垫圈…）——不进构件实体。"""
    return bool(FASTENER.search(name or ''))


def transformer_unresolved(name):
    """变压器只有类型、没有用途证据 → True（落 E-T 候选）。"""
    n = name or ''
    if not TRANS_ONLY.search(n):
        return False
    return not TRANS_MAIN.search(n)


_NUM_CODE = re.compile(r'^([EM])(\d+)$')
_CON_CODE = re.compile(r'^C-([A-Z])(\d+)$')
# E16 细分的固定顺序（与 E16_SUB 定义顺序一致：端子箱→蓄电池→控制柜→屏柜）
E16_SEQ = {code: i for i, (_p, code, _l) in enumerate(E16_SUB)}
# 「其他」组顺序（01 §2 分层：来源 → 组织包装 → 未识别殿后）
OTH_SEQ = {c: i for i, c in enumerate((
    'U-SPACE', 'U-TYPE', 'U-SIZE', 'U-PORT', 'U-NONAME',
    'U-EXCL', 'U-INTERNAL', 'U-PENDING', 'U-ORG'))}


def order_key(code):
    """目录编码排序键——界面与报告一律按目录顺序，不按数量。

    设备 E01→E19 → E-T（用途待确认）→ U-*；材料 M01→M07；
    构件 C-A1→C-A10 → C-B1… → C-D6 → 未细分；
    其他 U-SPACE…U-ORG → 未识别（U-OBJECT）殿后。
    """
    c = (code or '').strip().upper()
    m = _NUM_CODE.match(c)
    if m:
        return (0, 0 if m.group(1) == 'E' else 1, int(m.group(2)), 0)
    if c == 'E-T':
        return (0, 2, 0, 0)
    m = _CON_CODE.match(c)
    if m:
        return (1, ord(m.group(1)) - ord('A'), int(m.group(2)), 0)
    if c in OTH_SEQ:
        return (2, OTH_SEQ[c], 0, 0)
    return (9, 0, 0, 0)


def code_of(group, cat, sub=''):
    """→ (编码, 标准类别名)。未知返回 (U-OBJECT, 原名)。"""
    if group == '设备':
        return DEV_CODE.get(cat, ('U-OBJECT', cat or '未识别'))
    if group == '装置性材料':
        return MAT_CODE.get(cat, ('U-OBJECT', cat or '未识别'))
    if group == '构件':
        return CON_CODE.get((cat, sub), CON_CODE.get(('建筑本体构件', '其他构件'),
                                                     ('U-OBJECT', sub or cat or '未识别')))
    return OTH_CODE.get(cat, ('U-OBJECT', cat or '未识别'))


def dev_sub(cat, name):
    """设备细分类 → (subcode, 名称)；非 E16/E17/E19 返回 ('', '')。

    标准 §1：E16 至少细分 terminal_box / panel_cabinet / control_cabinet / battery_set；
    E17、E19 保留具体设备类型，不能都显示成「辅助设施」。
    """
    if cat == '二次设备':
        for pat, code, label in E16_SUB:
            if re.search(pat, name or '', re.I):
                return code, label
        return 'panel_cabinet', '屏柜'
    if cat in ('动力辅助设施', '水工暖通设施'):
        pat = E17_WORDS if cat == '动力辅助设施' else E19_WORDS
        m = re.search(pat, name or '', re.I)
        return (m.group(0), m.group(0)) if m else ('', '')
    return '', ''


# ---------------------------------------------------------------------------
# 4. 证据状态（02 §4：目录映射与组合关联分别给 confirmed / candidate / unresolved）
# ---------------------------------------------------------------------------
ST_OK, ST_CAND, ST_UNC = '已确认', '候选', '未确认'


def status_of(track, group, cat, name='', sub=''):
    """按目录映射的证据强度给状态（轨道不同只影响来源列，不影响映射结论）。

    已确认   名称命中专属词条，且类型/名称相互印证；
    候选     只有型号、用途待定（E-T）、或仅靠 DEV.TYPE 兜底；
    未确认   词域外、无名称、占位名。
    """
    if group == '其他' or not name:
        return ST_UNC
    if cat == '变压器（用途待确认）':
        return ST_CAND
    return ST_OK
