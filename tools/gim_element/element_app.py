# -*- coding: utf-8 -*-
"""
element_app.py —— GIM 实体盘点器（桌面版）

把一个 GIM 工程（.gim 或解包目录）里的全部实体盘成四本账：
设备 / 材料 / 构件 / 其他。解析在 element_core，外壳只负责
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
                               QAbstractItemView, QStyle, QDialog, QPlainTextEdit,
                               QDialogButtonBox, QPushButton)

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

        if SMOKE:
            index = sys.argv.index('--smoke')
            screenshot = sys.argv[index + 2] if len(sys.argv) > index + 2 else 'smoke.png'
            self.settings = QSettings(os.path.abspath(screenshot + '.settings.ini'), QSettings.IniFormat)
        else:
            self.settings = QSettings('GIMElement', 'Inventory')
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
        self.tree.setColumnCount(2)
        self.tree.setHeaderLabels(['分类 / 名称', '数量'])
        self.tree.header().setSectionResizeMode(0, QHeaderView.Stretch)
        for c in (1,):
            self.tree.header().setSectionResizeMode(c, QHeaderView.ResizeToContents)
        self.tree.setAlternatingRowColors(True)
        self.tree.itemSelectionChanged.connect(self._on_tree_sel)
        self.tree.setExpandsOnDoubleClick(False)
        self.tree.itemDoubleClicked.connect(self._on_tree_double_clicked)
        vs.addWidget(self.tree)

        self.table = QTableWidget(0, 3)
        self.table.setHorizontalHeaderLabels(['名称', '状态', '来源文件'])
        self.table.horizontalHeader().setMinimumSectionSize(58)
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        for c in (1, 2):
            self.table.horizontalHeader().setSectionResizeMode(c, QHeaderView.ResizeToContents)
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        self.table.setWordWrap(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.itemSelectionChanged.connect(self._on_sample_sel)
        self.table.cellDoubleClicked.connect(self._on_entity_double_clicked)
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
        pending = r['stats']['待归整体']
        self.lb_status.setText(('完成：用时 %.1f 秒' % m['elapsed']) + (' · %d 个整体归属待确认（见 JSON 导出）' % pending if pending else ''))
        self.lb_kpi.setText(self._kpi_html(r))
        self.lb_kpi.setToolTip(self._kpi_tip(r))
        self.prop.setHtml(self._prop_placeholder())
        self._fill_tree(r['rows'])
        self._fill_group_summary()

    def _fill_tree(self, rows):
        self._entities_by_id={e['id']:e for e in self.result.get('entityTree',[])}
        self.tree.clear()
        flt = self.search.text().strip().lower()
        for g in GROUP_ORDER:
            grows = [r for r in rows if r['group'] == g and (r['dev'] or r['ifc'])
                     and (not flt or flt in r['template'].lower())]
            if not grows:
                continue
            gd, gi = sum(r['dev'] for r in grows), sum(r['ifc'] for r in grows)
            root = QTreeWidgetItem([g,fmt(gd+gi)])
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
                cit = QTreeWidgetItem([cat,fmt(cd+ci)])
                cit.setToolTip(0, '目录口径：%s' % cat)
                root.addChild(cit)
                # All secondary cabinet name templates share the category level.
                # Functional subtypes remain classification evidence in the panel.
                if g == E.G_DEV and all(r.get('code') == 'E17' for r in crows):
                    self._add_templates(cit, crows)
                    continue
                # Model name → name template → entity. Empty subtypes add no level.
                subs = {}
                for r in crows:
                    key = (r.get('std_sub') or r['sub']) if g == E.G_DEV else r['sub']
                    subs.setdefault(key, []).append(r)
                for sub in sorted(subs, key=lambda s: self._sub_key(subs[s], s)):
                    srows = subs[sub]
                    parent = cit
                    if sub:
                        sd, si = sum(r['dev'] for r in srows), sum(r['ifc'] for r in srows)
                        parent = QTreeWidgetItem([sub,fmt(sd+si)])
                        cit.addChild(parent)
                    self._add_templates(parent, srows)
        if flt:
            self.tree.expandAll()

    def _cat_key(self,g,cat,crows):
        return (crows[0].get('catalogOrder',999),cat)

    def _sub_key(self,srows,sub):
        return (srows[0].get('modelOrder',999),sub)

    def _add_templates(self, parent_item, rows):
        rows = sorted(rows, key=lambda r: (r.get('modelOrder',999),r['template']))
        for r in rows:
            same=r['template'] in (r['cat'],parent_item.text(0))
            if same:it=parent_item
            else:
                it=QTreeWidgetItem([r['template'] or '—',fmt(r['total'])])
                it.setData(0,Qt.UserRole,r);parent_item.addChild(it)
            entities=self._entities_by_id
            for entity_id in r.get('entityIds',[]):
                entity=entities.get(entity_id)
                if not entity or entity['pending']:continue
                sample=next((s for s in r['samples'] if len(s)>5 and s[5]==entity_id),None)
                instance=QTreeWidgetItem([entity['name'],'1'])
                instance.setData(0,Qt.UserRole,{**r,'samples':[sample] if sample else [],'entityId':entity_id,'nodeKind':'entity','total':1,'dev':int(bool(sample) and sample[0]=='dev'),'ifc':int(bool(sample) and sample[0]=='ifc')});it.addChild(instance)

    def _fill_group_summary(self):
        """默认选中第一个组，展示组内 top 模板。"""
        it = self.tree.topLevelItem(0)
        if it:
            self.tree.setCurrentItem(it)

    def _on_tree_sel(self):
        items = self.tree.selectedItems()
        if not items:
            self._fill_table([])
            return
        it = items[0]
        r = it.data(0, Qt.UserRole)
        if r:
            self._fill_table([(s, r) for s in r['samples']], select_entity=r.get('nodeKind')=='entity')
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

    def _collect_templates(self,it,out):
        row=it.data(0,Qt.UserRole)
        if row:
            out.append((row['total'],row));return
        for i in range(it.childCount()):self._collect_templates(it.child(i),out)

    def _fill_table(self, pairs, select_entity=False):
        """Groups list entities; only an entity selection opens its properties."""
        blocked = self.table.blockSignals(True)
        self.table.clearSelection()
        self.table.setCurrentCell(-1, -1)
        self._table_pairs = pairs
        self.table.setRowCount(len(pairs))
        for i, (s, _r) in enumerate(pairs):
            name = s[1]
            stt = s[4] if len(s) > 4 else ''
            self.table.setItem(i, 0, QTableWidgetItem(name))
            it = QTableWidgetItem({'已确认':'已识别','候选':'待确认','未确认':'未识别'}.get(stt,stt))
            if stt == E.S.ST_OK:
                it.setForeground(QColor('#1f7a3d'))
            elif stt == E.S.ST_CAND:
                it.setForeground(QColor('#a06800'))
            elif stt == E.S.ST_UNC:
                it.setForeground(QColor('#9aa3ad'))
            self.table.setItem(i, 1, it)
            paths=self._source_files(s,_r)
            source_item=QTableWidgetItem(f'{len(paths)} 个文件')
            source_item.setToolTip('双击实体查看来源文件')
            self.table.setItem(i, 2, source_item)
        self.table.blockSignals(blocked)
        if pairs and select_entity:
            self.table.selectRow(0)
            # Replacing row 0 can retain the previous selection without a Qt
            # selection signal. Refresh the panel with the new row's data.
            self._on_sample_sel()
        else:
            self.prop.setHtml(self._prop_placeholder())

    # ---------- 过滤 ----------
    def _apply_filter(self):
        if self.result:
            self._fill_tree(self.result['rows'])

    # ---------- 状态栏：四组盘点数（原左栏总览） ----------
    def _kpi_html(self,r):
        totals=r['totals']
        return ' · '.join(f'{label} <b>{fmt(totals[group]["台数"] if group==E.G_DEV else totals[group]["dev"]+totals[group]["ifc"])}</b> {unit}'
            for group,label,unit in [(E.G_DEV,'设备','台'),(E.G_MAT,'材料','件'),(E.G_STR,'构件','件'),(E.G_OTH,'其他','项')])

    def _kpi_tip(self,r):
        return '对象数量按设备、材料、构件和其他分类汇总；部件不重复计为设备。'

    # ---------- 左侧属性面板 ----------
    def _prop_placeholder(self):
        return '<div style="padding:12px 14px;color:#5b6472">选择对象查看名称、分类和设备部件；双击实体查看来源文件。</div>'

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

    def _prop_html(self,s,r):
        name=s[1];entity=self._entities_by_id.get(s[5]) if len(s)>5 else None
        h=['<div style="padding:10px 12px;font-size:12px"><b>对象属性</b>']
        rows=[('名称',escape(name or '未命名'))]
        rows.append(('分类',escape(' / '.join(dict.fromkeys(v for v in [r.get('group'),r.get('cat'),r.get('sub')] if v)))))
        status=s[4] if len(s)>4 else ''
        if status and status!='已确认':rows.append(('状态','待确认'))
        h.append(self._prop_block('基本信息',rows))
        if entity:
            names=list(dict.fromkeys(p['componentLabel'] if p['componentLabel']!='未识别部件' else p['name'] or '未命名部件'
                for p in entity['parts'] if p['interpretation']['meaning'] in ('part','neutral_set')))
            h.append('<div style="color:#7b8899;margin-top:12px">部件</div>')
            h.append('<ul>'+''.join('<li>'+escape(n)+'</li>' for n in names)+'</ul>' if names else '<p>未提供部件信息</p>')
        h.append('</div>');return ''.join(h)

    def _source_files(self,s,r):
        entity=self._entities_by_id.get(s[5]) if len(s)>5 else None
        if not entity:return E.source_file_paths(s[2].split('; '))
        return E.source_file_paths(p['source'] for p in entity['parts'])

    def _show_source_files(self,s,r):
        paths=self._source_files(s,r)
        dialog=QDialog(self);dialog.setWindowTitle('来源文件 · '+(s[1] or '未命名'))
        dialog.resize(900,480)
        layout=QVBoxLayout(dialog)
        title=QLabel(s[1] or '未命名');title.setTextFormat(Qt.PlainText);layout.addWidget(title)
        content=QPlainTextEdit();content.setReadOnly(True);content.setLineWrapMode(QPlainTextEdit.NoWrap)
        content.setPlainText('\n'.join(paths));layout.addWidget(content)
        buttons=QDialogButtonBox(QDialogButtonBox.Close)
        buttons.button(QDialogButtonBox.Close).setText('关闭')
        copy=QPushButton('复制全部');buttons.addButton(copy,QDialogButtonBox.ActionRole)
        copy.clicked.connect(lambda:QApplication.clipboard().setText(content.toPlainText()))
        buttons.rejected.connect(dialog.reject);layout.addWidget(buttons)
        dialog.exec()

    def _on_entity_double_clicked(self,row,_column):
        sample,record=self._table_pairs[row];self._show_source_files(sample,record)

    def _on_tree_double_clicked(self,item,_column):
        record=item.data(0,Qt.UserRole)
        if record and record.get('nodeKind')=='entity' and record['samples']:
            self._show_source_files(record['samples'][0],record)
        else:item.setExpanded(not item.isExpanded())

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
        QMessageBox.about(self,'关于',f'<h3>{APP_NAME}</h3><p>版本 {APP_VER}</p><p>按实体目录组织设备、材料、构件及实际部件。</p>')

    def help_dialog(self):
        QMessageBox.information(self,'使用说明',"""
Ctrl+O 打开 .gim 或解包目录，也可拖入窗口。
右侧目录：设备/材料/构件 → 类别 → 模型名称（有时省略）→ 名称模板 → 实体。
二次屏柜下按各类柜子的名称模板平级排列。空子类不生成“本体”占位层。
点击实体或下方实例，左侧显示名称、分类和部件；分类/模板行只列实例。
部件只在左侧显示，不重复计为设备。归属未确认的集合保留在 JSON 导出中。
双击实体查看全部来源文件，每行一个文件，可选择或复制全部。
来源层级与工程身份、用途及目录投影分别表达；不因目录改变几何。
目录使用随工具附带的分类数据，导出的清册包含目录编号。
Ctrl+E 导出 HTML，另支持 CSV / JSON。工具运行和打包只使用自身数据。
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
                counts={'entities':0,'entitiesWithChildren':0,'componentRows':0,'bodyPlaceholders':0}
                stack=[w.tree.topLevelItem(i) for i in range(w.tree.topLevelItemCount())]
                while stack:
                    node=stack.pop();record=node.data(0,Qt.UserRole) or {}
                    if record.get('nodeKind')=='entity':
                        counts['entities']+=1;counts['entitiesWithChildren']+=int(node.childCount()>0)
                    counts['componentRows']+=int(record.get('nodeKind')=='source')
                    counts['bodyPlaceholders']+=int(node.text(0)=='（本体）')
                    stack.extend(node.child(i) for i in range(node.childCount()))
                with open(outpng + '.json', 'w', encoding='utf-8') as receipt:
                    json.dump({'frozen': bool(getattr(sys, 'frozen', False)),
                               'groups': [w.tree.topLevelItem(i).text(0).strip() for i in range(w.tree.topLevelItemCount())],
                               'tree':counts,'pendingWholes':w.result['stats']['待归整体'],
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
