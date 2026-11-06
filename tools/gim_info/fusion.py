# -*- coding: utf-8 -*-
"""fusion —— 融合数据层：GIM↔IFC 挂接键收集、IFC 文件角色词表（四样本+兜底）。"""
import os, re

# ---------------- 融合数据：挂接键 / 文件角色 / 扫描编排 ----------------

RULES_INSTALL = [
    (r'主变区域', '主变压器系统'),
    (r'配电装置', '_配电装置_'),
    (r'电气二次|二次屏柜', '控制及直流/二次系统'),
    (r'接地', '电缆及接地'),
    (r'一次设备|电气设施|设备接线', '一次设备（IFC）'),
]
RULES_BLDG = {          # 四样本专用规则（目录名匹配则优先，与 v5 口径一致）
    'substation01': [
        (r'建筑部分0317|结构0317|暖通布置0317|室内给排水0317|动力照明0317', '主控通信楼(推断)', '建筑'),
        (r'警卫室建筑0317', '警卫室', '建筑'),
        (r'基础0317', '基础工程', '构筑物'),
        (r'给排水消防及排油添加主变水喷淋0401', '消防系统(主变水喷淋)', '构筑物'),
        (r'总图0317', '站区工程(总图/围墙/道路)', '总图'),
    ],
    'substation02': [
        (r'0301-地下夹层及基础|0302-钢结构|0303-檩条系统|04-建筑配电楼|02-夹层支架|06-暖通部分', '配电楼(推断)', '建筑'),
        (r'02-警传室', '警传室', '建筑'),
        (r'场地-主变、散热基础', '主变基础及散热基础', '构筑物'),
        (r'场地-事故油池', '事故油池', '构筑物'),
        (r'场地-化粪池', '化粪池', '构筑物'),
        (r'场地-消防泵房|消防给排水|02-消防喷雾支架', '消防泵房及水喷淋系统', '构筑物'),
        (r'场地-电缆隧道、电缆沟', '电缆隧道及电缆沟', '构筑物'),
        (r'02 场地-围墙|02-电子围栏|02-场坪、道路', '围墙大门及站区道路', '总图'),
    ],
    'substation03': [
        (r'建筑\.ifc|建筑结构\.ifc', '主控楼(建筑+结构,推断)', '建筑'),
        (r'场地结构', '站区构筑物(场地结构)', '构筑物'),
        (r'给排水', '站区给排水', '构筑物'),
        (r'地形及进站道路|总图', '总图(地形/道路)', '总图'),
    ],
    'substation04': [
        (r'配电楼-版本1|配电楼结构-版本1', '配电楼', '建筑'),
        (r'辅助用房-版本1|辅助用房结构-版本1', '辅助用房', '建筑'),
        (r'35kV配电室通风及空调', '35kV配电室', '建筑'),
        (r'主变基础及防火墙', '主变基础及防火墙', '构筑物'),
        (r'主变区域构架', '主变区域构架', '构筑物'),
        (r'110区域构架|构架基础', '110kV区域构架及基础', '构筑物'),
        (r'设备支架|设备基础', '设备支架及基础', '构筑物'),
        (r'独立避雷针', '独立避雷针', '构筑物'),
        (r'室内电缆沟施工图', '室内电缆沟', '构筑物'),
        (r'站区水工布置图', '站区水工布置', '构筑物'),
        (r'总图-版本1', '总图(场地)', '总图'),
    ],
}
RULES_GENERIC = [       # 任意目录的兜底词表（标 ○推断）
    (r'建筑|主控楼|配电楼|用房|警卫|警传', '建筑'),
    (r'基础|防火墙|构架|支架|油池|化粪池|泵房|电缆沟|电缆隧道|水工|避雷针|冷却塔', '构筑物'),
    (r'总图|道路|场地|围墙|地形', '总图'),
]

class Fusion:
    """融合工程树数据层：GIM↔IFC 挂接键、IFC 文件角色、空间扫描结果。"""

    def __init__(self, p):
        self.p = p
        self.smp = os.path.basename(p.root_dir.rstrip('\\/'))
        # 全量挂接键：cbm 内 IFCGUID/IFCFILE 双键（含未分类 F4/PI）
        self.byfile = {}          # ifc文件名小写(无扩展) -> {guid: cbm_uuid}
        self.join_n = 0
        for u, d in p.nodes.items():
            g = f_ = None
            for k, v in d.items():
                ku = k.upper()
                if ku.endswith('IFCGUID') and not g:
                    g = v.strip()
                elif ku.endswith('IFCFILE') and not f_:
                    f_ = v.strip()
                if g and f_:
                    break
            if g and f_:
                fnl = os.path.basename(f_.replace('\\', '/')).lower()
                if fnl.endswith('.ifc'):
                    fnl = fnl[:-4]
                self.byfile.setdefault(fnl, {}).setdefault(g, u)
                self.join_n += 1
        # 目录内全部 IFC 文件（键 = 去扩展名小写，与 byfile 键一致）
        self.files = {}           # 文件名小写(无扩展) -> (显示名, 全路径)
        for base, _, fns in os.walk(p.root_dir):
            for fn in fns:
                if fn.lower().endswith('.ifc'):
                    self.files[os.path.splitext(fn.lower())[0]] = (fn, os.path.join(base, fn))
        # 文件角色
        self.roles = {}           # 文件名小写 -> (role, target, inferred)
        for fl, (disp, _path) in self.files.items():
            self.roles[fl] = self.file_role(disp)
        # 扫描结果
        self.probe = {}           # 文件名小写 -> probe 结果
        self.guidrec = {}         # guid -> rec（跨文件合并）

    def file_role(self, fname):
        for pat, sub in RULES_INSTALL:
            if re.search(pat, fname):
                if sub == '_配电装置_':
                    m = re.search(r'(\d+)\s*kV', fname)
                    sub = '配电装置(%s)' % (m.group(1) + 'kV' if m else '未知电压')
                return '安装', sub, False
        for pat, sub, cat in RULES_BLDG.get(self.smp, []):
            if re.search(pat, fname):
                return cat, sub, False
        for pat, cat in RULES_GENERIC:
            if re.search(pat, fname):
                return cat, '%s(○推断)' % fname, True
        return '其他', fname, True


