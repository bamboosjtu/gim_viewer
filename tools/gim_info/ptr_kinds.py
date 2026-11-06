# -*- coding: utf-8 -*-
"""ptr_kinds —— GIM 指针类型谱系（唯一权威表）

依据三条线索合并而成，详见同目录 `指针类型谱系.md`：

1. 教程《线路GIM文件拆解》PPT P13/P15/P22/P29、`tutorial.py` Step 6~9：
   **三种指针** = 层级边（cbm→cbm）／模型指针（cbm→dev）／属性指针（→fam）。
   判据只看值后缀 + 键不以 .NUM 结尾（P29 第 3 条），不按 UUID / 同名猜。
2. Q/GDW 11809—2023 §6.2 a~f「模型文件引用关系」：
   a 几何 mod/stl；b phm→mod/stl（可同级）；c dev/ifc 物理模型（dev→phm、dev→fam，
   可同级）；d cbm→fam + 补充材料单 *.xml（可同级）；e fam→逻辑描述文件
   （*.icd/*.ipd/*.cpd）生成逻辑模型；f project.cbm 根引用。
3. 研究成果《线路六 GIM 样本结构比对》《线路六样本 F2~F4 语义稳定性分析》
   《变电四样本 IFC 挂接方式对比研究》《基于 Bentley / BIMBase / JinQu / SDDP
   的实际 GIM 数据组织研究》《文件组织与实体识别解耦研究》：
   IFC 轨（文件级整挂 IFCn 与实体级 IFCFILE+IFCGUID）、PARTINDEX 树外索引、
   FileDevRelation 出图 provenance、SUBLOGICALMODEL 逻辑模型、MATERIALSHEET 占位。

结论：**3 大类（教程口径）→ 4 组 9 种语义类型（工程实现口径）**。
其中 7 种以「值 = 目标文件名」出现（L1/L2/M/G/A/I/S），
`U` 是「实体标识」（IFCGUID 是 IFC 内部 GUID，不是文件名），
`D` 里的 MATERIALSHEET / FILEn.NAME 是占位或包外资料——这两类不可跳转，
浏览器按「标识键」单独标注，不做成蓝色链接，也不会被误判成悬空指针。

设计约束：一条指针只能归一类；分类只看「键名族 + 值后缀 + 源/目标文件类型」，
不做实体识别，不读目标文件内容（PARTINDEX 判定例外：读目标 ENTITYNAME）。
"""
from collections import OrderedDict
import re

# ---------------------------------------------------------------- 3 大类
# 前 3 组是教程 P22 的三种指针；第 4 组是变电/逻辑模型研究补出来的旁挂轨。
GROUPS = OrderedDict([
    ('层级', '教程①：cbm 之间「谁挂在谁下面」，构成 F1→F4 工程树（含树外索引）'),
    ('模型', '教程②：从 cbm 换目录到 dev，再沿 dev→phm→mod/stl 下到几何'),
    ('属性', '教程③：按需旁挂 fam 属性文件，cbm 与 dev 都可以有'),
    ('扩展', '研究成果补充：IFC 轨、逻辑模型、材料/出图等旁挂资源'),
])

# ---------------------------------------------------------------- 9 种类型
# code: 短名(树/CSV 里显示) / group / color / keys / targets / basis / note / jumpable
PTR_KINDS = OrderedDict([
    ('L1', dict(
        name='层级下钻', group='层级', color='#1a5fb4',
        keys='SUBSYSTEM / SUBSYSTEMn / SECTIONn / STRAINSECTIONn / GROUPn / '
             'TOWERn / BASEn / STRINGn / BACKSTRING / FRONTSTRING / GROUP',
        targets='cbm → cbm（F1System~F4System + 部件叶）',
        basis='教程 P13/P22；标准 §6.2f、§7.1/7.2；线路六样本键族谱',
        note='值即同目录下一个文件名；跳过去读回 ENTITYNAME 才知道到了第几级。'
             '线路方言的塔/串/基础经 TOWER0/BASEn/STRINGn 挂接，不占结构键。',
        jumpable=True)),
    ('L2', dict(
        name='树外索引', group='层级', color='#6f42c1',
        keys='SUBDEVICEn → PARTINDEX / PARTINDEX / FILEn.DEVn / SUBLOGICALMODELn 以外'
             '的索引型 cbm 引用',
        targets='cbm → cbm（ENTITYNAME=PARTINDEX 或 FileDevRelation 映射）',
        basis='变电研究 11.2 PartIndex、11.7 FileDevRelation；解耦研究 §5.1',
        note='同为 cbm→cbm，但目标不在工程层级树上：要么是装置索引节点，'
             '要么是出图清单映射。混进 L1 会把树遍历成错误的父子层级。',
        jumpable=True)),
    ('M', dict(
        name='模型锚点', group='模型', color='#0f766e',
        keys='OBJECTMODELPOINTER',
        targets='cbm → dev',
        basis='教程 P15/P22（line04 343 条全在部件级）；标准 §6.2c',
        note='换目录的第一跳。部件 cbm 里没有 DEVICETYPE，类型要跟到 dev 才读得到。',
        jumpable=True)),
    ('G', dict(
        name='几何装配', group='模型', color='#57606a',
        keys='SOLIDMODELn / SUBDEVICEn（源为 dev / phm）',
        targets='dev → dev/phm，phm → phm/mod/stl',
        basis='教程 P17/Step10④；标准 §6.2a~c（可同级引用、不得自引用）',
        note='变电 Dev 用 SUBDEVICEn→.dev；线路 Dev 用 SOLIDMODELn→.dev/.phm，'
             '照搬一种键名会一条也找不到。与 TRANSFORMMATRIXn/COLORn 同下标配对。',
        jumpable=True)),
    ('A', dict(
        name='属性族', group='属性', color='#8a6d3b',
        keys='BASEFAMILY / BASEFAMILY1..n',
        targets='cbm / dev → fam',
        basis='教程 P16/P22/Step 9；标准 §6.2c、§6.2d',
        note='按需关联、不是一对一：F3 级有 1~4 四个槽位，F4 塔组常为空值；'
             'line03 的 dev 与 fam 完全异名，只能按指针配对，不能按同名猜。',
        jumpable=True)),
    ('I', dict(
        name='IFC 挂接', group='扩展', color='#c25e00',
        keys='IFCFILE / IFCn / FILEn.IFC',
        targets='cbm → ifc',
        basis='标准 §6.2c（变电土建以 ifc 描述）；变电四样本 IFC 挂接方式对比研究',
        note='两种方言：s01 逐实体直指（IFCFILE+IFCGUID），s02/s03 在 F1 用 '
             'IFC.NUM+IFC0..n 文件级整挂。线路六样本此类型全为 0。',
        jumpable=True)),
    ('U', dict(
        name='IFC 实体标识', group='扩展', color='#a06800',
        keys='IFCGUID',
        targets='cbm → IFC 文件内部实体（22 位 GUID，非文件名）',
        basis='变电四样本 IFC 挂接方式对比研究（s01 逐实体直指）',
        note='不是文件指针、不能跳转：与 IFCFILE 成对出现，指向 IFC 文件里的某个实体。'
             '界面必须把它和普通链接区分开，否则会被误判成悬空指针。',
        jumpable=False)),
    ('S', dict(
        name='逻辑模型', group='扩展', color='#8250df',
        keys='SCH / SUBLOGICALMODELn / LOGICALMODEL* / 逻辑描述文件',
        targets='project.cbm / fam → sch、sld、std、icd、ipd、cpd、逻辑 cbm',
        basis='标准 §6.2e；Bentley 研究 2.2（SUBLOGICALMODEL0 空容器）、BIMBase 研究',
        note='s01 的 project.cbm 有 SCH=project.sch；fam 里的「逻辑描述文件」多为 '
             '占位符 /。这一族常被只看七种模型后缀的解析器整体漏掉。',
        jumpable=True)),
    ('D', dict(
        name='材料与出图', group='扩展', color='#6b7684',
        keys='MATERIALSHEET / FILEn.NAME / 其它资料型后缀',
        targets='cbm → xml / DGN（占位或包外文件）',
        basis='标准 §6.2d（补充材料单 *.xml）；六样本 F2~F4 语义稳定性分析；'
              '变电研究 11.7 FileDevRelation',
        note='MATERIALSHEET 在六份线路样本里 6/6 出现且全部为空；FILEn.NAME 是 '
             '出图文件图号名（.DGN 不在 GIM 四目录内）。空值不等于没有这个键。',
        jumpable=False)),
])

KIND_ORDER = tuple(PTR_KINDS)
KIND_NAME = {k: v['name'] for k, v in PTR_KINDS.items()}
KIND_GROUP = {k: v['group'] for k, v in PTR_KINDS.items()}
KIND_COLOR = {k: v['color'] for k, v in PTR_KINDS.items()}
KIND_BASIS = {k: v['basis'] for k, v in PTR_KINDS.items()}
KIND_NOTE = {k: v['note'] for k, v in PTR_KINDS.items()}

# ---------------------------------------------------------------- 后缀
# 教程/标准的七种模型文件后缀（可跳转指针的主体）
CORE_EXT = ('.cbm', '.dev', '.fam', '.phm', '.mod', '.stl', '.ifc')
# 标准 §6.2d/e 的资料与逻辑模型后缀；s01 实测 project.cbm 有 SCH=project.sch
LOGIC_EXT = ('.sch', '.sld', '.std', '.icd', '.ipd', '.cpd', '.gl')
AUX_EXT = ('.xml', '.dgn')
PTR_EXT = CORE_EXT + LOGIC_EXT + AUX_EXT

# 键名族（大写、去尾部数字后匹配）
RX_NUMKEY = re.compile(r'\.NUM$', re.I)
RX_IFCGUID = re.compile(r'^IFCGUID$', re.I)
RX_MATSHEET = re.compile(r'^MATERIALSHEET$', re.I)
RX_FILE_NAME = re.compile(r'^FILE\d+\.NAME$', re.I)
RX_FILE_DEV = re.compile(r'^FILE\d+\.DEV\d+$', re.I)
RX_FILE_IFC = re.compile(r'^FILE\d+\.IFC$', re.I)
RX_LOGIC = re.compile(r'^(SCH|SUBLOGICALMODEL\d*|LOGICALMODEL\w*|逻辑描述文件)$', re.I)
RX_BASEFAMILY = re.compile(r'^BASEFAMILY\d*$', re.I)
RX_OMP = re.compile(r'^OBJECTMODELPOINTER$', re.I)
RX_GEO = re.compile(r'^(SOLIDMODEL|SUBDEVICE)\d*$', re.I)
RX_IFCFILE = re.compile(r'^(IFCFILE|IFC\d+)$', re.I)

# 明确「不是指针」但容易误判的三类配套键（教程 P11/P29）
EXCLUDES = OrderedDict([
    ('计数键', dict(keys='*.NUM（SUBSYSTEMS.NUM / GROUPS.NUM / SOLIDMODELS.NUM / IFC.NUM …）',
                    why='值是个数不是文件名；数量为 0 时字段仍要输出，'
                        '「有键无值」≠「没这个键」（教程 P11）')),
    ('配套参数', dict(keys='TRANSFORMMATRIXn / COLORn / BLHA / PARTNAME / SYSCLASSIFYNAME',
                    why='与 SOLIDMODELn 同下标的位姿、颜色、地理锚点，'
                        '是这一条边的属性，不是另一条边')),
    ('同名伴生', dict(keys='dev↔fam 同 UUID、.mod↔.gl 同 UUID、F1↔fam 同 UUID',
                    why='导出端命名习惯，不是引用关系；line03 的 dev 与 fam '
                        '完全异名仍 100% 可达，配对只能看 BASEFAMILY 指针')),
])


def key_family(key):
    """键名归一族（去尾部序号），仅用于分类与展示。"""
    return re.sub(r'\d+$', 'n', (key or '').upper())


def classify(key, value, src_ext='', target_ext='', target_entity='', src_name=''):
    """一条键值 → 9 种类型之一。

    key/value  : 原始键与值；
    src_ext    : 来源文件后缀（cbm/dev/phm/…），无点；
    target_ext : 目标后缀（由值的扩展名得到），无点；
    target_entity : 目标 cbm 的 ENTITYNAME（仅 L1/L2 区分时需要，可为空）；
    src_name   : 来源文件名（用于识别 FileDevRelation.cbm）。
    """
    ku = (key or '').upper().strip()
    v = (value or '').strip()
    te = (target_ext or '').lower().lstrip('.')
    se = (src_ext or '').lower().lstrip('.')
    ent = (target_entity or '').upper()

    # ① 非文件型标识 / 占位（不进指针集合，但界面要单独标出）
    if RX_IFCGUID.match(ku):
        return 'U'
    if RX_MATSHEET.match(ku) or RX_FILE_NAME.match(ku):
        return 'D'

    # ② 键名优先：逻辑模型、属性族、模型锚点、IFC
    if RX_LOGIC.match(ku) or ('逻辑描述' in ku) or te in ('sch', 'sld', 'std',
                                                         'icd', 'ipd', 'cpd', 'gl'):
        return 'S'
    if RX_BASEFAMILY.match(ku) or te == 'fam':
        return 'A'
    if RX_OMP.match(ku):
        return 'M'
    if RX_IFCFILE.match(ku) or RX_FILE_IFC.match(ku) or te == 'ifc':
        return 'I'

    # ③ 几何链：dev/phm 的同级与下级装配
    if se in ('dev', 'phm') and (RX_GEO.match(ku) or te in ('dev', 'phm', 'mod', 'stl')):
        return 'G'
    if te in ('dev', 'phm', 'mod', 'stl'):
        return 'M' if se == 'cbm' else 'G'

    # ④ cbm → cbm：工程树层级 vs 树外索引
    if te == 'cbm':
        if (ent == 'PARTINDEX' or 'PARTINDEX' in ku or RX_FILE_DEV.match(ku)
                or 'filedevrelation' in (src_name or '').lower()):
            return 'L2'
        return 'L1'

    # ⑤ 其余带资料后缀的关联（xml/dgn 等）
    return 'D'


def kind_name(code):
    return KIND_NAME.get(code, '未知')


def kind_group(code):
    return KIND_GROUP.get(code, '扩展')


def kind_tooltip(code):
    """界面提示只说「这是什么、看哪些键、指向什么」，不写标准依据与教程说明。"""
    k = PTR_KINDS.get(code)
    if not k:
        return ''
    return '【%s · %s】\n键名族：%s\n指向：%s' % (
        k['name'], k['group'], k['keys'], k['targets'])


def _selftest():
    """覆盖 9 类各一条真实键；分类错误直接抛。"""
    cases = [
        ('L1', 'SUBSYSTEM0', 'a.cbm', 'cbm', 'cbm', 'F2System', ''),
        ('L1', 'TOWER0', 'a.cbm', 'cbm', 'cbm', 'TOWER_DEVICE', ''),
        ('L2', 'SUBDEVICE0', 'a.cbm', 'cbm', 'cbm', 'PARTINDEX', ''),
        ('L2', 'FILE4.DEV0', 'a.cbm', 'cbm', 'cbm', 'F4System', 'FileDevRelation.cbm'),
        ('M', 'OBJECTMODELPOINTER', 'a.dev', 'cbm', 'dev', '', ''),
        ('G', 'SOLIDMODEL0', 'a.phm', 'dev', 'phm', '', ''),
        ('G', 'SOLIDMODEL1', 'a.stl', 'phm', 'stl', '', ''),
        ('A', 'BASEFAMILY', 'a.fam', 'cbm', 'fam', '', ''),
        ('A', 'BASEFAMILY3', 'a.fam', 'dev', 'fam', '', ''),
        ('I', 'IFCFILE', 'a.ifc', 'cbm', 'ifc', '', ''),
        ('I', 'IFC0', 'a.ifc', 'cbm', 'ifc', '', ''),
        ('I', 'FILE1.IFC', 'a.ifc', 'cbm', 'ifc', '', ''),
        ('U', 'IFCGUID', '3IkIXpOtfAOw9VSEpBZvgb', 'cbm', '', '', ''),
        ('S', 'SCH', 'project.sch', 'cbm', 'sch', '', 'project.cbm'),
        ('S', 'SUBLOGICALMODEL0', 'a.cbm', 'cbm', 'cbm', 'LOGICALMODEL', ''),
        ('S', '逻辑描述文件', '/', 'fam', '', '', ''),
        ('D', 'MATERIALSHEET', '', 'cbm', '', '', ''),
        ('D', 'FILE0.NAME', '电气二次0317', 'cbm', '', '', 'FileDevRelation.cbm'),
    ]
    bad = []
    for want, k, v, se, te, ent, src in cases:
        got = classify(k, v, se, te, ent, src)
        if got != want:
            bad.append((want, got, k, v))
    return bad


if __name__ == '__main__':
    bad = _selftest()
    print('指针类型: %d 种（%d 大类）' % (len(PTR_KINDS), len(GROUPS)))
    for code, k in PTR_KINDS.items():
        print('  %-3s %-8s %-4s %s' % (code, k['name'], k['group'], k['keys'][:58]))
    print('排除项  :', ', '.join(EXCLUDES))
    print('自检    :', 'FAIL %s' % bad if bad else 'PASS')
    if bad:
        raise SystemExit(1)
