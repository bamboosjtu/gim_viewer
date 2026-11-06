# -*- coding: utf-8 -*-
"""gim_gui —— PySide6 图形界面：融合工程树（v5）/GIM 原生树双视图 + 属性面板。
PySide6 在 run_gui 内延迟导入，CLI 冒烟测试无需安装 Qt。"""
import os, re, sys, time, traceback, threading, collections

from diag import _log, LOG_PATH
from gim_core import Project, get1, _natkey, fam_kv, kv
from ifc_probe import ifc_probe_file, cn_type, PSEUDO_NAMES
from fusion import Fusion
from ifc_lookup import IfcLookup
from btv_class import build_btv, KIND_TAG, bk_key, fen_sort_key
from dev_inst import DeviceIndex, dev_stats
from btv_file import build_file_tree, group_by_cbm, file_stats
import bay_infer

# ---------------- PySide6 GUI ----------------

C_GIM = None            # 默认前景（GIM）
C_IFC = '#0b6e4f'       # IFC 来源：青绿
C_BOTH = '#8a2b0d'      # GIM+IFC 挂接：橙红
C_DGN = '#57606a'       # DGN 图纸轨：灰
C_WARN = '#b3261e'      # 未命中/未解决：红

UR = 0                  # UserRole 槽位（相对偏移，运行时绑定）
UR1, UR2, UR3 = 1, 2, 3


def run_gui(init_dir=None, selftest=False):
    from PySide6 import QtWidgets, QtCore, QtGui

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication(sys.argv)
    app.setApplicationName('GIM 信息阅读器')

    def _excepthook(t, v, tb):
        _log('未捕获异常 %s:\n%s' % (t.__name__,
                                    ''.join(traceback.format_exception(t, v, tb))))
        try:
            QtWidgets.QMessageBox.critical(
                None, '程序错误',
                ''.join(traceback.format_exception(t, v, tb))[-2500:])
        except Exception:
            pass
    sys.excepthook = _excepthook
    _log('启动：argv=%s frozen=%s log=%s' %
         (sys.argv, getattr(sys, 'frozen', False), LOG_PATH))

    win = QtWidgets.QMainWindow()
    win.setWindowTitle('GIM 信息阅读器（融合工程树·不含模型显示）')
    win.resize(1360, 800)
    proj = {'obj': None, 'fusion': None, 'mode': 0, 'u2iid': {},
            'fam_of': {}, 'dev_of': {}, 'fam_members': collections.defaultdict(list),
            'dev_members': collections.defaultdict(list),
            'bld_item': None, 'un_item': None, 'inst_item': None, 'btv': None,
            'idx': None, 'file_rows': None,
            'scan': None, 'bayinf': {}}
    global UR, UR1, UR2, UR3
    UR = QtCore.Qt.ItemDataRole.UserRole
    UR1 = QtCore.Qt.ItemDataRole.UserRole + 1
    UR2 = QtCore.Qt.ItemDataRole.UserRole + 2
    UR3 = QtCore.Qt.ItemDataRole.UserRole + 3

    # ---- 工具栏 ----
    tb = QtWidgets.QToolBar()
    tb.setMovable(False)
    win.addToolBar(tb)
    act_open = tb.addAction('打开 GIM 目录…')
    tb.addSeparator()
    tb.addWidget(QtWidgets.QLabel('视图:'))
    mode_box = QtWidgets.QComboBox()
    mode_box.addItems(['融合工程树（BTV 组成层级）', 'GIM 原生树', '按文件（cbm → dev）'])
    tb.addWidget(mode_box)
    tb.addSeparator()
    tb.addWidget(QtWidgets.QLabel('搜索:'))
    qbox = QtWidgets.QLineEdit()
    qbox.setPlaceholderText('名称关键字 / guid:文件名 / ifcguid:实体GUID（回车搜索）')
    qbox.setFixedWidth(380)
    tb.addWidget(qbox)
    act_search = tb.addAction('搜索')

    # ---- 主区分栏 ----
    split = QtWidgets.QSplitter()
    win.setCentralWidget(split)

    tree = QtWidgets.QTreeWidget()
    tree.setHeaderLabels(['名称', '来源'])
    tree.setColumnWidth(0, 560)
    tree.setColumnWidth(1, 110)
    split.addWidget(tree)

    right = QtWidgets.QWidget()
    rv = QtWidgets.QVBoxLayout(right)
    rv.setContentsMargins(0, 0, 0, 0)
    info = QtWidgets.QLabel('（未选中节点）')
    info.setWordWrap(True)
    rv.addWidget(info)
    atv = QtWidgets.QTableWidget(0, 3)
    atv.setHorizontalHeaderLabels(['来源', '属性', '值'])
    atv.horizontalHeader().setSectionResizeMode(1, QtWidgets.QHeaderView.Interactive)
    atv.horizontalHeader().setSectionResizeMode(2, QtWidgets.QHeaderView.Stretch)
    atv.setColumnWidth(0, 150)
    atv.setColumnWidth(1, 230)
    atv.setEditTriggers(QtWidgets.QAbstractItemView.NoEditTriggers)
    atv.setAlternatingRowColors(True)
    rv.addWidget(atv)
    split.addWidget(right)
    split.setSizes([680, 680])

    status = QtWidgets.QStatusBar()
    win.setStatusBar(status)
    status.showMessage('请打开 GIM 样本目录（内含 *.cbm，如 gim_demo/substation01）')

    def set_src(it, text, color=None):
        it.setText(1, text)
        if color:
            it.setForeground(1, QtGui.QBrush(QtGui.QColor(color)))

    # ================= GIM 子树（两种模式共用） =================
    def attach_drill(it, u):
        """F4 设备项挂 FAM▸/DEV▸ 下钻节点（惰性展开）。"""
        fo, do = proj['fam_of'].get(u), proj['dev_of'].get(u)
        if fo:
            pf = QtWidgets.QTreeWidgetItem(
                ['FAM▸%s（%d台）' % (fo[:16], len(proj['fam_members'][fo])), 'GIM·fam'])
            pf.setData(0, UR1, 'fam')
            pf.setData(0, UR2, fo)
            pf.setChildIndicatorPolicy(
                QtWidgets.QTreeWidgetItem.ChildIndicatorPolicy.ShowIndicator)
            for c in (0, 1):
                pf.setForeground(c, QtGui.QBrush(QtGui.QColor('#0b6e4f')))
            it.addChild(pf)
        if do:
            pd = QtWidgets.QTreeWidgetItem(['DEV▸%s' % do[:16], 'GIM·dev'])
            pd.setData(0, UR1, 'dev')
            pd.setData(0, UR2, do)
            pd.setChildIndicatorPolicy(
                QtWidgets.QTreeWidgetItem.ChildIndicatorPolicy.ShowIndicator)
            for c in (0, 1):
                pd.setForeground(c, QtGui.QBrush(QtGui.QColor('#4a5a8a')))
            it.addChild(pd)

    def gim_item(u, parent_item=None):
        """GIM cbm 节点 → 树项（融合树与原生树共用；来源列标 GIM）。"""
        p = proj['obj']
        lv = p.level(u)
        nm = p.disp(u)
        label = nm if nm else u[:8]
        src, color = 'GIM·cbm', None
        if lv == 'F4':
            g = p.nodes[u].get('IFCGUID')
            if g:
                label += '  ⚡IFC'
                src, color = 'GIM+IFC', C_BOTH
            if not p.display.get(u):
                label += '  (无名)'
        elif lv == 'PI':
            label += ' ·PI'
        it = QtWidgets.QTreeWidgetItem([label, src])
        it.setData(0, UR, u)
        if color:
            it.setForeground(0, QtGui.QBrush(QtGui.QColor(color)))
            set_src(it, src, color)
        if parent_item is None:
            tree.addTopLevelItem(it)
        else:
            parent_item.addChild(it)
        proj['u2iid'][u] = it
        # FAM/DEV 下钻仅挂 F4 设备（F1/F2/F3 的 BASEFAMILY 是系统族，自引用无意义）
        if lv == 'F4':
            attach_drill(it, u)
        for c in p.children.get(u, []):
            gim_item(c, it)
        return it

    # ================= 融合树：安装工程（BTV 业务树口径） =================
    def btv_leaf(lf, fuz):
        """BTV 叶子：[设/材/构] 编码 名称 ｜ 类别 ⇢IFC·名●（实例粒度，编码来自 gim_element）。"""
        kind = lf.get('k') or '?'
        tag = KIND_TAG.get(kind, '[?]')
        label = '%s %s' % (tag, lf.get('n') or '(无名)')
        if lf.get('d'):
            label = '%s %s  %s' % (tag, lf['d'], lf.get('n') or '(无名)')
        if lf.get('c'):
            label += ' ｜ %s' % lf['c']
        if lf.get('s'):
            label += '·%s' % lf['s']
        if lf.get('lv') == 'PI':
            label += ' ·PI'
        g = lf.get('g')
        rec = fuz.guidrec.get(g) if g else None
        color = None
        if rec is not None:
            if rec.get('miss'):
                label += '  ⇢IFC·声明未找到▲'
                color = C_WARN
            else:
                nmv = rec.get('n') or rec.get('t') or 'IFC实体'
                if len(nmv) > 24:
                    nmv = nmv[:24] + '…'
                label += '  ⇢IFC·%s●' % nmv
                color = C_BOTH
            # 坐标推断归入本间隔的收纳位散材（叶子已挂到推断间隔节点下）
            inf = (proj.get('bayinf') or {}).get(g)
            if inf:
                label += '  (坐标推断%.0fm%s)' % (inf['d'], '△' if inf.get('low') else '')
        it = QtWidgets.QTreeWidgetItem([label, 'GIM·cbm'])
        u = lf['u']
        it.setData(0, UR, u)
        proj['u2iid'][u] = it
        if color is None:
            color = {'装置性材料': '#8a2b0d', '建构筑物': '#57606a'}.get(kind) \
                    or (C_WARN if kind in ('未分类', '占位', '未分类(名占位)') else None)
        if color:
            it.setForeground(0, QtGui.QBrush(QtGui.QColor(color)))
            it.setForeground(1, QtGui.QBrush(QtGui.QColor(color)))
        attach_drill(it, u)
        return it

    def render_install_btv():
        """安装工程 = BTV 设备类别桶 → 分项(F3) → 逐台 F4；尾部 DGN 图纸轨 + 未归属。"""
        inst_item = proj['inst_item']
        if inst_item is None:
            return
        inst_item.takeChildren()
        fuz = proj['fusion']
        btv = proj.get('btv') or {}
        buckets = btv.get('安装工程') or {}
        total_dev = total_ref = 0
        for bname in sorted(buckets, key=bk_key):
            bdata = buckets[bname]
            n_b = sum(v['dev'] + v['mat'] for v in bdata['fens'].values())
            bi = QtWidgets.QTreeWidgetItem(['%s   实例×%d' % (bname, n_b), 'GIM·分类'])
            bfont = QtGui.QFont()
            bfont.setBold(True)
            bi.setFont(0, bfont)
            bi.setData(0, UR1, 'btvrow')
            bi.setData(0, UR2, bname)
            inst_item.addChild(bi)
            for fname, slot in sorted(bdata['fens'].items(), key=fen_sort_key):
                n_f = slot['dev'] + slot['mat']
                fi = QtWidgets.QTreeWidgetItem(['%s   实例×%d' % (fname, n_f), 'GIM·cbm'])
                fi.setData(0, UR1, 'btvrow')
                fi.setData(0, UR2, '%s\x1f%s' % (bname, fname))
                if slot['f4s']:
                    fi.setChildIndicatorPolicy(
                        QtWidgets.QTreeWidgetItem.ChildIndicatorPolicy.ShowIndicator)
                bi.addChild(fi)
                for lf in sorted(slot['f4s'], key=lambda x: _natkey(x.get('n') or '')):
                    fi.addChild(btv_leaf(lf, fuz))
                total_dev += len(slot['f4s'])
                for lf in slot['f4s']:
                    g2 = lf.get('g')
                    rec = fuz.guidrec.get(g2) if g2 else None
                    if rec and not rec.get('miss'):
                        total_ref += 1
        idx_st = proj.get('idx').stats if proj.get('idx') else {}
        head = ('安装工程（GIM 为主 · 实例×%d · 设备 %d 台'
                % (total_dev, idx_st.get('设备', 0) + idx_st.get('PI箱柜设备', 0)))
        if idx_st.get('附件(并入本体)'):
            head += ' · 并入附件×%d' % idx_st['附件(并入本体)']
        if total_ref:
            head += ' · IFC 关联表示×%d' % total_ref
        if idx_st.get('f4无模型'):
            head += ' · IFC 挂接位×%d 另计' % idx_st['f4无模型']
        inst_item.setText(0, head + '）')
        fill_dgn(inst_item)
        un_item = QtWidgets.QTreeWidgetItem(
            ['未归属电气构件（IFC·正式分支，不强行挂接）', 'IFC·未挂接'])
        for c in (0, 1):
            un_item.setForeground(c, QtGui.QBrush(QtGui.QColor(C_WARN)))
        inst_item.addChild(un_item)
        proj['un_item'] = un_item
        rebuild_unassigned()
        inst_item.setExpanded(True)

    # ================= 融合树：建筑工程 / 未归属 / DGN =================
    def ifce_leaf(fl, g, rec):
        """已挂接 IFC 构件叶：IFC 名 =GIM·设备名●，点击看 IFC 实体属性。"""
        p = proj['obj']
        iname = rec.get('n') or cn_type(rec.get('t'))
        gname = ''
        cbm = rec.get('cbm')
        if cbm and cbm in p.nodes:
            gname = p.disp(cbm) or cbm[:8]
        it = QtWidgets.QTreeWidgetItem(['%s  =GIM·%s●' % (iname, gname[:26] or '?'), 'IFC→GIM'])
        it.setData(0, UR1, 'ifce')
        it.setData(0, UR2, fl)
        it.setData(0, UR3, g)
        for c in (0, 1):
            it.setForeground(c, QtGui.QBrush(QtGui.QColor(C_IFC)))
        return it

    def resid_leaves(res, outside=None):
        """未挂接构件类型组 [(标签, 类型, 数量, 楼层注记)]。"""
        out = []
        for stn, tys in (res or {}).items():
            for ty, cnt in tys.items():
                note = '' if stn in PSEUDO_NAMES else ' @%s' % stn
                out.append((cnt, ty, note))
        for ty, cnt in (outside or {}).items():
            out.append((cnt, ty, ' ▲楼层未知'))
        return out

    def rebuild_bld():
        """建筑工程（v5 口径）：角色·目标分组 → IFC 文件 → real 楼层 → 构件；
        尾部 GIM 建筑侧补充（无 IFC 挂接设备，BTV 建筑工程桶）。"""
        fuz = proj['fusion']
        bld_item = proj['bld_item']
        if bld_item is None:
            return
        bld_item.takeChildren()
        groups = collections.defaultdict(list)
        for fl in sorted(fuz.files):
            role, target, inferred = fuz.roles[fl]
            if role not in ('建筑', '构筑物', '总图'):
                continue
            groups[(role, target)].append(fl)
        order = {'建筑': 0, '构筑物': 1, '总图': 2}
        for (role, target), fls in sorted(
                groups.items(), key=lambda kv: (order.get(kv[0][0], 3),
                                                _natkey(kv[0][1]))):
            gi = QtWidgets.QTreeWidgetItem(
                ['%s · %s   %d 个文件' % (role, target, len(fls)), 'IFC'])
            gi.setData(0, UR1, 'ifcgroup')
            gi.setData(0, UR2, target)
            for c in (0, 1):
                gi.setForeground(c, QtGui.QBrush(QtGui.QColor(C_IFC)))
            bld_item.addChild(gi)
            # 跨文件合并楼层：一栋楼的一层不管来自哪个 IFC 都放在一起，
            # 来源文件只是属性（楼层行标注 ｜N 个文件，构件属性面板可查），不作为树层级
            floors = {}            # 楼层名 -> {'elev','files','hits','resid'}
            sum_items = []         # 伪/弱层文件残余 + 楼层未知残余（文件级汇总）
            file_notes = []        # (rank, fl)：0=real 1=伪弱 9=失败，殿后信息
            n_pending = 0
            for fl in sorted(fls, key=lambda x: _natkey(fuz.files[x][0])):
                disp, _path = fuz.files[fl]
                r = fuz.probe.get(fl)
                if r is None:
                    n_pending += 1
                    continue
                if r.get('error'):
                    file_notes.append((9, fl))
                    continue
                q = r['quality']
                file_notes.append((0 if q == 'real' else 1, fl))
                if q == 'real':
                    for st in r['storeys']:
                        nm = st['name']
                        ent = floors.setdefault(nm, {'elev': None, 'files': [],
                                                     'hits': [], 'resid': {}})
                        if ent['elev'] is None:
                            ent['elev'] = st['elev']
                        if fl not in ent['files']:
                            ent['files'].append(fl)
                        for g2, rec in r['guids'].items():
                            if not rec.get('miss') and rec.get('st') == nm:
                                ent['hits'].append((g2, rec, fl))
                        for ty, cnt in (r['resid'].get(nm) or {}).items():
                            ent['resid'][ty] = ent['resid'].get(ty, 0) + cnt
                    for ty, cnt in r['outside'].items():
                        sum_items.append((cnt, ty, ' @%s·楼层未知▲' % disp[:14]))
                else:
                    for stn, tys in r['resid'].items():
                        note_st = '' if stn in PSEUDO_NAMES else '·%s' % stn
                        for ty, cnt in tys.items():
                            sum_items.append((cnt, ty, ' @%s%s' % (disp[:14], note_st)))
                    for ty, cnt in r['outside'].items():
                        sum_items.append((cnt, ty, ' @%s·楼层未知▲' % disp[:14]))
            if n_pending:
                gi.addChild(QtWidgets.QTreeWidgetItem(['（IFC 空间扫描中…）', 'IFC']))
            # real 楼层按标高排列（跨文件同名层已合并为一行）
            for nm, ent in sorted(floors.items(),
                                  key=lambda kv: (kv[1]['elev'] is None,
                                                  kv[1]['elev'] or 0,
                                                  _natkey(kv[0]))):
                elev_s = '' if ent['elev'] is None else (' 标高%g' % ent['elev'])
                multi = ' ｜ %d 个文件' % len(ent['files']) if len(ent['files']) > 1 else ''
                si = QtWidgets.QTreeWidgetItem(
                    ['层·%s%s%s' % (nm, elev_s, multi), 'IFC·空间'])
                si.setData(0, UR1, 'ifcst')
                si.setData(0, UR2, list(ent['files']))
                si.setData(0, UR3, nm)
                for c in (0, 1):
                    si.setForeground(c, QtGui.QBrush(QtGui.QColor(C_IFC)))
                gi.addChild(si)
                if ent['hits']:
                    hi = QtWidgets.QTreeWidgetItem(
                        ['已挂接构件（GIM 关联表示）×%d' % len(ent['hits']), 'IFC→GIM'])
                    for c in (0, 1):
                        hi.setForeground(c, QtGui.QBrush(QtGui.QColor(C_IFC)))
                    si.addChild(hi)
                    for g2, rec, flh in sorted(
                            ent['hits'], key=lambda x: _natkey(x[1].get('n') or '')):
                        hi.addChild(ifce_leaf(flh, g2, rec))
                if ent['resid']:
                    ui_ = QtWidgets.QTreeWidgetItem(
                        ['未挂接构件 ×%d' % sum(ent['resid'].values()), 'IFC·未挂接'])
                    ui_.setForeground(1, QtGui.QBrush(QtGui.QColor(C_WARN)))
                    si.addChild(ui_)
                    for ty, cnt in sorted(ent['resid'].items(), key=lambda x: -x[1]):
                        ui_.addChild(QtWidgets.QTreeWidgetItem(
                            ['%s ×%d' % (cn_type(ty), cnt), 'IFC·未挂接']))
            if sum_items:
                ui_ = QtWidgets.QTreeWidgetItem(
                    ['未挂接构件（文件级汇总）×%d' % sum(x[0] for x in sum_items),
                     'IFC·未挂接'])
                ui_.setForeground(1, QtGui.QBrush(QtGui.QColor(C_WARN)))
                gi.addChild(ui_)
                for cnt, ty, note in sorted(sum_items, key=lambda x: (-x[0], x[1])):
                    ui_.addChild(QtWidgets.QTreeWidgetItem(
                        ['%s ×%d%s' % (cn_type(ty), cnt, note), 'IFC·未挂接']))
            # 组成 IFC 文件（信息保留，殿后——来源在此可查，不再作为树层级）
            if file_notes:
                fi_all = QtWidgets.QTreeWidgetItem(
                    ['组成 IFC 文件 ×%d' % len(file_notes), 'IFC·文件'])
                for c in (0, 1):
                    fi_all.setForeground(c, QtGui.QBrush(QtGui.QColor(C_IFC)))
                gi.addChild(fi_all)
                for _rank, fl in sorted(file_notes):
                    disp, _path = fuz.files[fl]
                    r = fuz.probe.get(fl)
                    extra = ''
                    if r and not r.get('error'):
                        extra = ' ｜ %s ｜ GUID挂接×%d %s' % (
                            {'real': '楼层真实', 'weak': '楼层占位', 'pseudo': '伪楼层',
                             'none': '无楼层'}.get(r['quality'], r['quality']),
                            r['guid_hit'], '○推断' if fuz.roles[fl][2] else '●确认')
                    elif r and r.get('error'):
                        extra = ' ｜ 扫描失败'
                    ci = QtWidgets.QTreeWidgetItem([disp + extra, 'IFC·文件'])
                    ci.setData(0, UR1, 'ifcfile')
                    ci.setData(0, UR2, fl)
                    for c in (0, 1):
                        ci.setForeground(c, QtGui.QBrush(QtGui.QColor(C_IFC)))
                    fi_all.addChild(ci)
        # GIM 建筑侧补充（无 IFC 挂接设备，来自 BTV 建筑工程桶）
        btv = proj.get('btv') or {}
        n_extra = 0
        for bname, bdata in sorted((btv.get('建筑工程') or {}).items()):
            for fname, slot in sorted(bdata.get('fens', {}).items(), key=fen_sort_key):
                unlinked = [lf for lf in slot['f4s'] if not lf.get('g')]
                if not unlinked:
                    continue
                n_extra += len(unlinked)
                fi = QtWidgets.QTreeWidgetItem(
                    ['%s   无挂接 F4×%d' % (fname, len(unlinked)), 'GIM·cbm'])
                fi.setData(0, UR1, 'btvrow')
                fi.setData(0, UR2, '%s\x1f%s' % (bname, fname))
                fuz2 = proj['fusion']
                for lf in sorted(unlinked, key=lambda x: _natkey(x.get('n') or '')):
                    fi.addChild(btv_leaf(lf, fuz2))
                bld_item.addChild(fi)
        if n_extra:
            note = QtWidgets.QTreeWidgetItem(
                ['▲ 以上为 GIM 建筑侧补充（无 IFC 挂接设备）F4×%d' % n_extra, 'GIM'])
            bld_item.addChild(note)
        bld_item.setExpanded(True)

    def rebuild_unassigned():
        fuz = proj['fusion']
        un_item = proj['un_item']
        if un_item is None:
            return
        un_item.takeChildren()
        n_all = 0
        for fl in sorted(fuz.files, key=lambda x: _natkey(fuz.files[x][0])):
            role, target, inferred = fuz.roles[fl]
            if role != '安装':
                continue
            r = fuz.probe.get(fl)
            if not r or r.get('error'):
                continue
            flat = resid_leaves(r['resid'], r['outside'])
            if not flat:
                continue
            n_all += sum(x[0] for x in flat)
            fi = QtWidgets.QTreeWidgetItem(
                ['%s  %s%s' % (fuz.files[fl][0], target,
                               ' ○推断' if inferred else ''), 'IFC·未挂接'])
            fi.setData(0, UR1, 'ifcfile')
            fi.setData(0, UR2, fl)
            for c in (0, 1):
                fi.setForeground(c, QtGui.QBrush(QtGui.QColor(C_WARN)))
            un_item.addChild(fi)
            for cnt, ty, note in sorted(flat, key=lambda x: (-x[0], x[1])):
                fi.addChild(QtWidgets.QTreeWidgetItem(
                    ['%s ×%d%s' % (cn_type(ty), cnt, note), 'IFC·未挂接']))
        un_item.setText(0, '未归属电气构件（IFC·正式分支，不强行挂接）×%d' % n_all)
        un_item.setExpanded(True)

    def fill_dgn(parent_root):
        """CBM/FileDevRelation.cbm 图纸轨：◇追溯。"""
        p = proj['obj']
        path = p.cbm_paths.get('FileDevRelation')
        if not path:
            return
        try:
            t = open(path, encoding='utf-8', errors='ignore').read()
        except OSError:
            return
        names = dict(re.findall(r'FILE(\d+)\.NAME=([^\r\n\x00]+)', t))
        per = collections.defaultdict(list)
        for m in re.finditer(r'FILE(\d+)\.DEV\d+=([0-9a-fA-F\-]{8,})\.cbm', t):
            per[m.group(1)].append(m.group(2))
        if not per:
            return
        dgn = QtWidgets.QTreeWidgetItem(
            ['图纸来源（DGN 图纸轨，dev 轨关联）×%d' % len(per), 'DGN◇'])
        for c in (0, 1):
            dgn.setForeground(c, QtGui.QBrush(QtGui.QColor(C_DGN)))
        parent_root.addChild(dgn)
        for fi in sorted(per, key=lambda x: int(x) if x.isdigit() else 0):
            nm = names.get(fi, 'FILE' + fi)
            di = QtWidgets.QTreeWidgetItem(
                ['%s  关联dev×%d ◇追溯' % (nm, len(per[fi])), 'DGN◇'])
            di.setData(0, UR1, 'dgn')
            di.setData(0, UR2, fi)
            for c in (0, 1):
                di.setForeground(c, QtGui.QBrush(QtGui.QColor(C_DGN)))
            dgn.addChild(di)

    def build_fusion():
        tree.clear()
        proj['u2iid'].clear()
        p = proj['obj']
        if proj.get('btv') is None:
            proj['btv'] = build_btv(p, proj['fusion'], bayinf=proj.get('bayinf'),
                                    idx=proj.get('idx'))
        root = QtWidgets.QTreeWidgetItem([p.proj_name, 'GIM'])
        tree.addTopLevelItem(root)
        inst = QtWidgets.QTreeWidgetItem(['安装工程（GIM 为主）', 'GIM·分类'])
        root.addChild(inst)
        bld_item = QtWidgets.QTreeWidgetItem(['建筑工程（IFC 空间为主）', 'IFC'])
        for c in (0, 1):
            bld_item.setForeground(c, QtGui.QBrush(QtGui.QColor(C_IFC)))
        root.addChild(bld_item)
        root.setExpanded(True)
        proj['inst_item'] = inst
        proj['bld_item'] = bld_item
        proj['un_item'] = None
        render_install_btv()
        rebuild_bld()
        start_scan()

    def build_native():
        tree.clear()
        proj['u2iid'].clear()
        proj['bld_item'] = None
        proj['un_item'] = None
        proj['inst_item'] = None
        p = proj['obj']
        for r in p.roots or list(p.nodes)[:1]:
            gim_item(r)

    def build_file():
        """第三视图：按文件组织——cbm 工程节点 → dev 模型文件 → 设备实例。

        与 BTV 业务树（按组成层级）互补：这里看的是「哪个工程节点引用了哪个图元」，
        dev 后 `↺N` 表示同一图元被 N 个 cbm 复用。
        """
        tree.clear()
        proj['u2iid'].clear()
        proj['bld_item'] = None
        proj['un_item'] = None
        proj['inst_item'] = None
        p = proj['obj']
        if proj.get('file_rows') is None:
            proj['file_rows'] = build_file_tree(p, proj.get('idx'))
        rows = proj['file_rows']
        fs = file_stats(p, rows)
        root = QtWidgets.QTreeWidgetItem(
            ['%s ｜ 按文件（cbm %d → dev %d）'
             % (p.proj_name, fs['有模型文件'], fs['唯一dev']), 'GIM'])
        f = QtGui.QFont()
        f.setBold(True)
        root.setFont(0, f)
        tree.addTopLevelItem(root)
        gcolor = {'设备': '#1a5fb4', '装置性材料': '#613583', '构件': '#26734d'}
        for g in group_by_cbm(rows):
            ci = QtWidgets.QTreeWidgetItem(
                ['%s.cbm   %s / %s' % (g['cbm'][:8], g['f2'] or '-', g['f3'] or '-'),
                 'CBM'])
            ci.setData(0, UR, g['cbm'])
            ci.setForeground(1, QtGui.QBrush(QtGui.QColor('#5c6b7f')))
            proj['u2iid'][g['cbm']] = ci
            root.addChild(ci)
            for r in g['devs']:
                inst = r['inst']
                tag = KIND_TAG.get(inst.get('group') or '', '[?]')
                nm = inst.get('name') or '(无名)'
                code = (' %s' % inst['code']) if inst.get('code') else ''
                cat = (' ｜ %s' % inst['cat']) if inst.get('cat') else ''
                note = '（并入主变）' if inst.get('attached') else ''
                reuse = ('  ↺%d' % r['reuse']) if r['reuse'] > 1 else ''
                di = QtWidgets.QTreeWidgetItem(
                    ['%s %s%s%s%s   · dev %s%s'
                     % (tag, nm, code, cat, note, r['dev'][:8], reuse), 'dev'])
                di.setData(0, UR, r['cbm'])
                di.setData(0, UR1, 'file')
                di.setData(0, UR2, r['dev'])
                col = gcolor.get(inst.get('group') or '')
                if col:
                    di.setForeground(0, QtGui.QBrush(QtGui.QColor(col)))
                ci.addChild(di)
            ci.setExpanded(True)          # 两级都摊开：cbm → dev 一眼看到对应关系
        root.setExpanded(True)
        idx_st = proj['idx'].stats if proj.get('idx') else {}
        status.showMessage(
            '%s ｜ 按文件：F4 %d · 有模型文件 %d · 无模型(挂接/占位) %d · 唯一 dev %d ｜ '
            '设备 %d · 并入附件 %d ｜ PI 层（无独立 cbm）材料 %d · 箱柜 %d 另计'
            % (p.proj_name, fs['cbm节点'], fs['有模型文件'], fs['无模型文件'],
               fs['唯一dev'], fs['设备'], fs['附件并入'],
               idx_st.get('PI材料', 0), idx_st.get('PI箱柜设备', 0)))

    # ---- IFC 空间后台扫描（工作线程写容器 + 主线程 QTimer 轮询） ----
    lookup = IfcLookup()

    def start_scan():
        fuz = proj['fusion']
        todo = sorted(fuz.files.items(), key=lambda kv: (os.path.getsize(kv[1][1]),
                                                         _natkey(kv[1][0])))
        sc = {'todo': todo, 'done': 0, 'seen': 0, 'running': True}
        proj['scan'] = sc
        if not todo:
            status.showMessage('%s ｜ 目录内无 IFC 文件，仅 GIM 轨' % p_name())
            return
        status.showMessage('IFC 空间扫描 0/%d …' % len(todo))

        def work():
            t0 = time.time()
            for fl, (disp, path) in todo:
                try:
                    r = ifc_probe_file(path, proj['fusion'].byfile.get(fl, {}))
                except Exception:
                    r = {'error': traceback.format_exc()[-300:], 'resid': {},
                         'outside': {}, 'guids': {}, 'storeys': []}
                fuz = proj['fusion']
                if fuz is None:
                    return
                fuz.probe[fl] = r
                for g2, rec in r.get('guids', {}).items():
                    fuz.guidrec.setdefault(g2, rec)
                sc['done'] += 1
                _log('探针完成 %s：%.1fs 命中 %s' %
                     (disp, time.time() - t0,
                      r.get('error') or '%d/%d' % (r['guid_hit'],
                                                   r['guid_hit'] + r['guid_miss'])))
            # 坐标推断间隔归属：收纳位 F4 的 IFC 散材（导线/金具/绝缘子串…）
            # 依 IFC 放置链世界坐标 → 最近 GIM 间隔设备群（bay_infer 模块）
            p0, fuz0 = proj['obj'], proj['fusion']
            if p0 is None or fuz0 is None:
                return
            try:
                t1 = time.time()
                bi, _bays = bay_infer.infer(
                    p0, fuz0, lambda m: _log('坐标推断: %s' % m))
                proj['bayinf'] = bi
                _log('坐标推断完成：%d 个散材 / 间隔群 %d 个 / %.1fs'
                     % (len(bi), len(_bays), time.time() - t1))
            except Exception:
                proj['bayinf'] = {}
                _log('坐标推断异常:\n' + traceback.format_exc())

        def poll():
            try:
                _poll_body()
            except Exception:
                _log('扫描轮询异常:\n' + traceback.format_exc())

        def _poll_body():
            sc2 = proj.get('scan')
            if not sc2 or proj['mode'] != 0:
                return
            if sc2['done'] > sc2['seen']:
                for fl, _x in sc2['todo'][sc2['seen']:sc2['done']]:
                    apply_annotations(fl)
                sc2['seen'] = sc2['done']
                try:
                    rebuild_bld()
                    rebuild_unassigned()
                except RuntimeError:
                    return          # 树已被切换销毁
                status.showMessage('IFC 空间扫描 %d/%d …（建筑工程树已更新）'
                                   % (sc2['seen'], len(sc2['todo'])))
            if sc2['seen'] >= len(sc2['todo']):
                sc2['running'] = False
                fuz = proj['fusion']
                n_hit = sum(fuz.probe[fl].get('guid_hit', 0) for fl in fuz.probe
                            if not fuz.probe[fl].get('error'))
                # BTV 重算（IFC Name 回填 + 电气划桶通道）并重渲染安装工程
                if proj['mode'] == 0:
                    try:
                        proj['btv'] = build_btv(proj['obj'], fuz,
                                                bayinf=proj.get('bayinf'),
                                                idx=proj.get('idx'))
                        render_install_btv()
                        rebuild_bld()
                    except RuntimeError:
                        return          # 树已被切换销毁
                status.showMessage('融合扫描完成：IFC 文件 %d 个 ｜ GUID 命中 %d/%d ｜ '
                                   '坐标推断间隔 %d ｜ '
                                   '安装(业务树)/建筑工程分支已更新'
                                   % (len(sc2['todo']), n_hit, fuz.join_n,
                                      len(proj.get('bayinf') or {})))
                return
            QtCore.QTimer.singleShot(250, poll)
        threading.Thread(target=work, daemon=True).start()
        QtCore.QTimer.singleShot(250, poll)

    def p_name():
        return proj['obj'].proj_name if proj['obj'] else '?'

    def apply_annotations(fl):
        """某 IFC 文件扫描完成后，回填 GIM F4 节点的 ⇢IFC 注记。"""
        fuz = proj['fusion']
        for g, u in fuz.byfile.get(fl, {}).items():
            rec = fuz.guidrec.get(g)
            it = proj['u2iid'].get(u)
            if not it or not rec:
                continue
            try:
                cur = it.text(0)
            except RuntimeError:
                continue
            if rec.get('miss'):
                ann, src = '  ⇢IFC·未命中▲', 'GIM+IFC▲'
            else:
                nmv = rec.get('n') or rec.get('t') or 'IFC实体'
                if len(nmv) > 24:
                    nmv = nmv[:24] + '…'
                ann, src = '  ⇢IFC·%s●' % nmv, 'GIM+IFC●'
            it.setText(0, cur.replace('  ⚡IFC', '') + ann)
            it.setText(1, src)
            for c in (0, 1):
                it.setForeground(c, QtGui.QBrush(QtGui.QColor(
                    C_WARN if rec.get('miss') else C_BOTH)))

    def show_rows(rows, teal_groups=('IFC 实体', 'IFC 引用', 'IFC 反向', 'IFC 文件',
                                     'IFC 空间', 'IFC 构件组')):
        atv.setRowCount(len(rows))
        for i, (grp, k, v) in enumerate(rows):
            c0 = QtWidgets.QTableWidgetItem(grp)
            c1 = QtWidgets.QTableWidgetItem(k)
            c2 = QtWidgets.QTableWidgetItem(v)
            if k.upper().startswith('IFC') and grp not in teal_groups:
                for c in (c0, c1, c2):
                    c.setForeground(QtGui.QBrush(QtGui.QColor(C_BOTH)))
            if grp in teal_groups:
                for c in (c0, c1):
                    c.setForeground(QtGui.QBrush(QtGui.QColor(C_IFC)))
            if grp.startswith('GIM'):
                c0.setForeground(QtGui.QBrush(QtGui.QColor('#1f2d3d')))
            if k.startswith('◆'):
                for c in (c0, c1, c2):
                    c.setBackground(QtGui.QBrush(QtGui.QColor('#eef1f5')))
            atv.setItem(i, 0, c0)
            atv.setItem(i, 1, c1)
            atv.setItem(i, 2, c2)

    def fam_rows(stem):
        p = proj['obj']
        rows = [('GIM·fam 族文件', 'fam 文件', stem + '.fam')]
        path = p.fam_paths.get(stem)
        if path:
            fk = fam_kv(path, p.bentley)
            rows.append(('GIM·fam 族文件', '参数行数', str(len(fk))))
            rows += [('GIM·fam 族文件', k, v) for k, v in fk[:400]]
        else:
            rows.append(('GIM·fam 族文件', '结果', '目录中未找到该 fam 文件'))
        sibs = sorted(proj['fam_members'].get(stem, []),
                      key=lambda x: _natkey(p.disp(x) or x))
        names = [p.disp(x) or x[:8] for x in sibs[:15]]
        rows.append(('GIM·fam 同族设备', '共 %d 台' % len(sibs),
                     '、'.join(names) + ('…' if len(sibs) > 15 else '')))
        return rows

    def dev_rows(stem):
        p = proj['obj']
        rows = [('GIM·dev 图元', 'dev 文件', stem + '.dev')]
        path = p.dev_paths.get(stem)
        if path:
            dk = kv(path)
            sym = dk.get('SYMBOLNAME') or get1(dk, 'SYMBOLNAME')
            if sym:
                rows.append(('GIM·dev 图元', 'SYMBOLNAME', sym))
            rows.append(('GIM·dev 图元', '参数行数', str(len(dk))))
            rows += [('GIM·dev 图元', k, v)
                     for k, v in sorted(dk.items())[:400]]
        else:
            rows.append(('GIM·dev 图元', '结果', '目录中未找到该 dev 文件'))
        sibs = sorted(proj['dev_members'].get(stem, []),
                      key=lambda x: _natkey(p.disp(x) or x))
        names = [p.disp(x) or x[:8] for x in sibs[:15]]
        rows.append(('GIM·dev 关联设备', '共 %d 台' % len(sibs),
                     '、'.join(names) + ('…' if len(sibs) > 15 else '')))
        return rows

    def fusion_node_rows(kind, a, b, c):
        """融合树 IFC/DGN/BTV 节点的右侧属性行。"""
        fuz = proj['fusion']
        p = proj['obj']
        if kind == 'btvrow':
            key = b or ''
            bname, _, fname = key.partition('\x1f')
            btv = proj.get('btv') or {}
            bdata = (btv.get('安装工程') or {}).get(bname) \
                or (btv.get('建筑工程') or {}).get(bname) or {}
            rows = [('GIM 分类', '设备类别（桶）', bname)]
            if fname:
                rows.append(('GIM 分类', '分项（F3 间隔）', fname))
                slot = (bdata.get('fens') or {}).get(fname) or {}
                rows.append(('GIM 分类', '设备 F4 / 材料等',
                             '%d / %d' % (slot.get('dev', 0), slot.get('mat', 0))))
                cnt = collections.Counter(
                    '%s·%s' % (lf.get('k'), lf.get('c')) for lf in slot.get('f4s', []))
                for kc, n2 in cnt.most_common(10):
                    rows.append(('GIM 分类', kc, '×%d' % n2))
            else:
                fens = bdata.get('fens') or {}
                rows.append(('GIM 分类', '分项数 / 设备 F4',
                             '%d / %d' % (len(fens),
                                          sum(v['dev'] for v in fens.values()))))
            return rows
        if kind == 'ifcfile':
            fl = b
            disp, path = fuz.files[fl]
            role, target, inferred = fuz.roles[fl]
            rows = [('IFC 文件', '文件名', disp),
                    ('IFC 文件', '角色（树归组）', '%s · %s%s' %
                     (role, target, '（○推断）' if inferred else '')),
                    ('IFC 文件', '大小',
                     '%.1f MB' % (os.path.getsize(path) / 1048576)
                     if os.path.exists(path) else '?')]
            n_cbm = len(fuz.byfile.get(fl, {}))
            rows.append(('GIM+IFC 挂接', 'cbm 挂接键（IFCFILE+IFCGUID）', '%d 条' % n_cbm))
            r = fuz.probe.get(fl)
            if r:
                if r.get('error'):
                    rows.append(('IFC 文件', '扫描结果', '失败：%s' % r['error'][:80]))
                else:
                    rows.append(('IFC 空间', '楼层质量', r['quality']))
                    rows.append(('IFC 空间', '楼层', '、'.join(
                        s['name'] for s in r['storeys']) or '（无）'))
                    rows.append(('IFC 空间', '建筑', '、'.join(
                        b2['name'] or '(无名)' for b2 in r['buildings']) or '（无）'))
                    rows.append(('IFC 挂接统计', 'GUID 命中 / 未命中',
                                 '%d / %d' % (r['guid_hit'], r['guid_miss'])))
                    n_res = sum(sum(t.values()) for t in r['resid'].values()) \
                        + sum(r['outside'].values())
                    rows.append(('IFC 未挂接', '残余构件数', str(n_res)))
            return rows
        if kind == 'ifcst':
            fls, stn = b, c
            if isinstance(fls, str):
                fls = [fls]              # 兼容旧单文件载荷；融合树为合并楼层（多文件）
            rows = [('IFC 空间', '楼层', stn)]
            tot_hit = 0
            for fl in fls:
                disp, _path = fuz.files[fl]
                r = fuz.probe.get(fl) or {}
                st = next((s for s in r.get('storeys', []) if s['name'] == stn), None)
                rows.append(('IFC 空间', '所属 IFC 文件', disp))
                if st and st['elev'] is not None:
                    rows.append(('IFC 空间', '标高（%s）' % disp[:16], '%g m' % st['elev']))
                hits = [(g2, rec) for g2, rec in r.get('guids', {}).items()
                        if not rec.get('miss') and rec.get('st') == stn]
                tot_hit += len(hits)
                for g2, rec in hits[:20]:
                    cbm = rec.get('cbm')
                    gname = p.disp(cbm) if cbm in p.nodes else (cbm or '?')[:8]
                    rows.append(('GIM+IFC 挂接', rec.get('n') or cn_type(rec.get('t')),
                                 '=GIM·%s ｜ %s ｜ %s' % (gname, g2, disp[:16])))
                res = r.get('resid', {}).get(stn) or {}
                if res:
                    rows.append(('IFC 未挂接', '未挂接构件（%s）' % disp[:16],
                                 '、'.join('%s×%d' % (cn_type(t2), n2)
                                           for t2, n2 in sorted(res.items(), key=lambda x: -x[1]))))
            rows.insert(1, ('GIM+IFC 挂接', '已挂接构件（跨文件合计）', '%d 个' % tot_hit))
            return rows
        if kind == 'ifce':
            fl, g = b, c
            disp, path = fuz.files[fl]
            rec = fuz.guidrec.get(g) or {}
            rows = [('GIM+IFC 挂接', '挂接方式', 'F4 双键（IFCFILE+IFCGUID）●确认'),
                    ('IFC 实体', '来源 IFC 文件', disp)]
            cbm = rec.get('cbm')
            if cbm and cbm in p.nodes:
                rows.append(('GIM+IFC 挂接', 'GIM 侧节点',
                             '%s（%s.cbm）' % (p.disp(cbm) or cbm[:8], cbm)))
            if rec.get('miss'):
                rows.append(('IFC 实体', '结果', '该 IFC 文件中未找到此 GUID ▲'))
                return rows
            found = lookup.find(path, g)
            if found:
                rows += found
                rev = lookup.reverse_rows(path, g)
                if rev:
                    rows += rev
            else:
                rows.append(('IFC 实体', '结果', '未定位到实体'))
            return rows
        if kind == 'ifcgroup':
            return [('IFC 空间', '分组', '%s · %s' % (a, b)),
                    ('IFC 空间', '说明',
                     '子项为跨文件合并楼层；来源 IFC 文件见尾部「组成 IFC 文件」或构件属性')]
        if kind == 'dgn':
            p2 = proj['obj']
            path = p2.cbm_paths.get('FileDevRelation')
            rows = [('DGN 图纸', '登记名', names_of_dgn(b))]
            try:
                t = open(path, encoding='utf-8', errors='ignore').read()
                devs = re.findall(r'FILE%s\.DEV\d+=([0-9a-fA-F\-]{8,})\.cbm' % b, t)
                rows.append(('DGN 图纸', '关联 dev（◇追溯）', '%d 个' % len(devs)))
                for d2 in devs[:40]:
                    nmv = p2.disp(d2) if d2 in p2.nodes else d2
                    rows.append(('DGN 图纸', 'dev', '%s（%s.cbm）' % (nmv, d2)))
            except OSError:
                pass
            return rows
        return []

    _dgn_names = {}

    def names_of_dgn(fi):
        return _dgn_names.get(fi, 'FILE' + fi)

    def show_attrs(item):
        p = proj['obj']
        if item is None:
            return
        kind = item.data(0, UR1)
        if kind == 'fam':
            stem = item.data(0, UR2)
            n = len(proj['fam_members'].get(stem, []))
            info.setText('<b>GIM·fam 族下钻</b>　%s.fam　关联设备 %d 台（展开节点可逐台定位）'
                         % (stem, n))
            ifc_job['n'] += 1
            show_rows(fam_rows(stem))
            return
        if kind == 'dev':
            stem = item.data(0, UR2)
            n = len(proj['dev_members'].get(stem, []))
            info.setText('<b>GIM·dev 图元下钻</b>　%s.dev　关联设备 %d 台' % (stem, n))
            ifc_job['n'] += 1
            show_rows(dev_rows(stem))
            return
        if kind in ('ifcfile', 'ifcst', 'ifce', 'ifcgroup', 'dgn', 'btvrow'):
            a = item.text(0)
            b = item.data(0, UR2)
            c = item.data(0, UR3)
            info.setText('<b>%s</b>　<span style="color:%s">来源 %s</span>'
                         % (a, C_IFC, item.text(1)))
            ifc_job['n'] += 1
            if kind == 'ifce':
                start_ifc_query(item, None, show_attrs_base(item, kind, b, c))
            else:
                show_rows(fusion_node_rows(kind, a, b, c))
            return
        u = item.data(0, UR)
        if u is None:
            return
        d = p.nodes[u]
        g = d.get('IFCGUID')
        src = 'GIM+IFC' if g else 'GIM'
        info.setText('<b>%s</b>　层级 %s　cbm: %s　<span style="color:%s">来源 %s</span>'
                     % (p.disp(u), p.level(u), u,
                        C_BOTH if g else '#1f2d3d', src))
        rows = p.attrs(u)
        # 坐标推断间隔归属（收纳位 F4 的 IFC 散材）
        inf = (proj.get('bayinf') or {}).get(g)
        if inf:
            rows.append(('间隔推断(坐标)', '最近间隔', '%s%s' % (
                inf['f3'], '（低区分△）' if inf.get('low') else '')))
            rows.append(('间隔推断(坐标)', '平面距离 / 区分度',
                         '%.1f m / %.1f m' % (inf['d'], inf['mg'])))
        ifc_job['n'] += 1                    # 作废在途查询
        if g:
            start_ifc_query(item, u, rows)
        else:
            show_rows(rows)

    def show_attrs_base(item, kind, b, c):
        """ifce 节点的背景行（GIM 侧信息），IFC 查询完成后追加。"""
        return fusion_node_rows('ifce', item.text(0), b, c)

    tree.currentItemChanged.connect(lambda cur, _p: show_attrs(cur) if cur else None)

    # ---- IFC 实体属性按需查询（后台线程 + 主线程轮询 + 令牌防过期） ----
    ifc_job = {'n': 0}

    def start_ifc_query(item, u, base_rows):
        p = proj['obj']
        if u is not None:
            g = p.nodes[u].get('IFCGUID', '')
            path, _ff = p.ifc_source(u)
        else:
            fuz = proj['fusion']
            g = item.data(0, UR3)
            fl = item.data(0, UR2)
            path = fuz.files.get(fl, ('', None))[1]
        if not g:
            show_rows(base_rows)
            return
        if path is None:
            rows = list(base_rows) + [('IFC 实体', 'IFCGUID', g),
                                      ('IFC 实体', '结果', '目录内未找到源 IFC 文件')]
            show_rows(rows)
            return
        ifc_job['n'] += 1
        my = ifc_job['n']
        status.showMessage('正在从 IFC 文件定位实体 %s …' % g)
        st = {'rows': None, 'rev': None, 'err': None}

        def work():
            try:
                st['rows'] = lookup.find(path, g) or []
                st['rev'] = lookup.reverse_rows(path, g)
            except Exception:
                import traceback
                st['err'] = traceback.format_exc()

        threading.Thread(target=work, daemon=True).start()

        def poll():
            if my != ifc_job['n'] or tree.currentItem() is not item:
                return                      # 已被新的选择覆盖
            if st['err']:
                status.showMessage('IFC 实体读取失败： %s' %
                                   st['err'].splitlines()[-1])
                return
            if st['rows'] is None:
                QtCore.QTimer.singleShot(120, poll)
                return
            rows = list(base_rows) + list(st['rows'])
            rev = st['rev']
            if rev:
                rows += list(rev)
            show_rows(rows)
            n_rev = len(rev) if rev else 0
            status.showMessage('IFC 实体 %s ｜ %s%s' %
                               (g, '已加载实体属性（含一级引用展开）' if st['rows']
                                else '未命中（详见属性表说明）',
                                ' ｜ 反向关联 %d 行' % n_rev if n_rev else ''))
        QtCore.QTimer.singleShot(0, poll)

    # ---- 打开目录（后台线程 + 主线程轮询，避免跨线程信号依赖） ----
    def open_dir():
        d = QtWidgets.QFileDialog.getExistingDirectory(
            win, '选择 GIM 样本目录（内含 *.cbm）', init_dir or os.getcwd())
        _log('目录选择结果: %r' % d)
        if d:
            load(d)

    def load(d):
        _log('开始解析 %s' % d)
        # 快速体检：无 cbm 直接报错；cbm 过多先确认（防误选大目录卡死假死）
        n_cbm = 0
        for _b, _d2, fns in os.walk(d):
            n_cbm += sum(1 for fn in fns if fn.lower().endswith('.cbm'))
        _log('cbm 计数 %d' % n_cbm)
        if n_cbm == 0:
            QtWidgets.QMessageBox.warning(
                win, '无法打开',
                '所选目录内没有 .cbm 文件。\n请选择 GIM 样本目录（例如 gim_demo\\substation01）。',
                QtWidgets.QMessageBox.StandardButton.Ok)
            return
        if n_cbm > 30000:
            ret = QtWidgets.QMessageBox.question(
                win, '目录较大',
                '目录内 cbm 文件有 %d 个，解析可能需要 10 分钟以上。是否继续？' % n_cbm,
                QtWidgets.QMessageBox.StandardButton.Yes
                | QtWidgets.QMessageBox.StandardButton.No)
            if ret != QtWidgets.QMessageBox.StandardButton.Yes:
                _log('用户取消大目录解析')
                return
        # 占位提示（解析期间树不再空白）
        tree.clear()
        proj['u2iid'].clear()
        ph = QtWidgets.QTreeWidgetItem(['正在解析目录，请稍候…', ''])
        tree.addTopLevelItem(ph)
        ph.setExpanded(True)
        status.showMessage('正在解析 %s …' % d)
        QtWidgets.QApplication.processEvents()
        st = {'done': None, 'err': None, 'msg': ''}

        def work():
            try:
                st['done'] = Project(d, lambda m: st.__setitem__('msg', m))
                _log('解析完成: %s（节点 %d）' %
                     (st['done'].proj_name, len(st['done'].nodes)))
            except Exception:
                st['err'] = traceback.format_exc()
                _log('解析异常:\n' + st['err'])

        threading.Thread(target=work, daemon=True).start()

        def poll():
            try:
                if st['done'] is not None:
                    loaded(st['done'])
                    return
                if st['err']:
                    QtWidgets.QMessageBox.critical(
                        win, '解析失败', st['err'][-3000:])
                    tree.clear()
                    return
                if st['msg'] and st['msg'] != st.get('last_msg'):
                    st['last_msg'] = st['msg']
                    _log('进度: %s' % st['msg'])      # 诊断留痕：卡点可见
                    ph.setText(0, '正在解析目录，请稍候…　%s' % st['msg'])
                    status.showMessage('%s ｜ %s' % (d, st['msg']))
                QtCore.QTimer.singleShot(200, poll)
            except Exception:
                _log('加载轮询异常:\n' + traceback.format_exc())
        poll()

    def loaded(p):
        proj['obj'] = p
        proj['fusion'] = Fusion(p)
        # 设备实例索引（gim_element 口径）：BTV 叶子与文件视图共用同一份
        proj['idx'] = DeviceIndex(p, lambda m: _log(m))
        proj['file_rows'] = None
        proj['btv'] = None
        proj['u2iid'] = {}
        proj['bayinf'] = {}
        proj['fam_of'] = {}
        proj['dev_of'] = {}
        proj['fam_members'] = collections.defaultdict(list)
        proj['dev_members'] = collections.defaultdict(list)
        for uu, d in p.nodes.items():
            if p.level(uu) != 'F4':
                continue                  # 族/图元下钻只面向 F4 设备
            bfv = next((v for k, v in d.items()
                        if 'BASEFAMILY' in k.upper() and v.endswith('.fam')), None)
            if bfv:
                st = bfv[:-4]
                proj['fam_of'][uu] = st
                proj['fam_members'][st].append(uu)
            omp = next((v for k, v in d.items()
                        if 'OBJECTMODELPOINTER' in k.upper()
                        and v.endswith('.dev')), None)
            if omp:
                st2 = omp[:-4]
                proj['dev_of'][uu] = st2
                proj['dev_members'][st2].append(uu)
        # DGN 登记名缓存
        _dgn_names.clear()
        fp = p.cbm_paths.get('FileDevRelation')
        if fp:
            try:
                t = open(fp, encoding='utf-8', errors='ignore').read()
                _dgn_names.update(re.findall(r'FILE(\d+)\.NAME=([^\r\n\x00]+)', t))
            except OSError:
                pass
        if proj['mode'] == 0:
            build_fusion()
        elif proj['mode'] == 1:
            build_native()
        else:
            build_file()
        fuz = proj['fusion']
        st = p.stats()
        idx_st = dev_stats(proj['idx']) if proj.get('idx') else {}
        _log('loaded: %s ｜ 节点 %d ｜ IFC 文件 %d ｜ 挂接键 %d ｜ 实例 %s' %
             (p.proj_name, len(p.nodes), len(fuz.files), fuz.join_n, idx_st))
        status.showMessage(
            '%s ｜ %s ｜ 设备 %s 台（含并入附件 %s）· 材料 %s · 构件 %s ｜ '
            'IFC 文件 %d 个 / 挂接键 %d 条（后台空间扫描中）'
            % (p.proj_name,
               ' ｜ '.join('%s×%d' % kv2 for kv2 in sorted(st.items())),
               idx_st.get('设备', 0) + idx_st.get('PI箱柜设备', 0),
               idx_st.get('附件(并入本体)', 0), idx_st.get('PI材料', 0),
               idx_st.get('构件', 0), len(fuz.files), fuz.join_n))

    act_open.triggered.connect(open_dir)

    def on_mode(i):
        proj['mode'] = i
        if not proj['obj']:
            return
        if i == 0:
            build_fusion()
        elif i == 1:
            build_native()
        else:
            build_file()
    mode_box.currentIndexChanged.connect(on_mode)

    # ---- FAM/DEV 下钻节点惰性展开 ----
    def on_expand(item):
        kind = item.data(0, UR1)
        if not kind or kind not in ('fam', 'dev') or item.childCount():
            return
        p = proj['obj']
        stem = item.data(0, UR2)
        members = (proj['fam_members'] if kind == 'fam'
                   else proj['dev_members']).get(stem, [])
        sibs = sorted(members, key=lambda x: _natkey(p.disp(x) or x))
        for su in sibs[:300]:
            ci = QtWidgets.QTreeWidgetItem([p.disp(su) or su[:8], 'GIM·cbm'])
            ci.setData(0, UR, su)
            item.addChild(ci)
        if len(sibs) > 300:
            item.addChild(QtWidgets.QTreeWidgetItem(
                ['…其余 %d 台（请用搜索定位）' % (len(sibs) - 300), '']))
        if not sibs:
            item.addChild(QtWidgets.QTreeWidgetItem(['（无关联设备）', '']))
    tree.itemExpanded.connect(on_expand)

    # ---- 搜索 ----
    def goto_item(it):
        anc = []
        cur = it
        while cur:
            anc.append(cur)
            cur = cur.parent()
        for a in reversed(anc):
            a.setExpanded(True)
        tree.scrollToItem(it)
        tree.setCurrentItem(it)

    def show_hits(hits):
        p = proj['obj']
        if not hits:
            status.showMessage('搜索无结果')
            return
        dlg = QtWidgets.QDialog(win)
        dlg.setWindowTitle('搜索结果（%d 个，双击定位）' % len(hits))
        dlg.resize(800, 460)
        v = QtWidgets.QVBoxLayout(dlg)
        lb = QtWidgets.QTreeWidget()
        lb.setHeaderLabels(['层级', '名称', 'cbm 文件', '来源'])
        lb.setColumnWidth(0, 50)
        lb.setColumnWidth(1, 330)
        lb.setColumnWidth(2, 200)
        lb.setRootIsDecorated(False)
        v.addWidget(lb)
        items = {}
        for u in hits[:2000]:
            g = p.nodes[u].get('IFCGUID')
            src = 'GIM+IFC' if g else 'GIM'
            it = QtWidgets.QTreeWidgetItem(
                [p.level(u), p.disp(u) or u[:8], u, src])
            if g:
                it.setForeground(3, QtGui.QBrush(QtGui.QColor(C_BOTH)))
            lb.addTopLevelItem(it)
            items[id(it)] = u

        def dbl(item, _col):
            it2 = proj['u2iid'].get(items[id(item)])
            if it2:
                goto_item(it2)
                dlg.accept()
        lb.itemDoubleClicked.connect(dbl)
        status.showMessage('搜索命中 %d 个' % len(hits))
        dlg.show()

    def do_search():
        p = proj['obj']
        if not p:
            return
        show_hits(p.search(qbox.text()))

    act_search.triggered.connect(do_search)
    qbox.returnPressed.connect(do_search)

    # ---- 右键复制 ----
    def copy(s):
        QtWidgets.QApplication.clipboard().setText(s)
        status.showMessage('已复制: %s' % (s[:70] + ('…' if len(s) > 70 else '')))

    def ctx_tree(pos):
        it = tree.itemAt(pos)
        if not it:
            return
        u = it.data(0, UR)
        kind = it.data(0, UR1)
        p = proj['obj']
        m = QtWidgets.QMenu(win)
        if u:
            m.addAction('复制节点名', lambda: copy(p.disp(u) or u))
            m.addAction('复制 cbm 文件名', lambda: copy(u + '.cbm'))
            g = p.nodes[u].get('IFCGUID')
            if g:
                m.addAction('复制 IFCGUID', lambda: copy(g))
        if kind in ('fam', 'dev'):
            stem = it.data(0, UR2)
            m.addAction('复制 %s 文件名' % kind.upper(),
                        lambda: copy(stem + '.' + kind))
        if kind == 'ifce':
            fl, g = it.data(0, UR2), it.data(0, UR3)
            m.addAction('复制 IFCGUID', lambda: copy(g))
            cbm = (proj['fusion'].guidrec.get(g) or {}).get('cbm')
            if cbm and cbm in proj['u2iid']:
                m.addAction('定位到 GIM 设备（=GIM·…）',
                            lambda: goto_item(proj['u2iid'][cbm]))
        if kind == 'ifcfile':
            fl = it.data(0, UR2)
            m.addAction('复制 IFC 文件名', lambda: copy(proj['fusion'].files[fl][0]))
        if kind == 'ifcst':
            m.addAction('复制楼层名', lambda: copy(it.text(0)))
        m.exec(tree.viewport().mapToGlobal(pos))
    tree.setContextMenuPolicy(QtCore.Qt.CustomContextMenu)
    tree.customContextMenuRequested.connect(ctx_tree)

    def ctx_atv(pos):
        it = atv.itemAt(pos)
        if not it:
            return
        m = QtWidgets.QMenu(win)
        m.addAction('复制属性值', lambda: copy(it.text(2)))
        m.addAction('复制属性名=值', lambda: copy('%s=%s' % (it.text(1), it.text(2))))
        m.exec(atv.viewport().mapToGlobal(pos))
    atv.setContextMenuPolicy(QtCore.Qt.CustomContextMenu)
    atv.customContextMenuRequested.connect(ctx_atv)

    if init_dir:
        load(init_dir)
    if selftest:
        def _quit():
            t = proj['obj']
            n = len(proj['u2iid'])
            msg = ''
            for uu, it in list(proj['u2iid'].items()):
                if proj['fam_of'].get(uu) and it.childCount():
                    pf = it.child(0)
                    kind = pf.data(0, UR1)
                    on_expand(pf)
                    show_attrs(pf)
                    msg = 'drill=%s kind=%s sib_children=%d rows=%d' % (
                        proj['fam_of'][uu][:12], kind,
                        pf.childCount(), atv.rowCount())
                    break
            fuz = proj['fusion']
            extra = ''
            if fuz and proj['mode'] == 0:
                extra = (' fusion_files=%d joins=%d probed=%d bld_children=%d' %
                         (len(fuz.files), fuz.join_n, len(fuz.probe),
                          proj['bld_item'].childCount()
                          if proj['bld_item'] else -1))
            extra += ' bayinf=%d' % len(proj.get('bayinf') or {})
            try:
                win.grab().save('_guitest.png')   # 自检截屏（视觉核对用）
            except Exception:
                pass
            # 顺带自检第三视图「按文件（cbm → dev）」
            if proj['mode'] == 0:
                try:
                    mode_box.setCurrentIndex(2)
                    rows_f = proj.get('file_rows') or []
                    extra += ' file_cbm=%d file_dev=%d file_nodes=%d' % (
                        len(rows_f), len({r['dev'] for r in rows_f}), len(proj['u2iid']))
                    win.grab().save('_guitest_file.png')
                    # 回到 BTV 并全展开，抓一张叶子样例（含 [设]/[材] 编码）
                    mode_box.setCurrentIndex(0)
                    tree.expandAll()
                    leaf = ''
                    for i in range(tree.topLevelItemCount()):
                        it = tree.topLevelItem(i)
                        for j in range(it.childCount()):
                            ch = it.child(j)
                            for k in range(ch.childCount()):
                                g2 = ch.child(k)
                                for m in range(g2.childCount()):
                                    leaf = g2.child(m).text(0)
                                    break
                                if leaf:
                                    break
                            if leaf:
                                break
                        if leaf:
                            break
                    extra += ' leaf="%s"' % leaf[:60]
                    win.grab().save('_guitest_tree.png')
                except Exception:
                    _log('视图自检失败:\n' + traceback.format_exc())
            print('GUITEST-OK nodes_in_tree=%d proj=%s %s%s' %
                  (n, t.proj_name if t else '?', msg, extra), flush=True)
            app.quit()
        QtCore.QTimer.singleShot(150000 if init_dir else 3000, _quit)
    win.show()
    app.exec()

