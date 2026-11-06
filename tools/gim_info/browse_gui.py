# -*- coding: utf-8 -*-
"""browse_gui —— GIM 文件信息浏览器（PySide6）

极简四件事：**列文件 → 看键值 → 点指针跳过去 → 退回来**。
不做实体识别、不做业务树、不做 IFC 解析（那些在 gim_element / 05-模型树）。

界面
    左：引用链树（f1→f2→f3→f4→partindex，懒加载但每个 cbm 都可展开）
    右上：内容区（KV 文件显示「键 / 值」；XML 按「元素 / @属性 · 值」结构展开；
          其它文本按「行 / 文本」显示；二进制显示十六进制预览；指针值单击跳转）
    右下：反向引用（谁指向本文件，双击跳到来源；打开目录后自动建索引）
    顶：打开目录 / ← 返回 / → 前进 / 根文件 / 视图 / 指针类型 / 路径框 / 搜索 / 重建索引

指针按 `ptr_kinds.PTR_KINDS` 的 **9 种语义类型** 区分：
    值列按类型着色，工具栏「指针类型」可只看一种，「类型谱系…」是简明对照表；
    引用链树第二列、导出 CSV 也都写细分类型名。
cbm 一律在 CBM/ 下，不需要在界面里区分同目录 / 跨目录。
"""
import os
import threading
import time
import traceback

from diag import _log

from gimbrowse import (Index, KIND_NAME, is_pointer_value)
from ptr_kinds import (PTR_KINDS, KIND_ORDER,
                       KIND_NAME as TYPE_NAME, KIND_GROUP, KIND_COLOR,
                       kind_tooltip)

NAME2CODE = {v: k for k, v in TYPE_NAME.items()}

TREE_CAP = 3000          # 单目录一次最多列 3000 个文件，超出用搜索


def choose_pointer_candidate(parent, candidates):
    """No initial selection: only an explicit choice authorizes navigation."""
    from PySide6 import QtWidgets

    dialog = QtWidgets.QDialog(parent)
    dialog.setWindowTitle('多义指针：选择目标文件')
    dialog.resize(640, 300)
    layout = QtWidgets.QVBoxLayout(dialog)
    layout.addWidget(QtWidgets.QLabel('此指针有多个候选，请核对完整路径后选择：'))
    paths = QtWidgets.QListWidget()
    paths.setObjectName('pointer-candidates')
    paths.addItems(list(candidates))
    layout.addWidget(paths)
    buttons = QtWidgets.QDialogButtonBox(
        QtWidgets.QDialogButtonBox.Open | QtWidgets.QDialogButtonBox.Cancel)
    buttons.setObjectName('pointer-candidate-actions')
    open_button = buttons.button(QtWidgets.QDialogButtonBox.Open)
    open_button.setEnabled(False)
    paths.setCurrentRow(-1)
    buttons.button(QtWidgets.QDialogButtonBox.Cancel).setFocus()
    paths.currentRowChanged.connect(lambda row: open_button.setEnabled(row >= 0))
    buttons.accepted.connect(dialog.accept)
    buttons.rejected.connect(dialog.reject)
    paths.itemDoubleClicked.connect(lambda _item: dialog.accept())
    layout.addWidget(buttons)
    if dialog.exec() == QtWidgets.QDialog.Accepted and paths.currentItem():
        return paths.currentItem().text()
    return None


def run_browser(init_dir=None, selftest=False):
    from PySide6 import QtWidgets, QtCore, QtGui

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    app.setApplicationName('GIM 文件浏览器')

    win = QtWidgets.QMainWindow()
    win.setWindowTitle('GIM 文件浏览器 —— 键值 / 指针 / 跳转返回')
    win.resize(1440, 860)

    state = {'ix': None, 'cur': '', 'hist': [], 'pos': -1,
             'building': False, 'loaded_dirs': set(), 'selftest': selftest,
             'view': 'chain', 'path_cache': {}, 'hl': None,
             'attr_mode': 'file', 'targets': {}, 'last_jump': 0.0,
             'last_tgt': '', 'kind_filter': ''}

    # ---------------- 工具栏 ----------------
    tb = QtWidgets.QToolBar()
    tb.setMovable(False)
    win.addToolBar(tb)
    act_open = QtGui.QAction('打开目录…', win)
    tb.addAction(act_open)
    tb.addSeparator()
    act_back = QtGui.QAction('← 返回', win)
    act_back.setShortcut('Alt+Left')
    act_fwd = QtGui.QAction('→ 前进', win)
    act_fwd.setShortcut('Alt+Right')
    act_root = QtGui.QAction('根文件', win)
    for a in (act_back, act_fwd, act_root):
        tb.addAction(a)
    tb.addSeparator()
    tb.addWidget(QtWidgets.QLabel(' 视图 '))
    view_box = QtWidgets.QComboBox()
    view_box.addItems(['引用链（cbm→dev→几何）', '按目录（CBM/DEV/PHM/MOD）'])
    tb.addWidget(view_box)
    tb.addWidget(QtWidgets.QLabel(' 指针 '))
    kind_box = QtWidgets.QComboBox()
    kind_box.setToolTip('按指针类型过滤键值表（文本/二进制文件不参与过滤）')
    kind_box.addItem('全部类型', '')
    for c in KIND_ORDER:
        kind_box.addItem(TYPE_NAME[c], c)
        kind_box.setItemData(kind_box.count() - 1,
                             QtGui.QBrush(QtGui.QColor(KIND_COLOR[c])),
                             QtCore.Qt.ForegroundRole)
    kind_box.setFixedWidth(122)
    tb.addWidget(kind_box)
    act_kinds = QtGui.QAction('类型谱系…', win)
    tb.addAction(act_kinds)
    tb.addSeparator()
    tb.addWidget(QtWidgets.QLabel(' 路径 '))
    path_box = QtWidgets.QComboBox()
    path_box.setEditable(True)
    path_box.setMinimumWidth(250)
    tb.addWidget(path_box)
    tb.addSeparator()
    tb.addWidget(QtWidgets.QLabel(' 搜索 '))
    qbox = QtWidgets.QLineEdit()
    qbox.setPlaceholderText('键或值关键字（回车）')
    qbox.setFixedWidth(140)
    tb.addWidget(qbox)
    tb.addSeparator()
    act_idx = QtGui.QAction('重建索引', win)
    act_idx.setToolTip('打开目录时已自动建立反向索引；这里可重新扫描全部文件')
    tb.addAction(act_idx)
    act_export = QtGui.QAction('导出链清单…', win)
    tb.addAction(act_export)

    # ---------------- 主区 ----------------
    split = QtWidgets.QSplitter()
    win.setCentralWidget(split)

    tree = QtWidgets.QTreeWidget()
    tree.setHeaderLabels(['文件（rel）', '类型', '大小'])
    tree.setColumnWidth(0, 228)
    tree.setColumnWidth(1, 112)
    tree.setColumnWidth(2, 50)
    split.addWidget(tree)

    right = QtWidgets.QWidget()
    rv = QtWidgets.QVBoxLayout(right)
    rv.setContentsMargins(0, 0, 0, 0)
    rv.setSpacing(4)
    head = QtWidgets.QLabel('（未打开文件）')
    head.setTextFormat(QtCore.Qt.RichText)
    head.setWordWrap(True)
    head.setStyleSheet('QLabel{padding:6px 8px;background:#f6f8fb;border-bottom:1px solid #e3e8ef;}')
    rv.addWidget(head)

    vs = QtWidgets.QSplitter(QtCore.Qt.Vertical)
    atv = QtWidgets.QTableWidget(0, 2)
    atv.setHorizontalHeaderLabels(['键', '值'])
    atv.horizontalHeader().setSectionResizeMode(0, QtWidgets.QHeaderView.Interactive)
    atv.horizontalHeader().setSectionResizeMode(1, QtWidgets.QHeaderView.Stretch)
    atv.setColumnWidth(0, 240)
    atv.setEditTriggers(QtWidgets.QAbstractItemView.NoEditTriggers)
    atv.setAlternatingRowColors(True)
    atv.setWordWrap(False)
    vs.addWidget(atv)

    btv = QtWidgets.QTableWidget(0, 3)
    btv.setHorizontalHeaderLabels(['谁指向本文件（来源）', '键', '值'])
    btv.horizontalHeader().setSectionResizeMode(0, QtWidgets.QHeaderView.Stretch)
    btv.horizontalHeader().setSectionResizeMode(1, QtWidgets.QHeaderView.Interactive)
    btv.setColumnWidth(1, 220)
    btv.setColumnWidth(2, 220)
    btv.setEditTriggers(QtWidgets.QAbstractItemView.NoEditTriggers)
    btv.setAlternatingRowColors(True)
    btv.setWordWrap(False)
    vs.addWidget(btv)
    vs.setSizes([520, 220])
    rv.addWidget(vs, 1)
    split.addWidget(right)
    split.setSizes([440, 1000])

    status = QtWidgets.QStatusBar()
    win.setStatusBar(status)
    status.showMessage('打开解包后的 GIM 目录（含 CBM / DEV / PHM / MOD）')

    def attr_mode(mode):
        """内容区：file=键/值；xml=XML 元素/值；text=行/文本；
        binary=偏移/十六进制；search=文件/键/值。"""
        state['attr_mode'] = mode
        state['targets'] = {}
        atv.clearContents()
        atv.setRowCount(0)
        n = 3 if mode == 'search' else 2
        atv.setColumnCount(n)
        labels = {'file': ['键', '值'],
                  'xml': ['XML 元素 / 属性', '值'],
                  'text': ['行', '文本'],
                  'binary': ['偏移', '十六进制 / ASCII'],
                  'search': ['文件', '键', '值']}[mode]
        atv.setHorizontalHeaderLabels(labels)
        hh = atv.horizontalHeader()
        for c in range(n):
            hh.setSectionResizeMode(c, QtWidgets.QHeaderView.Interactive)
        if mode == 'search':
            hh.setSectionResizeMode(0, QtWidgets.QHeaderView.Stretch)
            atv.setColumnWidth(1, 220)
            atv.setColumnWidth(2, 340)
        else:
            hh.setSectionResizeMode(1, QtWidgets.QHeaderView.Stretch)
            atv.setColumnWidth(0, {'file': 240, 'xml': 300}.get(mode, 72))

    # ---------------- 文件树：引用链 / 按目录 ----------------
    rel2item = {}
    LEVEL_TAG = {'F1System': 'F1 工程', 'F2System': 'F2 系统', 'F3System': 'F3 间隔',
                 'F4System': 'F4 设备', 'PARTINDEX': 'L5 部件'}

    def set_headers(view):
        if view == 'chain':
            tree.setHeaderLabels(['引用链（层 · 名称）', '指针类型', '大小'])
            cols = (268, 112, 50)     # 保证第二列在默认左侧宽度内可见
        else:
            tree.setHeaderLabels(['文件（rel）', '类型', '大小'])
            cols = (320, 82, 50)
        for i, w in enumerate(cols):
            tree.setColumnWidth(i, w)

    def fill_tree():
        tree.clear()
        rel2item.clear()
        state['hl'] = None
        state['path_cache'] = {}
        ix = state['ix']
        if ix is None:
            return
        set_headers(state['view'])
        if state['view'] == 'chain':
            fill_chain()
        else:
            fill_dirs()

    def fill_dirs():
        ix = state['ix']
        for low in ('cbm', 'dev', 'phm', 'mod'):
            real = ix.dirs.get(low)
            if not real:
                continue
            n = sum(1 for r in ix.files if r.split('/')[0] == real)
            top = QtWidgets.QTreeWidgetItem(['%s/   %d 个文件' % (real, n), '', ''])
            f = QtGui.QFont()
            f.setBold(True)
            top.setFont(0, f)
            top.setData(0, QtCore.Qt.UserRole, ('dir', real))
            top.setData(0, QtCore.Qt.UserRole + 1, '')      # 未填充
            tree.addTopLevelItem(top)

    # ---- 引用链视图：cbm 的 F1→F2→F3→F4→PARTINDEX + 模型边 + 属性边 ----
    def chain_label(rel):
        ix = state['ix']
        if os.path.basename(rel).lower() == 'project.cbm':
            return '工程  %s' % os.path.basename(rel)
        base = os.path.basename(rel)[:8]
        ext = ix.files[rel].ext
        if ext != 'cbm':
            return '%s  %s' % (ext.upper(), base)      # DEV / FAM / PHM / MOD / STL
        lv = ix.level_name(rel)
        head = LEVEL_TAG.get(lv, lv or 'CBM')
        return '%s  %s' % (head, base)

    def add_chain_child(parent, rel, how, keyname='', exists=True):
        ix = state['ix']
        e = ix.files.get(rel)
        code = NAME2CODE.get(how, '')
        color = KIND_COLOR.get(code, '')
        tip = keyname or ''
        if code:
            tip = (tip + '\n' if tip else '') + kind_tooltip(code)
        if e is None or not exists:
            # 未随包下载的引用：仍按引用链占位，给出期望路径便于继续下载
            it = QtWidgets.QTreeWidgetItem(
                ['待下载  %s' % os.path.basename(rel)[:8], how, '—'])
            it.setToolTip(0, '未下载：%s' % rel)
            it.setToolTip(1, tip)
            it.setForeground(0, QtGui.QBrush(QtGui.QColor('#b3261e')))
            if color:
                it.setForeground(1, QtGui.QBrush(QtGui.QColor(color)))
            it.setChildIndicatorPolicy(
                QtWidgets.QTreeWidgetItem.ChildIndicatorPolicy.DontShowIndicator)
            parent.addChild(it)
            return it
        it = QtWidgets.QTreeWidgetItem([chain_label(rel), how, fmt_size(e.size)])
        it.setToolTip(1, tip)
        if color:
            it.setForeground(1, QtGui.QBrush(QtGui.QColor(color)))
        it.setData(0, QtCore.Qt.UserRole, ('file', rel))
        it.setData(0, QtCore.Qt.UserRole + 1, 'chain')
        # 懒加载节点必须先给展开箭头，否则看起来像叶子，链就「只能到 F2」
        if e.ext in ('cbm', 'dev', 'phm'):
            it.setChildIndicatorPolicy(
                QtWidgets.QTreeWidgetItem.ChildIndicatorPolicy.ShowIndicator)
        if e.ext == 'fam':
            it.setForeground(0, QtGui.QBrush(QtGui.QColor('#8a6d3b')))
        elif e.ext in ('mod', 'stl'):
            it.setForeground(0, QtGui.QBrush(QtGui.QColor('#57606a')))
        parent.addChild(it)
        rel2item.setdefault(rel, it)
        return it

    def populate_chain(item):
        """展开一个链节点：列出全部出边（层级 / 模型 / 几何 / 属性），含未下载的。"""
        if item.data(0, QtCore.Qt.UserRole + 2) == 'filled':
            return
        item.setData(0, QtCore.Qt.UserRole + 2, 'filled')
        data = item.data(0, QtCore.Qt.UserRole)
        if not data or data[0] != 'file':
            return
        rel = data[1]
        ix = state['ix']
        pointers = {p.key: p for p in ix.pointers(rel)}
        for how, key, tgt, ok in ix.edges(rel):
            pointer = pointers.get(key)
            if pointer and pointer.status == 'ambiguous':
                child = QtWidgets.QTreeWidgetItem(['多义：%s' % key, how,
                                                  '%d 候选' % len(pointer.candidates)])
                child.setData(0, QtCore.Qt.UserRole, ('ambiguous', pointer.candidates, rel))
                child.setToolTip(0, '双击后选择目标；未确定归属\n' + '\n'.join(pointer.candidates))
                child.setForeground(0, QtGui.QBrush(QtGui.QColor('#a66300')))
                item.addChild(child)
            else:
                add_chain_child(item, tgt, how, key, ok)
        if item.childCount() == 0:
            item.setChildIndicatorPolicy(
                QtWidgets.QTreeWidgetItem.ChildIndicatorPolicy.DontShowIndicator)

    def fill_chain():
        ix = state['ix']
        root = ix._root_cbm()
        if not root:
            return
        it = QtWidgets.QTreeWidgetItem([chain_label(root), '根', fmt_size(ix.files[root].size)])
        it.setData(0, QtCore.Qt.UserRole, ('file', root))
        it.setData(0, QtCore.Qt.UserRole + 1, 'chain')
        it.setChildIndicatorPolicy(
            QtWidgets.QTreeWidgetItem.ChildIndicatorPolicy.ShowIndicator)
        f = QtGui.QFont()
        f.setBold(True)
        it.setFont(0, f)
        tree.addTopLevelItem(it)
        rel2item[root] = it
        populate_chain(it)
        it.setExpanded(True)
        # 沿主链 project → F1 → F2 → F3 → F4 → PARTINDEX 展开一条完整示范链
        # （只展开一条路径，不建上万节点；其余分支仍按需点开）
        for p in [r for r, _n, _k in ix.chain()][:7]:
            it2 = rel2item.get(p)
            if it2 is None:
                break
            populate_chain(it2)
            it2.setExpanded(True)
        # 孤立 cbm（没被任何父引用的）单列，避免漏文件
        if ix.built:
            pointed = {p.target for ptrs in ix.refs.values() for p in ptrs}
            orph = [r for r in ix.files
                    if r.lower().endswith('.cbm') and r not in pointed and r != root]
            if orph:
                top = QtWidgets.QTreeWidgetItem(
                    ['未被引用的 cbm   %d 个' % len(orph), '', ''])
                top.setData(0, QtCore.Qt.UserRole, ('dir', 'orphan'))
                tree.addTopLevelItem(top)

    def find_chain_path(rel, budget=1.2, max_nodes=6000):
        """从根找一条到 rel 的引用路径（用于定位）；找不到返回 []。

        建过索引就沿反向引用向上回溯（O(链深)）；否则从根 BFS，但严格限时/限节点，
        避免为了高亮一个文件把 3.6 万个文件全读一遍造成「点了没反应」。
        """
        ix = state['ix']
        root = ix._root_cbm()
        if not root:
            return []
        cache = state.setdefault('path_cache', {})
        if rel in cache:
            return cache[rel]
        if ix.built:
            chain, cur, guard = [rel], rel, 0
            while cur != root and guard < 32:
                srcs = [s for s, _p in ix.back_refs(cur) if s != cur]
                if not srcs:
                    break
                cur = srcs[0]
                chain.append(cur)
                guard += 1
            if cur == root:
                chain.reverse()
                cache[rel] = chain
                return chain
        import collections as _c
        t0 = time.time()
        prev = {root: None}
        q = _c.deque([root])
        visited = 0
        while q and time.time() - t0 < budget and visited < max_nodes:
            cur = q.popleft()
            visited += 1
            if cur == rel:
                path = []
                while cur:
                    path.append(cur)
                    cur = prev[cur]
                path.reverse()
                cache[rel] = path
                return path
            for _h, _k, t, ok in ix.edges(cur):
                if ok and t not in prev:
                    prev[t] = cur
                    q.append(t)
        cache[rel] = []
        return []

    def locate_chain(rel, src=None):
        item = rel2item.get(rel)
        if item is None and src:
            # 刚从 src 的某个指针跳过来：直接展开来源节点即可找到目标，
            # 不必从根 BFS（而且新边已覆盖 BASEFAMILYn / IFCFILE 等全部指针）。
            it0 = rel2item.get(src)
            if it0 is not None:
                populate_chain(it0)
                it0.setExpanded(True)
                item = rel2item.get(rel)
        if item is None:
            path = find_chain_path(rel)
            for p in path:
                it2 = rel2item.get(p)
                if it2 is None:
                    break
                populate_chain(it2)
                it2.setExpanded(True)
            item = rel2item.get(rel)
        if item is None:
            return
        prev = state.get('hl')
        if prev is not None:
            try:
                prev.setBackground(0, QtGui.QBrush())
            except RuntimeError:
                pass
        tree.setCurrentItem(item)
        item.setBackground(0, QtGui.QBrush(QtGui.QColor('#e8f1f8')))
        state['hl'] = item
        tree.scrollToItem(item, QtWidgets.QAbstractItemView.PositionAtCenter)

    def fill_dir(top):
        """展开目录时才建子项（CBM 上万项，一次性建会卡）。"""
        if top.data(0, QtCore.Qt.UserRole + 1) == 'filled':
            return
        top.setData(0, QtCore.Qt.UserRole + 1, 'filled')
        ix = state['ix']
        real = top.data(0, QtCore.Qt.UserRole)[1]
        rels = [r for r in ix.files if r.split('/')[0] == real]
        rels.sort(key=lambda r: os.path.basename(r).lower())
        more = 0
        if len(rels) > TREE_CAP:
            more = len(rels) - TREE_CAP
            rels = rels[:TREE_CAP]
        for r in rels:
            e = ix.files[r]
            it = QtWidgets.QTreeWidgetItem([e.name, KIND_NAME.get(e.ext, e.ext), fmt_size(e.size)])
            it.setData(0, QtCore.Qt.UserRole, ('file', r))
            it.setToolTip(0, r)
            if r.lower().endswith('.fam'):
                it.setForeground(0, QtGui.QBrush(QtGui.QColor('#8a6d3b')))
            top.addChild(it)
            rel2item[r] = it
        if more:
            top.addChild(QtWidgets.QTreeWidgetItem(
                ['…仅列前 %d 个，剩下 %d 个请用搜索定位' % (TREE_CAP, more), '', '']))

    def locate_current(rel, src=None):
        if state['view'] == 'chain':
            locate_chain(rel, src)
        else:
            locate(rel)

    def locate(rel):
        """把当前文件在左树里选中（必要时展开所在目录）。"""
        prev = state.get('hl')
        if prev is not None:
            try:
                prev.setBackground(0, QtGui.QBrush())
            except RuntimeError:
                pass
        d = rel.split('/')[0]
        for i in range(tree.topLevelItemCount()):
            top = tree.topLevelItem(i)
            data = top.data(0, QtCore.Qt.UserRole)
            if data and data[0] == 'dir' and data[1] == d:
                fill_dir(top)
                top.setExpanded(True)
                it = rel2item.get(rel)
                if it:
                    tree.setCurrentItem(it)
                    it.setBackground(0, QtGui.QBrush(QtGui.QColor('#e8f1f8')))
                    state['hl'] = it
                    tree.scrollToItem(it, QtWidgets.QAbstractItemView.PositionAtCenter)
                    # 展开后再滚一次，否则位置按旧布局算
                    QtCore.QTimer.singleShot(
                        0, lambda i=it: tree.scrollToItem(
                            i, QtWidgets.QAbstractItemView.PositionAtCenter))
                return

    def on_tree_expand(it):
        data = it.data(0, QtCore.Qt.UserRole)
        if not data:
            return
        if data[0] == 'dir':
            fill_dir(it)
        elif data[0] == 'file' and state['view'] == 'chain':
            populate_chain(it)
    tree.itemExpanded.connect(on_tree_expand)

    def fmt_size(n):
        if n < 1024:
            return '%d B' % n
        if n < 1024 * 1024:
            return '%.1f KB' % (n / 1024)
        return '%.1f MB' % (n / 1048576)

    # ---------------- 打开文件 = 一次跳转 ----------------
    def open_rel(rel, push=True, src=None):
        ix = state['ix']
        if not ix or rel not in ix.files:
            return
        if push:
            state['hist'] = state['hist'][:state['pos'] + 1]
            if not state['hist'] or state['hist'][-1] != rel:
                state['hist'].append(rel)
            state['pos'] = len(state['hist']) - 1
        state['cur'] = rel
        show_file(rel, src)
        update_nav()

    def show_file(rel, src=None):
        ix = state['ix']
        e = ix.files[rel]
        c = ix.content(rel)                  # kv / text / binary / empty
        mode = c['mode']
        kv = c['kv']
        ptrs = {p.key: p for p in ix.pointers(rel)}
        marks = {k: (v, code) for k, v, code in ix.markers(rel)}
        kstats = ix.kind_stats(rel)
        for _k, _v, code in ix.markers(rel):
            kstats[code] += 1
        note = {'text': '（文本文件，按行显示）',
                'xml': '（按 XML 结构解析）',
                'binary': '（二进制文件，显示前 256 字节）'}.get(mode, '')
        if mode == 'kv':
            count = '%d 键' % len(kv)
        elif mode == 'xml':
            count = '%d 元素 · %d 属性' % (c.get('elements', 0),
                                        c.get('attrs', 0))
        elif mode == 'text':
            count = ('前 1 MB / %d 行' % c['total']) if c['truncated'] \
                else ('%d 行' % c['total'])
        elif mode == 'binary':
            count = '前 256 字节 / %d 行' % c['total']
        else:
            count = '空文件'
        badges = ''
        for code in KIND_ORDER:
            n = kstats.get(code, 0)
            if n:
                badges += ('<span style="color:%s">● %s %d</span>　'
                           % (KIND_COLOR[code], TYPE_NAME[code], n))
        head.setText(
            '<b>%s</b>　<span style="color:#5c6b7f">%s · %s · %s · %s%s</span>'
            '<br><span style="color:#5c6b7f">指针类型：</span>%s'
            % (escape(rel), KIND_NAME.get(e.ext, e.ext), fmt_size(e.size), count,
               time.strftime('%Y-%m-%d %H:%M', time.localtime(
                   os.path.getmtime(ix.path_of(rel)))), note,
               badges or '<span style="color:#5c6b7f">（本文件没有指针）</span>'))
        # 先更新路径/状态，跳转立刻可见；树的定位放最后且严格限时
        path_box.setEditText(rel)
        status.showMessage('%s ｜ %s · %d 指针 · %d 标识键 · 历史 %d/%d'
                           % (rel, count, len(ptrs), len(marks),
                              state['pos'] + 1, len(state['hist'])))
        if mode in ('text', 'binary', 'xml'):
            # XML：元素层级 + @属性；其它非 KV 文本按行显示原文；
            # 二进制给十六进制预览。都不再是一片空白的「（无键值）」。
            attr_mode(mode)
            lines = c['lines']
            extra = 1 if c['truncated'] else 0
            atv.setRowCount(max(len(lines) + extra, 1))
            mono = QtGui.QFont('Consolas')
            mono.setPointSize(9)
            targets = {}
            for i, (label, line) in enumerate(lines):
                a = QtWidgets.QTableWidgetItem(label)
                # 一行几万字符的值（StretchedBody Array / SVG script）只放摘要
                shown = (line if len(line) <= 800 else
                         line[:800] + ' …（本行共 %d 字符）' % len(line))
                b = QtWidgets.QTableWidgetItem(shown)
                b.setFont(mono)
                b.setToolTip(line[:4000])
                if mode == 'xml':
                    if label.lstrip().startswith('<'):
                        fnt = QtGui.QFont()
                        fnt.setBold(True)
                        a.setFont(fnt)
                        a.setForeground(QtGui.QBrush(QtGui.QColor('#1a5fb4')))
                    else:
                        a.setForeground(QtGui.QBrush(QtGui.QColor('#6b7684')))
                    # XML 属性值本身也可能是指针，仍按单击跳转处理
                    if is_pointer_value(line):
                        resolution = ix.resolve(rel, line)
                        tgt, st = resolution
                        if st == 'ambiguous' or st in ('ok', 'cross') and tgt in ix.files:
                            link = QtGui.QFont(mono)
                            link.setUnderline(True)
                            b.setFont(link)
                            b.setForeground(QtGui.QBrush(QtGui.QColor('#1a5fb4')))
                            destination = resolution.candidates if st == 'ambiguous' else tgt
                            b.setToolTip('单击选择目标（多义）\n' + '\n'.join(resolution.candidates)
                                         if st == 'ambiguous' else '单击跳到 %s' % tgt)
                            b.setData(QtCore.Qt.UserRole, destination)
                            targets[i] = destination
                else:
                    a.setForeground(QtGui.QBrush(QtGui.QColor('#6b7684')))
                atv.setItem(i, 0, a)
                atv.setItem(i, 1, b)
            row = len(lines)
            if not lines:
                tip = {'text': '文件为空', 'binary': '二进制文件为空',
                       'xml': 'XML 文件为空'}.get(mode, '文件为空')
                a, b = QtWidgets.QTableWidgetItem('（空）'), QtWidgets.QTableWidgetItem(tip)
                row = 0
            elif c['truncated']:
                if mode == 'xml':
                    tip = ('只显示前 %d 行（元素/属性过多），完整内容请用外部编辑器打开'
                           % len(lines))
                else:
                    tip = ('只显示前 %d 行（编码 %s），完整内容请用外部编辑器打开'
                           % (len(lines), c['encoding'] or '自动'))
                a, b = QtWidgets.QTableWidgetItem('…'), QtWidgets.QTableWidgetItem(tip)
            else:
                a = b = None
            if a is not None:
                for it in (a, b):
                    it.setForeground(QtGui.QBrush(QtGui.QColor('#6b7684')))
                atv.setItem(row, 0, a)
                atv.setItem(row, 1, b)
            state['targets'] = targets
        else:
            attr_mode('file')
            flt = state['kind_filter']
            rows = [(k, v) for k, v in kv.items()
                    if not flt or (k in ptrs and ptrs[k].kind == flt)
                    or (k in marks and marks[k][1] == flt)]
            atv.setRowCount(len(rows) or 1)
            targets = {}
            if not rows:
                why = (('只显示「%s」，本文件没有这一类指针' % TYPE_NAME[flt])
                       if flt else
                       '（空文件 / 占位属性文件，本身没有键值；跳到这里是跳转成功）')
                a = QtWidgets.QTableWidgetItem('（无键值）' if not flt else '（无匹配）')
                b = QtWidgets.QTableWidgetItem(why)
                for it in (a, b):
                    it.setForeground(QtGui.QBrush(QtGui.QColor('#6b7684')))
                atv.setItem(0, 0, a)
                atv.setItem(0, 1, b)
            for i, (k, v) in enumerate(rows):
                ki = QtWidgets.QTableWidgetItem(k)
                vi = QtWidgets.QTableWidgetItem(str(v))
                p = ptrs.get(k)
                if p is not None:
                    col = QtGui.QColor(KIND_COLOR.get(p.kind, '#1a5fb4'))
                    ki.setToolTip(kind_tooltip(p.kind))
                    if p.status == 'ambiguous':
                        vi.setForeground(QtGui.QBrush(QtGui.QColor('#a66300')))
                        vi.setToolTip('多义指针，单击选择目标；未确定归属\n' + '\n'.join(p.candidates))
                        vi.setData(QtCore.Qt.UserRole, p.candidates)
                        targets[i] = p.candidates
                    elif p.status == 'missing' or p.target not in ix.files:
                        # 文件未随包下载：红色，tooltip 给出应取的准确路径
                        vi.setForeground(QtGui.QBrush(QtGui.QColor('#b3261e')))
                        vi.setToolTip('%s\n未下载，按引用链应取：%s'
                                      % (kind_tooltip(p.kind), p.target))
                    else:
                        # 值列本身就是链接：按类型着色 + 下划线，单击即跳
                        fnt = QtGui.QFont()
                        fnt.setUnderline(True)
                        vi.setFont(fnt)
                        vi.setForeground(QtGui.QBrush(col))
                        vi.setToolTip('%s\n单击跳到 %s'
                                      % (kind_tooltip(p.kind), p.target))
                        vi.setData(QtCore.Qt.UserRole, p.target)
                        targets[i] = p.target
                    ki.setForeground(QtGui.QBrush(col))
                elif k in marks:
                    # IFCGUID / MATERIALSHEET / FILEn.NAME：标识或占位，不是链接
                    code = marks[k][1]
                    col = QtGui.QColor(KIND_COLOR.get(code, '#6b7684'))
                    ki.setForeground(QtGui.QBrush(col))
                    vi.setForeground(QtGui.QBrush(col))
                    for it in (ki, vi):
                        it.setToolTip('【标识/占位键 · 不跳转】\n'
                                      + kind_tooltip(code))
                atv.setItem(i, 0, ki)
                atv.setItem(i, 1, vi)
            state['targets'] = targets
        show_back(rel)
        locate_current(rel, src)

    def show_back(rel):
        ix = state['ix']
        if not ix.built:
            btv.setRowCount(1)
            btv.setItem(0, 0, QtWidgets.QTableWidgetItem(
                state.get('index_msg') or
                ('正在建立索引…' if state['building'] else '索引未建立')))
            for cidx in (1, 2):
                btv.setItem(0, cidx, QtWidgets.QTableWidgetItem(''))
            return
        refs = ix.back_refs(rel) + ix.possible_back_refs(rel)
        btv.setRowCount(len(refs) or 1)
        if not refs:
            btv.setItem(0, 0, QtWidgets.QTableWidgetItem('（没有文件指向它）'))
            btv.setItem(0, 1, QtWidgets.QTableWidgetItem(''))
            btv.setItem(0, 2, QtWidgets.QTableWidgetItem(''))
            return
        for i, (src, p) in enumerate(refs):
            a = QtWidgets.QTableWidgetItem(src + ('（多义候选，未确认）' if p.status == 'ambiguous' else ''))
            b = QtWidgets.QTableWidgetItem(p.key)
            c = QtWidgets.QTableWidgetItem(str(p.value))
            b.setToolTip(kind_tooltip(p.kind))
            c.setForeground(QtGui.QBrush(QtGui.QColor(KIND_COLOR.get(p.kind, '#333333'))))
            fnt = QtGui.QFont()
            fnt.setUnderline(True)
            a.setFont(fnt)
            a.setForeground(QtGui.QBrush(QtGui.QColor('#1a5fb4')))
            for it in (a, b, c):
                btv.setItem(i, 0 if it is a else (1 if it is b else 2), it)
            a.setData(QtCore.Qt.UserRole, src)

    def update_nav():
        act_back.setEnabled(state['pos'] > 0)
        act_fwd.setEnabled(state['pos'] + 1 < len(state['hist']))
        path_box.clear()
        path_box.addItems(state['hist'][-40:])
        path_box.setEditText(state['cur'])

    # ---------------- 导航 ----------------
    def go_back():
        if state['pos'] > 0:
            state['pos'] -= 1
            open_rel(state['hist'][state['pos']], push=False)

    def go_fwd():
        if state['pos'] + 1 < len(state['hist']):
            state['pos'] += 1
            open_rel(state['hist'][state['pos']], push=False)

    def go_root():
        ix = state['ix']
        if ix:
            r = ix._root_cbm()
            if r:
                open_rel(r)

    act_back.triggered.connect(go_back)
    act_fwd.triggered.connect(go_fwd)
    act_root.triggered.connect(go_root)
    path_box.activated.connect(lambda i: open_rel(path_box.itemText(i)))

    # ---------------- 表格交互 ----------------
    def jump(tgt, src=None):
        """值列链接统一入口。

        只屏蔽「同一目标」在 0.2s 内的重复触发（双击的第二下），
        不再用全局时间锁——那会把用户紧接着点的下一个指针也吃掉。
        """
        if isinstance(tgt, (tuple, list)):
            ix = state['ix']
            tgt = choose_pointer_candidate(win, tgt)
            if not tgt or state['ix'] is not ix:
                return
        now = time.time()
        if tgt == state['last_tgt'] and now - state['last_jump'] < 0.2:
            return
        state['last_tgt'] = tgt
        state['last_jump'] = now
        open_rel(tgt, src=src)

    def on_attr_click(row, col):
        if state['attr_mode'] not in ('file', 'xml') or col != 1:
            return
        tgt = state['targets'].get(row)
        if tgt:
            jump(tgt, state['cur'])

    def atv_activated(row, col):
        # 搜索结果：双击「文件」列跳过去
        if state['attr_mode'] == 'search' and col == 0:
            it = atv.item(row, 0)
            rel = it.data(QtCore.Qt.UserRole) if it else None
            if rel:
                open_rel(rel)

    def btv_activated(row, col):
        it = btv.item(row, 0)
        if it is None:
            return
        src = it.data(QtCore.Qt.UserRole)
        if src:
            open_rel(src)

    def tree_activated(item, col):
        data = item.data(0, QtCore.Qt.UserRole)
        if data and data[0] == 'file':
            open_rel(data[1])
        elif data and data[0] == 'ambiguous':
            jump(data[1], data[2])

    atv.cellClicked.connect(on_attr_click)
    atv.cellDoubleClicked.connect(atv_activated)
    btv.cellDoubleClicked.connect(btv_activated)
    tree.itemDoubleClicked.connect(tree_activated)

    # ---------------- 搜索 ----------------
    def do_search():
        ix = state['ix']
        q = qbox.text().strip()
        if not ix or not q:
            return
        hits = ix.search(q, limit=300)
        attr_mode('search')
        atv.setRowCount(len(hits))
        for i, (rel, k, v) in enumerate(hits):
            a = QtWidgets.QTableWidgetItem('%s' % rel)
            b = QtWidgets.QTableWidgetItem(k)
            c = QtWidgets.QTableWidgetItem(str(v))
            fnt = QtGui.QFont()
            fnt.setUnderline(True)
            a.setFont(fnt)
            a.setForeground(QtGui.QBrush(QtGui.QColor('#1a5fb4')))
            a.setData(QtCore.Qt.UserRole, rel)
            atv.setItem(i, 0, a)
            atv.setItem(i, 1, b)
            atv.setItem(i, 2, c)
        head.setText('<b>搜索：%s</b>　<span style="color:#5c6b7f">%d 条命中（双击文件名跳转）</span>'
                     % (escape(q), len(hits)))
        status.showMessage('搜索「%s」：%d 条' % (q, len(hits)))

    qbox.returnPressed.connect(do_search)

    # ---------------- 打开目录 ----------------
    def pick_dir():
        d = QtWidgets.QFileDialog.getExistingDirectory(
            win, '选择解包后的 GIM 目录（含 CBM/DEV/PHM/MOD）', init_dir or os.getcwd())
        if d:
            load(d)

    act_open.triggered.connect(pick_dir)

    def load(root):
        t0 = time.time()
        try:
            ix = Index(root)
        except Exception:
            QtWidgets.QMessageBox.critical(win, '打开失败', traceback.format_exc()[-2000:])
            return
        if not ix.files:
            QtWidgets.QMessageBox.warning(
                win, '没有模型文件',
                '所选目录里没有 CBM / DEV / PHM / MOD 文件。\n请选 GIM 解包目录。')
            return
        state['ix'] = ix
        state['hist'] = []
        state['pos'] = -1
        state['cur'] = ''
        fill_tree()
        st = ix.stat()
        status.showMessage('%s ｜ %s ｜ 文件 %d（%.1fs）· 双击文件开始浏览'
                           % (root, ' · '.join('%s %d' % kv2 for kv2 in sorted(st.items())),
                              len(ix.files), time.time() - t0))
        win.setWindowTitle('GIM 文件浏览器 —— %s' % os.path.basename(root.rstrip('\\/')))
        state['index_msg'] = ''
        go_root()
        # 反向引用不再需要手动点按钮：打开目录后自动在后台建索引
        QtCore.QTimer.singleShot(60, build_index)

    # ---------------- 建索引（后台，打开目录即自动执行） ----------------
    def build_index():
        ix = state['ix']
        if not ix or state['building']:
            return
        state['building'] = True
        act_idx.setEnabled(False)
        box = {'st': None, 'msg': '', 'done': False}

        def work():
            try:
                box['st'] = ix.build_refs(lambda m: box.__setitem__('msg', m))
            except Exception:
                box['msg'] = '索引失败：' + traceback.format_exc()[-300:]
            box['done'] = True

        threading.Thread(target=work, daemon=True).start()

        def poll():
            if box['msg']:
                msg = box['msg']
                box['msg'] = ''
                state['index_msg'] = msg
                status.showMessage(msg)
                # 反向引用面板同步显示进度，而不是一直停在「索引未建立」
                if state['attr_mode'] != 'search' and btv.rowCount() == 1:
                    it0 = btv.item(0, 0)
                    if it0 is not None:
                        it0.setText(msg)
            if not box['done']:
                QtCore.QTimer.singleShot(200, poll)
                return
            state['building'] = False
            state['index_msg'] = ''
            act_idx.setEnabled(True)
            st = box['st'] or {}
            status.showMessage('索引完成：文件 %s · 指针 %s · 可达 %s · 跨目录 %s · 悬空 %s'
                               % (st.get('文件'), st.get('指针'), st.get('可达'),
                                  st.get('跨目录'), st.get('悬空')))
            if state['cur']:
                show_file(state['cur'])     # 反向引用列表随索引完成自动出现
        QtCore.QTimer.singleShot(200, poll)

    act_idx.triggered.connect(build_index)

    # ---------------- 视图切换 / 导出链清单 ----------------
    def on_view(i):
        state['view'] = 'chain' if i == 0 else 'dir'
        if state['ix']:
            fill_tree()
            if state['cur']:
                locate_current(state['cur'])
    view_box.currentIndexChanged.connect(on_view)

    def on_kind(i):
        state['kind_filter'] = kind_box.itemData(i) or ''
        if state['ix'] and state['cur'] and state['attr_mode'] == 'file':
            show_file(state['cur'])
    kind_box.currentIndexChanged.connect(on_kind)

    def show_kinds():
        """类型谱系简明对照表：9 种类型的键名族与指向（非模态，可边看边点）。"""
        d = state.get('kinds_dialog')
        if d is not None:
            d.show()
            d.raise_()
            d.activateWindow()
            return
        d = QtWidgets.QDialog(win)
        d.setWindowTitle('GIM 指针类型谱系 —— 4 组 9 种')
        d.resize(960, 620)
        v = QtWidgets.QVBoxLayout(d)
        intro = QtWidgets.QLabel(
            '按引用目标与键名族把指针分为 4 组 9 种；引用链树与链清单使用同一套类型。')
        intro.setWordWrap(True)
        v.addWidget(intro)
        t = QtWidgets.QTableWidget(len(PTR_KINDS), 4)
        t.setHorizontalHeaderLabels(['类型', '大类', '键名族', '指向'])
        t.horizontalHeader().setSectionResizeMode(0, QtWidgets.QHeaderView.ResizeToContents)
        t.horizontalHeader().setSectionResizeMode(1, QtWidgets.QHeaderView.ResizeToContents)
        t.horizontalHeader().setSectionResizeMode(2, QtWidgets.QHeaderView.Interactive)
        t.horizontalHeader().setSectionResizeMode(3, QtWidgets.QHeaderView.Stretch)
        t.setColumnWidth(2, 420)
        t.setEditTriggers(QtWidgets.QAbstractItemView.NoEditTriggers)
        t.setWordWrap(True)
        for r, c in enumerate(KIND_ORDER):
            k = PTR_KINDS[c]
            items = [QtWidgets.QTableWidgetItem(k['name']),
                     QtWidgets.QTableWidgetItem(k['group']),
                     QtWidgets.QTableWidgetItem(k['keys']),
                     QtWidgets.QTableWidgetItem(k['targets'])]
            items[0].setForeground(QtGui.QBrush(QtGui.QColor(KIND_COLOR[c])))
            for col, it in enumerate(items):
                it.setToolTip(kind_tooltip(c))
                t.setItem(r, col, it)
            t.setRowHeight(r, 44)
        v.addWidget(t, 1)
        lab = QtWidgets.QLabel(
            '<b>不是指针：</b>*.NUM 计数键；TRANSFORMMATRIXn / COLORn 等配套参数；'
            '同 UUID 伴生文件（引用只能按指针值判断）。')
        lab.setWordWrap(True)
        v.addWidget(lab)
        bb = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Close)
        bb.button(QtWidgets.QDialogButtonBox.Close).setText('关闭')
        bb.rejected.connect(d.hide)
        v.addWidget(bb)
        state['kinds_dialog'] = d
        d.show()
    act_kinds.triggered.connect(show_kinds)

    def export_chain():
        ix, rel = state['ix'], state['cur']
        if not ix or not rel:
            return
        rows = ix.chain_files(rel)
        base = os.path.splitext(os.path.basename(rel))[0]
        path, _ = QtWidgets.QFileDialog.getSaveFileName(
            win, '导出引用链清单', '%s_链清单.csv' % base, 'CSV (*.csv)')
        if not path:
            return
        import csv
        miss = 0
        with open(path, 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.writer(f)
            w.writerow(['序号', '深度', '指针类型', '大类', '键', '文件', '大小', '状态'])
            for i, (r, d, how, key, ok) in enumerate(rows, 1):
                e = ix.files.get(r)
                code = NAME2CODE.get(how, '')
                if not ok:
                    miss += 1
                w.writerow([i, d, how, KIND_GROUP.get(code, '') if code else '根',
                            key, r, e.size if e else 0,
                            '已下载' if ok else '待下载'])
        status.showMessage('链清单已导出：%s（%d 行，其中待下载 %d 个）'
                           % (path, len(rows), miss))
    act_export.triggered.connect(export_chain)

    def escape(s):
        return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))

    # ---------------- 自检 ----------------
    if init_dir:
        load(init_dir)
    if selftest:
        state['quit_waits'] = 0

        def _quit():
            # 自动建索引可能还在后台跑，等它完成再自检，避免并发全量扫描
            if state['building']:
                state['quit_waits'] += 1
                if state['quit_waits'] < 80:
                    QtCore.QTimer.singleShot(300, _quit)
                    return
            receipt = {'ok': False}
            try:
                ix = state['ix']
                msg = 'files=%d' % (len(ix.files) if ix else 0)
                ifc = ''
                mod = ''
                root = ix._root_cbm() if ix else ''
                if not root:
                    raise RuntimeError('GUI self-test requires a nonempty fixture with a root CBM')
                if root and not ix.built:
                    st = ix.build_refs(lambda m: None)      # 自检顺带验证索引/反向引用
                    msg += ' idx=%s/%s' % (st['指针'], st['悬空'])
                if root:
                    open_rel(root)
                    ptrs = ix.pointers(root)
                    p0 = next((p for p in ptrs if p.status == 'ok'), None)
                    if p0:
                        open_rel(p0.target)
                        msg += ' jump=%s' % p0.target.split('/')[-1][:8]
                        # 不变量：属性表里每个指针都必须能在引用链里找到边
                        msg += ' edges=%d/%d' % (
                            len(ix.edges(p0.target)), len(ix.pointers(p0.target)))
                    go_back()
                    msg += ' back=%s hist=%d/%d ptrs=%d' % (
                        state['cur'].split('/')[-1][:8], state['pos'] + 1,
                        len(state['hist']), len(ptrs))
                    ch = ix.chain()
                    msg += ' chain=%d refs=%d' % (len(ch), len(ix.back_refs(state['cur'])))
                    st = ix.check(scan=False)
                    msg += ' types=%d/%s marks=%d' % (
                        len(PTR_KINDS),
                        ','.join('%s:%d' % (TYPE_NAME[c], st['按类型'].get(c, 0))
                                 for c in KIND_ORDER if st['按类型'].get(c)),
                        st['标识键'])
                    lv = [ix.level_name(r) or r.rsplit('.', 1)[-1] for r, _n, _k in ch]
                    msg += ' levels=%s' % ','.join(lv[:6])
                    rows = ix.chain_files(root)
                    msg += ' dl=%d/miss=%d' % (
                        len(rows), sum(1 for x in rows if not x[4]))
                    # 自动索引 + 非 KV 文件按内容显示（文本 / XML）
                    msg += ' built=%s backfiles=%d' % (ix.built, len(ix.back))
                    ifc = next((r for r in ix.files
                                if r.lower().endswith('.ifc')), '')
                    mod = next((r for r in ix.files
                                if r.lower().endswith('.mod')), '')
                    if ifc:
                        cm = ix.content(ifc)
                        msg += ' content=%s/%d' % (cm['mode'], len(cm['lines']))
                    if mod:
                        cx = ix.content(mod)
                        msg += ' xml=%s/e%d/a%d' % (
                            cx['mode'], cx.get('elements', 0),
                            cx.get('attrs', 0))
                    # 属性表两列 + 值列链接单击跳转
                    open_rel(root)
                    msg += ' cols=%d links=%d' % (
                        atv.columnCount(), len(state['targets']))
                    unique_links = [row for row, target in state['targets'].items() if isinstance(target, str)]
                    if unique_links:
                        on_attr_click(sorted(unique_links)[0], 1)
                        msg += ' click=%s' % state['cur'].split('/')[-1][:8]
                    # 展开到 F4，检查细分类型出边（层级下钻 / 属性族 / 模型锚点…）
                    f4 = next((r for r, _n, _k in ch
                               if ix.level_name(r) == 'F4System'), '')
                    if f4:
                        locate_chain(f4)
                    it4 = rel2item.get(f4) if f4 else None
                    if it4 is not None:
                        populate_chain(it4)
                        it4.setExpanded(True)
                        kinds = [it4.child(i).text(1) for i in range(it4.childCount())]
                        msg += ' f4kids=%s' % (','.join(sorted(set(kinds))))
                # 抓前 6 行树文本，便于无图核对引用链形态
                lines = []

                def walk(it, d=0):
                    if len(lines) >= 8:
                        return
                    lines.append('%s%s｜%s' % ('·' * d, it.text(0), it.text(1)))
                    for j in range(it.childCount()):
                        walk(it.child(j), d + 1)
                for i in range(tree.topLevelItemCount()):
                    walk(tree.topLevelItem(i))
                msg += ' tree=[' + ' / '.join(lines) + ']'
                win.grab().save('_chain_view.png')
                if ifc:
                    open_rel(ifc)
                    msg += ' textview=%s/rows=%d' % (
                        state['attr_mode'], atv.rowCount())
                win.grab().save('_browse.png')
                if mod:
                    open_rel(mod)
                    msg += ' xmlview=%s/rows=%d' % (
                        state['attr_mode'], atv.rowCount())
                    win.grab().save('_xml_view.png')
                receipt = {'ok': True, 'frozen': bool(getattr(__import__('sys'), 'frozen', False)),
                           'files': len(ix.files), 'pointers': st['指针'], 'ambiguous': st['多义'],
                           'historyEntries': len(state['hist']), 'columns': atv.columnCount(),
                           'rootChildren': rel2item[root].childCount(), 'detail': msg}
                print('BROWSE-OK %s' % msg, flush=True)
            except Exception:
                _log('自检异常:\n' + traceback.format_exc())
                receipt['ok'] = False
                receipt['error'] = traceback.format_exc()
                print('BROWSE-FAIL', flush=True)
            import json
            from pathlib import Path
            Path('browse-selftest.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
            app.exit(0 if receipt['ok'] else 1)
        QtCore.QTimer.singleShot(6000 if not init_dir else 8000, _quit)

    win.show()
    return app.exec()
