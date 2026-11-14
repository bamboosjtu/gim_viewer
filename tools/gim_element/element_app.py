# -*- coding: utf-8 -*-
"""
element_app.py —— GIM 实体盘点器（桌面版）

把一个 GIM 工程（.gim 或解包目录）里的全部实体盘成四本账：
设备 / 装置性材料 / 构件 / 其他。解析在 element_core，外壳只负责
选文件、跑后台线程、展示台账与导出报告。

线程约定：解析在后台 QThread 里跑，结果写入共享容器，主线程用
QTimer 轮询取回（不用跨线程 Signal —— 冻结环境下的 queued 投递不可靠）。
"""
import os
import sys
import json
import time
import traceback
from html import escape

from PySide6.QtCore import Qt, QTimer, QThread, QSettings
from PySide6.QtGui import QAction, QKeySequence, QIcon, QPainter, QPixmap, QColor, QPen, QFont
from PySide6.QtWidgets import (QApplication, QMainWindow, QFileDialog, QMessageBox,
                               QWidget, QVBoxLayout, QHBoxLayout, QLabel, QProgressBar,
                               QSplitter, QTreeWidget, QTreeWidgetItem, QTableWidget,
                               QTableWidgetItem, QTextBrowser, QLineEdit, QHeaderView,
                               QAbstractItemView, QStyle)

import element_core as E

APP_NAME = 'GIM 实体盘点器'
APP_VER = '0.2.3'
HERE = os.path.dirname(os.path.abspath(__file__))
SMOKE = '--smoke' in sys.argv          # smoke 模式禁用模态框，避免自动测试阻塞

GROUP_ORDER = [E.G_DEV, E.G_MAT, E.G_STR, E.G_OTH]
GROUP_ICON = {E.G_DEV: '⚙', E.G_MAT: '▨', E.G_STR: '▤', E.G_OTH: '·'}


def app_icon():
    pm = QPixmap(128, 128)
    pm.fill(Qt.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.Antialiasing)
    p.setBrush(QColor('#2c6e49')); p.setPen(Qt.NoPen)
    p.drawRoundedRect(8, 8, 112, 112, 24, 24)
    p.setPen(QPen(QColor('#ffffff'), 7))
    p.setBrush(Qt.NoBrush)
    # 四格台账图标
    p.drawRect(34, 36, 26, 26); p.drawRect(68, 36, 26, 26)
    p.drawRect(34, 70, 26, 26); p.drawRect(68, 70, 26, 26)
    p.fillRect(38, 40, 18, 18, QColor('#ffffff'))
    p.fillRect(72, 74, 18, 18, QColor('#ffffff'))
    p.end()
    return QIcon(pm)


def fmt(n):
    return format(n, ',')


# --------------------------------------------------------------------------
# 后台解析
# --------------------------------------------------------------------------
class ParseWorker(QThread):
    def __init__(self, path):
        super().__init__()
        self.path = path
        self.result = None
        self.error = None
        self.done = False
        self.messages = []

    def progress(self, msg):
        self.messages.append(msg)

    def run(self):
        try:
            self.result = E.scan(self.path, progress=self.progress)
        except Exception:
            self.error = traceback.format_exc(limit=6)
        finally:
            self.done = True


# --------------------------------------------------------------------------
# 主窗口
# --------------------------------------------------------------------------
class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.setWindowIcon(app_icon())
        self.resize(1360, 860)
        self.setAcceptDrops(True)

        self.settings = QSettings(os.path.abspath('smoke-settings.ini'), QSettings.IniFormat) if SMOKE else QSettings('GIMElement', 'Inventory')
        self.worker = None
        self.cur_path = None
        self.result = None
        self._table_pairs = []
        self.recent = self.settings.value('recent', []) or []
        if isinstance(self.recent, str):
            self.recent = [self.recent]

        central = QWidget()
        lay = QHBoxLayout(central)
        lay.setContentsMargins(6, 6, 6, 6)

        # ---- 左侧：属性面板（选中右下实例时显示该实例的全部属性）----
        self.prop = QTextBrowser()
        self.prop.setMinimumWidth(250)
        self.prop.setStyleSheet('QTextBrowser{border:1px solid #dfe5ee;border-radius:6px;'
                                'background:#fbfcfe;}')
        self.prop.setHtml(self._prop_placeholder())

        # ---- 右侧：台账树 + 明细 ----
        vs = QSplitter(Qt.Vertical)
        self.tree = QTreeWidget()
        self.tree.setColumnCount(4)
        self.tree.setHeaderLabels(['分类 / 名称模板', 'dev 轨道', 'ifc 轨道', '合计'])
        self.tree.header().setSectionResizeMode(0, QHeaderView.Stretch)
        for c in (1, 2, 3):
            self.tree.header().setSectionResizeMode(c, QHeaderView.ResizeToContents)
        self.tree.setAlternatingRowColors(True)
        self.tree.itemSelectionChanged.connect(self._on_tree_sel)
        vs.addWidget(self.tree)

        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(['名称实例', '轨道', '状态', 'IFC 类型', '来源文件'])
        self.table.horizontalHeader().setMinimumSectionSize(58)
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        for c in (1, 2, 3, 4):
            self.table.horizontalHeader().setSectionResizeMode(c, QHeaderView.ResizeToContents)
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        self.table.setWordWrap(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.itemSelectionChanged.connect(self._on_sample_sel)
        vs.addWidget(self.table)
        vs.setSizes([560, 240])

        hs = QSplitter(Qt.Horizontal)
        hs.addWidget(self.prop)
        hs.addWidget(vs)
        hs.setStretchFactor(0, 0)
        hs.setStretchFactor(1, 1)
        hs.setSizes([330, 1000])
        lay.addWidget(hs, 1)
        self.setCentralWidget(central)

        # ---- 状态栏：左侧进度/提示，右侧四组盘点数（原左栏总览） ----
        self.status = self.statusBar()
        self.status.setStyleSheet('QStatusBar{background:#f6f8fb;border-top:1px solid #dfe5ee;'
                                  'color:#5c6b7f;font-size:11px;} QStatusBar::item{border:0}')
        self.lb_status = QLabel('就绪 —— 打开 .gim 文件或已解包的工程目录')
        self.lb_kpi = QLabel('')
        self.lb_kpi.setTextFormat(Qt.RichText)
        self.lb_kpi.setStyleSheet('QLabel{color:#5c6b7f;font-size:11px;padding-right:6px;}')
        self.prog = QProgressBar()
        self.prog.setMaximumWidth(220)
        self.prog.setMaximumHeight(14)
        self.prog.setRange(0, 0)
        self.prog.setTextVisible(False)
        self.prog.setVisible(False)
        self.status.addWidget(self.lb_status, 1)
        self.status.addPermanentWidget(self.prog)
        self.status.addPermanentWidget(self.lb_kpi)

        self._build_menu()

        args = [a for a in sys.argv[1:] if not a.startswith('-')] \
            if '--smoke' in sys.argv or '--open' in sys.argv else []
        if args:
            QTimer.singleShot(300, lambda: self.open_path(args[0]))

    # ---------- 菜单 ----------
    def _build_menu(self):
        mb = self.menuBar()
        mb.setStyleSheet('QMenuBar{background:#ffffff;border-bottom:1px solid #e3e8ef;'
                         'font-size:12px;} QMenuBar::item{padding:5px 11px;}'
                         'QMenuBar::item:selected{background:#eef3f8;}'
                         'QMenu{background:#ffffff;border:1px solid #e3e8ef;font-size:12px;padding:4px;}'
                         'QMenu::item{padding:5px 22px 5px 14px;}'
                         'QMenu::item:selected{background:#e8f1f8;}')
        m = mb.addMenu('文件(&F)')
        a = QAction('打开 GIM / 目录…', self)
        a.setShortcut(QKeySequence.Open)
        a.triggered.connect(self.pick_file)
        m.addAction(a)
        self.m_recent = m.addMenu('最近打开')
        self._rebuild_recent()
        m.addSeparator()
        a = QAction('导出 CSV…', self); a.triggered.connect(self.export_csv); m.addAction(a)
        a = QAction('导出 JSON…', self); a.triggered.connect(self.export_json); m.addAction(a)
        a = QAction('导出 HTML 报告…', self); a.setShortcut('Ctrl+E')
        a.triggered.connect(self.export_html); m.addAction(a)
        m.addSeparator()
        a = QAction('退出', self); a.setShortcut('Ctrl+Q')
        a.triggered.connect(self.close); m.addAction(a)

        m = mb.addMenu('帮助(&H)')
        a = QAction('使用说明', self); a.setShortcut('F1')
        a.triggered.connect(self.help_dialog); m.addAction(a)
        a = QAction('关于', self); a.triggered.connect(self.about); m.addAction(a)

        # 工具栏：搜索
        tb = self.addToolBar('搜索')
        tb.setStyleSheet('QToolBar{background:#f6f8fb;border-bottom:1px solid #dfe5ee;padding:4px;}')
        lb = QLabel(' 搜索 ')
        f = QFont(); f.setPointSize(9)
        lb.setFont(f)
        tb.addWidget(lb)
        self.search = QLineEdit()
        self.search.setPlaceholderText('按名称模板过滤（回车生效，清空恢复）')
        self.search.setMaximumWidth(280)
        self.search.returnPressed.connect(self._apply_filter)
        tb.addWidget(self.search)
        act_clear = QAction('清除', self)
        act_clear.triggered.connect(lambda: (self.search.clear(), self._apply_filter()))
        tb.addAction(act_clear)

    def _rebuild_recent(self):
        self.m_recent.clear()
        if not self.recent:
            a = QAction('（空）', self); a.setEnabled(False); self.m_recent.addAction(a)
            return
        for p in self.recent[:8]:
            a = QAction(os.path.basename(p.rstrip('\\/')), self)
            a.setToolTip(p)
            a.triggered.connect(lambda _=False, path=p: self.open_path(path))
            self.m_recent.addAction(a)
        self.m_recent.addSeparator()
        a = QAction('清空列表', self)
        a.triggered.connect(self._clear_recent)
        self.m_recent.addAction(a)

    def _clear_recent(self):
        self.recent = []
        self.settings.setValue('recent', [])
        self._rebuild_recent()

    def _push_recent(self, path):
        self.recent = [path] + [p for p in self.recent if p != path]
        self.recent = self.recent[:8]
        self.settings.setValue('recent', self.recent)
        self._rebuild_recent()

    # ---------- 打开 ----------
    def pick_file(self):
        start = self.settings.value('lastDir', '') or ''
        path, _ = QFileDialog.getOpenFileName(
            self, '打开 GIM 文件', start,
            'GIM 模型 (*.gim);;所有文件 (*)')
        if path:
            self.open_path(path)
            return
        # 允许直接选目录
        d = QFileDialog.getExistingDirectory(self, '或选择已解包的工程目录', start)
        if d:
            self.open_path(d)

    def open_path(self, path):
        path = path.rstrip('\\/')
        if os.path.isfile(path):
            ok = path.lower().endswith('.gim')
        else:
            ok = os.path.isdir(path)
        if not ok:
            if SMOKE:
                print('SMOKE_FAIL_OPEN', path, flush=True)
                return
            QMessageBox.warning(self, '无法打开',
                                '请选择 .gim 文件或已解包的工程目录：\n' + path)
            return
        if self.worker is not None:
            if SMOKE:
                return
            QMessageBox.information(self, '提示', '正在解析中，请稍候。')
            return
        self.cur_path = path
        self.settings.setValue('lastDir', os.path.dirname(path) if os.path.isfile(path) else path)
        self.setWindowTitle('%s — %s' % (os.path.basename(path), APP_NAME))
        self.lb_status.setText('解析中…')
        self.prog.setVisible(True)
        self.tree.clear()
        self.table.setRowCount(0)
        self._table_pairs = []
        self.prop.setHtml(self._prop_placeholder())
        self.lb_kpi.setText('')
        self.lb_kpi.setToolTip('')
        self.worker = ParseWorker(path)
        self.worker.start()
        self._poll = QTimer(self)
        self._poll.timeout.connect(self._check_worker)
        self._poll.start(150)

    def _check_worker(self):
        w = self.worker
        if not w:
            return
        if w.messages:
            self.lb_status.setText(w.messages[-1][:120])
            w.messages = []
        if not w.done:
            return
        self._poll.stop()
        self.prog.setVisible(False)
        self.worker = None
        if w.error:
            self.lb_status.setText('解析失败')
            if SMOKE:
                self._smoke_error = w.error
                print('SMOKE_FAIL_PARSE', w.error, flush=True)
                return
            QMessageBox.critical(self, '解析失败', w.error)
            return
        self.result = w.result
        self._populate()
        self._push_recent(self.cur_path)

    # ---------- 结果填充 ----------
    def _populate(self):
        r = self.result
        m = r['meta']
        self.lb_status.setText('完成：用时 %.1f 秒' % m['elapsed'])
        self.lb_kpi.setText(self._kpi_html(r))
        self.lb_kpi.setToolTip(self._kpi_tip(r))
        self.prop.setHtml(self._prop_placeholder())
        self._fill_tree(r['rows'])
        self._fill_group_summary()

    def _fill_tree(self, rows):
        self.tree.clear()
        flt = self.search.text().strip().lower()
        for g in GROUP_ORDER:
            grows = [r for r in rows if r['group'] == g and (r['dev'] or r['ifc'])]
            if not grows:
                continue
            gd, gi = sum(r['dev'] for r in grows), sum(r['ifc'] for r in grows)
            root = QTreeWidgetItem([g, fmt(gd), fmt(gi), fmt(gd + gi)])
            root.setIcon(0, self.style().standardIcon(QStyle.SP_DirIcon))
            f = QFont(); f.setBold(True)
            root.setFont(0, f)
            self.tree.addTopLevelItem(root)
            # 类别
            cats = {}
            for r in grows:
                cats.setdefault(r['cat'], []).append(r)
            for cat in sorted(cats, key=lambda c: self._cat_key(g, c, cats[c])):
                crows = cats[cat]
                cd, ci = sum(r['dev'] for r in crows), sum(r['ifc'] for r in crows)
                code = crows[0].get('code', '')
                stdcat = crows[0].get('stdcat', '') or cat
                label = ('%s  %s' % (code, stdcat)) if code and code != 'U-OBJECT' else cat
                cit = QTreeWidgetItem([label, fmt(cd), fmt(ci), fmt(cd + ci)])
                cit.setToolTip(0, '目录口径：%s' % cat)
                root.addChild(cit)
                # 子类 → 模板（设备侧用标准细分：E16 的 terminal_box / panel_cabinet…）
                subs = {}
                for r in crows:
                    key = (r.get('std_sub') or r['sub']) if g == E.G_DEV else r['sub']
                    subs.setdefault(key, []).append(r)
                if len(subs) > 1 or '' not in subs:
                    for sub in sorted(subs, key=lambda s: self._sub_key(g, code, s, subs[s])):
                        srows = subs[sub]
                        sd, si = sum(r['dev'] for r in srows), sum(r['ifc'] for r in srows)
                        scode = srows[0].get('code', '')
                        slabel = sub or '（本体）'
                        if g == E.G_DEV and sub:
                            slabel = E.S.dev_sub_label(sub) or slabel
                        elif g == E.G_STR and scode and scode != 'U-OBJECT':
                            slabel = '%s  %s' % (scode, slabel)
                        elif scode and scode != code:
                            slabel = '%s  %s' % (scode, slabel)
                        sit = QTreeWidgetItem([slabel, fmt(sd), fmt(si), fmt(sd + si)])
                        cit.addChild(sit)
                        self._add_templates(sit, srows, flt)
                    if flt:
                        cit.setExpanded(True)
                else:
                    self._add_templates(cit, subs.get('', []), flt)
        if flt:
            self.tree.expandAll()

    def _cat_key(self, g, cat, crows):
        """类别行顺序：设备/材料/其他按目录编码；构件按标准 4 大类次序。

        构件编码在子类层（C-A1…），不能拿首行的子类编码当大类键——否则
        「建筑本体构件」会显示成「C-A3 柱」、大类顺序也会随桶插入顺序漂。
        """
        return E.S.order_key(crows[0].get('code', '')) + (0,)

    def _sub_key(self, g, catcode, sub, srows):
        """子类顺序：E16 固定细分顺序 → 有独立子类编码的按编码 → 其余按数量。"""
        if g == E.G_DEV and sub in E.S.E16_SEQ:
            return (0, E.S.E16_SEQ[sub], 0, 0)
        scode = srows[0].get('code', '')
        if g == E.G_STR and scode and scode != 'U-OBJECT':
            return (1,) + E.S.order_key(scode)
        if scode and scode != catcode:
            return (1,) + E.S.order_key(scode)
        return (2, 0, 0, -sum(x['total'] for x in srows))

    def _add_templates(self, parent_item, rows, flt):
        rows = sorted(rows, key=lambda r: -r['total'])
        for r in rows:
            if flt and flt not in r['template'].lower():
                continue
            it = QTreeWidgetItem([r['template'] or '—', fmt(r['dev']), fmt(r['ifc']),
                                  fmt(r['total'])])
            it.setData(0, Qt.UserRole, r)
            parent_item.addChild(it)

    def _fill_group_summary(self):
        """默认选中第一个组，展示组内 top 模板。"""
        it = self.tree.topLevelItem(0)
        if it:
            self.tree.setCurrentItem(it)

    def _on_tree_sel(self):
        items = self.tree.selectedItems()
        if not items:
            return
        it = items[0]
        depth = self._depth(it)
        if depth >= 3:                       # 模板行：直接给样本
            r = it.data(0, Qt.UserRole)
            if r:
                self._fill_table([(s, r) for s in r['samples']])
                return
        # 组/类别/子类行：聚合下层模板样本
        rows = []
        self._collect_templates(it, rows)
        rows.sort(key=lambda x: -x[0])
        pairs = []
        for _n, r in rows[:40]:
            for s in r['samples'][:12]:
                pairs.append((s, r))
        self._fill_table(pairs)

    def _depth(self, it):
        d = 0
        p = it.parent()
        while p is not None:
            d += 1
            p = p.parent()
        return d

    def _collect_templates(self, it, out):
        if it.childCount() == 0:
            r = it.data(0, Qt.UserRole)
            if r and (r['dev'] or r['ifc']):
                out.append((r['total'], r))
            return
        for i in range(it.childCount()):
            self._collect_templates(it.child(i), out)

    def _fill_table(self, pairs):
        """pairs = [(sample, row), …]；row 供属性面板显示所属模板与统计。"""
        self._table_pairs = pairs
        self.table.setRowCount(len(pairs))
        track_name = {'dev': 'dev 轨道', 'ifc': 'ifc 轨道'}
        for i, (s, _r) in enumerate(pairs):
            track, name, src = s[0], s[1], s[2]
            ifctype = s[3] if len(s) > 3 else ''
            stt = s[4] if len(s) > 4 else ''
            self.table.setItem(i, 0, QTableWidgetItem(name))
            self.table.setItem(i, 1, QTableWidgetItem(track_name.get(track, track)))
            it = QTableWidgetItem(stt)
            if stt == E.S.ST_OK:
                it.setForeground(QColor('#1f7a3d'))
            elif stt == E.S.ST_CAND:
                it.setForeground(QColor('#a06800'))
            elif stt == E.S.ST_UNC:
                it.setForeground(QColor('#9aa3ad'))
            self.table.setItem(i, 2, it)
            self.table.setItem(i, 3, QTableWidgetItem(ifctype))
            self.table.setItem(i, 4, QTableWidgetItem(src))
        if pairs:
            self.table.selectRow(0)
        else:
            self.prop.setHtml(self._prop_placeholder())

    # ---------- 过滤 ----------
    def _apply_filter(self):
        if self.result:
            self._fill_tree(self.result['rows'])

    # ---------- 状态栏：四组盘点数（原左栏总览） ----------
    def _kpi_html(self, r):
        tt, st, m = r['totals'], r['stats'], r['meta']
        bits = [
            ('#1a5fb4', '设备', tt[E.G_DEV]['台数'], '台'),
            ('#613583', '材料', tt[E.G_MAT]['dev'] + tt[E.G_MAT]['ifc'], '件'),
            ('#26734d', '构件', tt[E.G_STR]['dev'] + tt[E.G_STR]['ifc'], '件'),
            ('#8a6d3b', '其他', tt[E.G_OTH]['dev'] + tt[E.G_OTH]['ifc'], '条'),
        ]
        head = '&nbsp;·&nbsp;'.join(
            '<span style="color:%s">%s</span>&nbsp;<b style="color:#1c1c1e">%s</b>&nbsp;%s'
            % (c, lab, fmt(n), unit) for c, lab, n, unit in bits)
        tail = ('&nbsp;&nbsp;│&nbsp;&nbsp;<span style="color:#8a94a6">%s · dev 位 %s · ifc 暴露 %s · %.1f s</span>'
                % (escape(os.path.basename(m['source'])), fmt(st.get('dev位', 0)),
                   fmt(st.get('ifc暴露层', 0)), m['elapsed']))
        return '<span style="font-size:11px">%s%s</span>' % (head, tail)

    def _kpi_tip(self, r):
        tt, st, m = r['totals'], r['stats'], r['meta']
        return ('%s（%s%s）\n'
                '设备 %s 台 · 材料 %s 件 · 构件 %s 件 · 其他 %s 条\n\n'
                'dev 轨道：dev 位 %s（PI 部件 %s）· cbm %s · fam %s · dev %s\n'
                'ifc 轨道：文件 %s · 实体行 %s · 暴露层 %s · 封装内部 %s\n'
                '用时 %.1f 秒'
                % (os.path.basename(m['source']), m['kind'],
                   '（%s）' % m['container'] if m.get('container') else '',
                   fmt(tt[E.G_DEV]['台数']), fmt(tt[E.G_MAT]['dev'] + tt[E.G_MAT]['ifc']),
                   fmt(tt[E.G_STR]['dev'] + tt[E.G_STR]['ifc']),
                   fmt(tt[E.G_OTH]['dev'] + tt[E.G_OTH]['ifc']),
                   fmt(st.get('dev位', 0)), fmt(st.get('PI部件dev', 0)),
                   fmt(st.get('cbm文件', 0)), fmt(st.get('fam文件', 0)),
                   fmt(st.get('dev文件', 0)), fmt(st.get('ifc文件', 0)),
                   fmt(st.get('ifc实体行', 0)), fmt(st.get('ifc暴露层', 0)),
                   fmt(st.get('ifc封装内部', 0)), m['elapsed']))

    # ---------- 左侧属性面板 ----------
    def _prop_placeholder(self):
        return ('<div style="padding:12px 14px;font-size:12px;color:#5b6472;line-height:1.9">'
                '<b style="font-size:13px;color:#1c1c1e">属性</b><br><br>'
                '在右下「名称实例」中选中一行，这里显示该实例的全部属性：<br>'
                '名称 · 轨道 · 状态 · IFC 类型 · 来源文件，<br>'
                '以及所属分组 / 目录编码 / 类别与子类 / 名称模板与模板统计。<br><br>'
                '<span style="color:#8a94a6">未选中实例时本面板为空。</span></div>')

    def _prop_block(self, title, rows):
        h = ['<div style="margin:0 0 10px 0">'
             '<div style="font-size:11px;color:#8a94a6;margin:0 0 3px 2px">%s</div>'
             '<table width="100%%" cellspacing="0" cellpadding="0" '
             'style="background:#ffffff;border:1px solid #e3e8ef">' % escape(title)]
        for i, (k, v) in enumerate(rows):
            bg = 'background:#fafbfd;' if i % 2 else ''
            h.append('<tr style="%s"><td style="color:#7b8899;padding:4px 6px 4px 9px;'
                     'font-size:11px;white-space:nowrap;vertical-align:top">%s</td>'
                     '<td style="padding:4px 9px 4px 6px;font-size:12px;color:#1c1c1e">%s</td></tr>'
                     % (bg, escape(k), v))
        h.append('</table></div>')
        return ''.join(h)

    def _prop_html(self, s, r):
        track, name, src = s[0], s[1], s[2]
        ifctype = s[3] if len(s) > 3 else ''
        stt = s[4] if len(s) > 4 else ''
        sc = {E.S.ST_OK: '#1f7a3d', E.S.ST_CAND: '#a06800'}.get(stt, '#8a94a6')
        tname = {'dev': 'dev 轨道', 'ifc': 'ifc 轨道'}.get(track, track or '—')
        sub = r.get('sub') or ''
        if r['group'] == E.G_DEV:
            sub = E.S.dev_sub_label(r.get('std_sub') or '') or sub
        dist = ' · '.join('%s %s' % (k, fmt(v)) for k, v in
                          sorted((r.get('st') or {}).items(), key=lambda kv: -kv[1])) or '—'
        files = '<br>'.join('%s <span style="color:#8a94a6">(%s)</span>'
                            % (escape(str(fn)), fmt(n))
                            for fn, n in (r.get('files') or [])[:3]) or '—'
        h = ['<div style="padding:10px 12px;font-size:12px">']
        bits = []
        for x in (r.get('code'), r.get('cat'), sub):
            x = (x or '').strip()
            if x and x not in bits:
                bits.append(x)
        h.append('<b style="font-size:13px;color:#1c1c1e">实例属性</b>'
                 '<div style="color:#8a94a6;font-size:11px;margin:2px 0 9px 0">%s</div>'
                 % escape(' · '.join(bits)))
        h.append(self._prop_block('实例', [
            ('名称', escape(name or '—')),
            ('轨道', escape(tname)),
            ('状态', ('<span style="color:%s">%s</span>' % (sc, escape(stt))) if stt else '—'),
            ('IFC 类型', escape(ifctype or '—')),
            ('来源文件', escape(src or '—')),
        ]))
        h.append(self._prop_block('归属', [
            ('分组', escape(r.get('group', '') or '—')),
            ('目录编码', escape(r.get('code', '') or '—')),
            ('标准类别', escape(r.get('stdcat', '') or '—')),
            ('类别', escape(r.get('cat', '') or '—')),
            ('子类', escape(sub or '—')),
            ('名称模板', escape(r.get('template', '') or '—')),
        ]))
        if len(s) > 5 and self.result:
            entity = next((item for item in self.result.get('entityTree', []) if item['id'] == s[5]), None)
            if entity:
                h.append(self._prop_block('实体身份', [('entityId', escape(entity['id'])), ('规则版本', escape(self.result['meta'].get('engineRulesVersion', '')))]))
                parts = []
                for part in entity['parts']:
                    meaning = part['interpretation']
                    term = (meaning.get('componentType') or {}).get('id', meaning.get('meaning', ''))
                    proof = '；'.join(meaning.get('membershipEvidence') or meaning.get('classificationEvidence') or [])
                    parts.append((part['name'] or part['sourceId'], escape('%s · %s · %s · 来源父级 %s · %s' % (term, meaning.get('membershipStatus', ''), part['sourceId'], part['rawParent'] or '无', proof))))
                h.append(self._prop_block('设备/材料/构件 → 部件与组成来源', parts))
        h.append(self._prop_block('模板统计', [
            ('dev / ifc', '%s / %s' % (fmt(r.get('dev', 0)), fmt(r.get('ifc', 0)))),
            ('合计', '<b>%s</b>' % fmt(r.get('total', 0))),
            ('状态分布', escape(dist)),
            ('主要来源', files),
        ]))
        h.append('</div>')
        return ''.join(h)

    def _on_sample_sel(self):
        rows = self.table.selectionModel().selectedRows()
        if not rows or not self._table_pairs:
            self.prop.setHtml(self._prop_placeholder())
            return
        i = rows[0].row()
        if 0 <= i < len(self._table_pairs):
            s, r = self._table_pairs[i]
            self.prop.setHtml(self._prop_html(s, r))

    # ---------- 导出 ----------
    def _export_path(self, ext):
        base = os.path.basename(self.cur_path.rstrip('\\/')) if self.cur_path else 'gim实体盘点'
        start = self.settings.value('lastDir', '') or ''
        return os.path.join(start, '%s.%s' % (base, ext))

    def export_csv(self):
        if not self.result:
            QMessageBox.information(self, '提示', '请先解析一个工程。')
            return
        path, _ = QFileDialog.getSaveFileName(self, '导出 CSV', self._export_path('csv'),
                                              'CSV (*.csv)')
        if not path:
            return
        import csv
        with open(path, 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.writer(f)
            w.writerow(['组', '编码', '类别', '子类', '名称模板', 'dev轨道', 'ifc轨道', '合计',
                        '已确认', '候选', '未确认'])
            for r in self.result['rows']:
                stt = r.get('st') or {}
                w.writerow([r['group'], r.get('code', ''), r['cat'], r['sub'], r['template'],
                            r['dev'], r['ifc'], r['total'],
                            stt.get(E.S.ST_OK, 0), stt.get(E.S.ST_CAND, 0),
                            stt.get(E.S.ST_UNC, 0)])
        self.lb_status.setText('已导出 CSV：%s' % path)

    def export_json(self):
        if not self.result:
            QMessageBox.information(self, '提示', '请先解析一个工程。')
            return
        path, _ = QFileDialog.getSaveFileName(self, '导出 JSON', self._export_path('json'),
                                              'JSON (*.json)')
        if not path:
            return
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(self.result, f, ensure_ascii=False, indent=1)
        self.lb_status.setText('已导出 JSON：%s' % path)

    def export_html(self):
        if not self.result:
            QMessageBox.information(self, '提示', '请先解析一个工程。')
            return
        path, _ = QFileDialog.getSaveFileName(self, '导出 HTML 报告', self._export_path('html'),
                                              'HTML (*.html)')
        if not path:
            return
        with open(path, 'w', encoding='utf-8') as f:
            f.write(E.build_html(self.result))
        self.lb_status.setText('已导出报告：%s' % path)

    # ---------- 拖放 ----------
    def dragEnterEvent(self, ev):
        if ev.mimeData().hasUrls():
            for u in ev.mimeData().urls():
                p = u.toLocalFile()
                if p.lower().endswith('.gim') or os.path.isdir(p):
                    ev.acceptProposedAction()
                    return
        ev.ignore()

    def dropEvent(self, ev):
        for u in ev.mimeData().urls():
            p = u.toLocalFile()
            if p.lower().endswith('.gim') or os.path.isdir(p):
                self.open_path(p)
                return

    # ---------- 对话框 ----------
    def about(self):
        QMessageBox.about(self, '关于', """
        <h3>%s</h3><p style="color:#5c6b7f">版本 %s</p>
        <p>解析 GIM 工程，把全部实体盘成四本账：
        <b>设备</b>（E01–E19／E-T，DEV 本体定粒度）、
        <b>装置性材料</b>（M01–M09，dev+ifc 两轨）、
        <b>构件</b>（C-A1…C-D6，4 大类 28 子类）、
        <b>其他</b>（U-*：词域外/空间骨架/无名称/内部来源）。</p>
        <p style="font-size:12px;color:#7b8899">
        粒度按「施工运维可整体识别」定，与 F2/F3/F4、CBM/DEV 拆件无关；<br>
        每条记录带证据状态：已确认 / 候选（仅型号或用途待定）/ 未确认；<br>
        dev 轨道：CBM→OBJECTMODELPOINTER→DEV，变压器本体与中性点成套装置并为一台，
        主变保护柜/测控柜/智能柜/电能表柜归二次设备，
        PI 部件计材料实例与箱柜类设备，构件部件（灯端子板等）并入父件；<br>
        ifc 轨道：只识别暴露层（空间骨架/产品实体），
        几何与属性等内部表达对内封装，无名称实体单列并保留 IFC 类型。</p>
        """ % (APP_NAME, APP_VER))

    def help_dialog(self):
        QMessageBox.information(self, '使用说明', """
操作
  Ctrl+O 打开 .gim 文件或已解包的工程目录（也可拖入）
  右上分类树双击展开，右下显示该分类下的名称实例
  选中右下任意实例，左下属性面板显示它的全部属性
  底部状态栏显示四组盘点数，鼠标悬停可看来源与轨道统计
  顶部搜索框按名称模板过滤

口径（标准见同目录 01/02/03 三份 .md）
  粒度   以「施工运维可整体识别」的工程实体为单位，与 F2/F3/F4、CBM/DEV 拆件无关；
         整体内部组成（单相本体/散热器/柜体/端子排/螺栓）只作来源成员；
         有独立子装配身份的（主变 DEV 内嵌但有自己 .dev 的端子箱）不吞入本体。
  编码   设备 E01–E19（变压器用途不明为 E-T）、材料 M01–M09、构件 C-A1…C-D6、
         其他 U-*（空间骨架/型号模板/无名产品/内部来源）；目录出处另存。
         二次设备细分为 terminal_box / panel_cabinet / control_cabinet / battery_set，
         动力辅助与水工暖通保留具体设备类型（检修箱/机构箱/电缆终端/风机…）。
  状态   已确认 / 候选 / 未确认 —— 只有型号或用途待定记候选，词域外与无名称记未确认。
  设备   按《通用设备目录》2018/2025 并集 19 类；
         变压器 = 本体+散热器+中性点成套装置（附件并入，不单独计台）；
         主变保护柜/测控柜/智能柜/电能表柜属二次设备；
         「设备_部件」命名上卷到父设备；PI 层计材料实例与箱柜类设备
         （端子箱/汇控柜/机构箱等），其余装配内部部件对内封装。
  装置性材料 造价口径 9 大类（导线/母线/金具/绝缘子/电缆/接地材料/套管/槽盒/其他材料），
         dev（F4+PI）与 ifc 两轨分别计数、互补不合并。
  构件   4 大类 28 子类：建筑本体（墙/楼板/柱/梁/板/屋面/门/窗/楼梯/面层）、
         结构构架与基础（设备支架/基础/型钢/檩条/构架）、
         水工与总图（电缆沟/排水沟/检查井/围墙/道路）、
         附属设施（照明/消防/安防/暖通/给排水/其他）。
         部件（灯端子板/接线盒/支架立柱）并入父件，不单独计量；
         挂载层（几何/属性/材料/样式）与关系层对内封装，只计总数。
  其他   词域外（无法识别/尺寸占位/几何壳名/分组容器/间隔名）、空间骨架、
         型号模板、端口与系统、紧固件内部来源，以及 ifc 无名称产品实体。

导出
  Ctrl+E 导出 HTML 盘点报告；另支持 CSV / JSON。
        """)


def main():
    if '--self-check' in sys.argv:
        return  # Imports above exercise Qt, the parser and the bundled catalog.
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setWindowIcon(app_icon())
    app.setStyle('Fusion')
    w = MainWindow()
    w.show()

    if '--smoke' in sys.argv:
        idx = sys.argv.index('--smoke')
        target = sys.argv[idx + 1] if len(sys.argv) > idx + 1 else ''
        outpng = sys.argv[idx + 2] if len(sys.argv) > idx + 2 else 'smoke.png'
        state = {'started': False}

        def check():
            if not state['started']:
                return
            if w.worker is None and not w.result:
                print('SMOKE_FAIL_PARSE', flush=True)
                app.exit(1)
                return
            if w.worker is None:
                if not w.grab().save(outpng, 'PNG'):
                    app.exit(1)
                    return
                with open(outpng + '.json', 'w', encoding='utf-8') as receipt:
                    json.dump({'frozen': bool(getattr(sys, 'frozen', False)),
                               'groups': [w.tree.topLevelItem(i).text(0).strip() for i in range(w.tree.topLevelItemCount())],
                               'totals': w.result['totals']}, receipt, ensure_ascii=False, indent=2)
                print('SMOKE_SHOT', outpng, flush=True)
                app.quit()

        def go():
            state['started'] = True
            if target:
                w.open_path(target)
            w._smoke_timer = QTimer()
            w._smoke_timer.timeout.connect(check)
            w._smoke_timer.start(1200)
        QTimer.singleShot(1500, go)

    sys.exit(app.exec())


if __name__ == '__main__':
    main()
