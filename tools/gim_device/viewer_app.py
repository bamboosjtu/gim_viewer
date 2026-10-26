# -*- coding: utf-8 -*-
"""
viewer_app.py —— GIM 设备三维查看器（桌面版）

外壳职责：选文件 / 拖文件 / 解析 / 把 JSON 推给 Web 渲染层 / 菜单与状态。
几何与交互全部在 viewer_shell.html 里完成。

线程约定：解析在后台 QThread 里跑，结果写入共享容器，主线程用 QTimer 轮询取回。
（不用跨线程 Signal —— 冻结环境下的 queued 投递不可靠）
"""
import os
import sys
import time
import json
import shutil
import tempfile
import traceback

os.environ.setdefault('QTWEBENGINE_CHROMIUM_FLAGS',
                      '--ignore-gpu-blocklist --enable-unsafe-swiftshader '
                      '--disable-features=TranslateUI,MediaRouter')

from PySide6.QtCore import Qt, QUrl, QTimer, QThread, QSettings, QSize, QPoint
from PySide6.QtGui import QAction, QKeySequence, QIcon, QGuiApplication, QPainter, QPixmap, QColor, QPen, QFont
from PySide6.QtWidgets import (QApplication, QMainWindow, QFileDialog, QMessageBox,
                               QWidget, QVBoxLayout, QLabel, QProgressBar, QFrame)
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings

APP_NAME = 'GIM 设备三维查看器'
APP_VER = '1.0'
HERE = os.path.dirname(os.path.abspath(__file__))


def res(rel):
    """兼容 PyInstaller onefile（资源解包到 _MEIPASS）"""
    base = getattr(sys, '_MEIPASS', HERE)
    return os.path.join(base, rel)


def app_icon():
    """程序内绘制图标，免去外部资源文件"""
    pm = QPixmap(128, 128)
    pm.fill(Qt.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.Antialiasing)
    p.setBrush(QColor('#1b5e8f')); p.setPen(Qt.NoPen)
    p.drawRoundedRect(8, 8, 112, 112, 24, 24)
    p.setPen(QPen(QColor('#ffffff'), 7))
    p.setBrush(Qt.NoBrush)
    p.drawPolygon([QPoint(38,84), QPoint(38,50), QPoint(64,34), QPoint(90,50), QPoint(90,84)])
    p.drawLine(38, 50, 64, 66); p.drawLine(90, 50, 64, 66); p.drawLine(64, 66, 64, 96)
    p.end()
    return QIcon(pm)


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

    def run(self):
        work = tempfile.mkdtemp(prefix='gimview_')
        try:
            import gim_core
            data = gim_core.load(self.path, work)
            self.result = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
        except Exception:
            self.error = traceback.format_exc(limit=4)
        finally:
            shutil.rmtree(work, ignore_errors=True)
            self.done = True


# --------------------------------------------------------------------------
# 页面
# --------------------------------------------------------------------------
class GimPage(QWebEnginePage):
    """拦截拖放导致的 file:// 导航，转成打开动作"""
    def __init__(self, view, host):
        super().__init__(view)
        self.host = host

    def acceptNavigationRequest(self, url, navType, isMainFrame):
        if url.isLocalFile():
            p = url.toLocalFile()
            if p.lower().endswith('.gim'):
                self.host.open_gim(p)
                return False
            if p.lower().endswith('viewer_shell.html'):
                return True
            return False
        return super().acceptNavigationRequest(url, navType, isMainFrame)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.setWindowIcon(app_icon())
        self.resize(1480, 940)
        self.setAcceptDrops(True)

        self.settings = QSettings('GIMViewer', 'Viewer')
        self.worker = None
        self.cur_path = None
        self.recent = self.settings.value('recent', []) or []
        if isinstance(self.recent, str):
            self.recent = [self.recent]

        central = QWidget()
        lay = QVBoxLayout(central)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)

        self.bar = QFrame()
        self.bar.setStyleSheet('QFrame{background:#f6f8fb;border-bottom:1px solid #dfe5ee;}'
                               'QLabel{color:#46536a;font-size:12px;}')
        bl = QVBoxLayout(self.bar)
        bl.setContentsMargins(14, 6, 14, 6)
        bl.setSpacing(3)
        self.lb_hint = QLabel('正在载入渲染内核…')
        self.prog = QProgressBar()
        self.prog.setMaximumHeight(3)
        self.prog.setTextVisible(False)
        self.prog.setRange(0, 0)
        self.prog.setStyleSheet('QProgressBar{background:#e3e9f1;border:0;}'
                                'QProgressBar::chunk{background:#1b5e8f;}')
        bl.addWidget(self.lb_hint)
        bl.addWidget(self.prog)
        lay.addWidget(self.bar)

        self.view = QWebEngineView()
        self.page = GimPage(self.view, self)
        self.view.setPage(self.page)
        self.view.setContextMenuPolicy(Qt.NoContextMenu)
        st = self.view.settings()
        st.setAttribute(QWebEngineSettings.WebGLEnabled, True)
        st.setAttribute(QWebEngineSettings.Accelerated2dCanvasEnabled, True)
        st.setAttribute(QWebEngineSettings.LocalContentCanAccessFileUrls, True)
        st.setAttribute(QWebEngineSettings.LocalContentCanAccessRemoteUrls, False)
        st.setAttribute(QWebEngineSettings.FocusOnNavigationEnabled, True)
        lay.addWidget(self.view, 1)
        self.setCentralWidget(central)

        self.status = self.statusBar()
        self.status.setStyleSheet('QStatusBar{background:#f6f8fb;border-top:1px solid #dfe5ee;'
                                  'color:#5c6b7f;font-size:11px;} QStatusBar::item{border:0}')
        self.lb_status = QLabel('就绪')
        self.status.addWidget(self.lb_status, 1)
        self.lb_geo = QLabel('')
        self.status.addPermanentWidget(self.lb_geo)

        self._build_menu()
        self._load_shell()

        # 命令行参数直接打开
        args = [a for a in sys.argv[1:] if a.lower().endswith('.gim')] if '--smoke' not in sys.argv else []
        if args:
            QTimer.singleShot(1200, lambda: self.open_gim(args[0]))

    # ---------- 菜单 ----------
    def _build_menu(self):
        mb = self.menuBar()
        mb.setStyleSheet('QMenuBar{background:#ffffff;border-bottom:1px solid #e3e8ef;font-size:12px;}'
                         'QMenuBar::item{padding:5px 11px;background:transparent;}'
                         'QMenuBar::item:selected{background:#eef3f8;}'
                         'QMenu{background:#ffffff;border:1px solid #e3e8ef;font-size:12px;padding:4px;}'
                         'QMenu::item{padding:5px 22px 5px 14px;border-radius:4px;}'
                         'QMenu::item:selected{background:#e8f1f8;}')

        m = mb.addMenu('文件(&F)')
        a = QAction('打开 GIM…', self); a.setShortcut(QKeySequence.Open)
        a.triggered.connect(self.pick_file); m.addAction(a)

        self.m_recent = m.addMenu('最近打开')
        self._rebuild_recent()

        m.addSeparator()
        a = QAction('重新载入渲染内核', self); a.setShortcut('F5')
        a.triggered.connect(self._load_shell); m.addAction(a)
        a = QAction('关闭当前模型', self); a.triggered.connect(self.close_model); m.addAction(a)
        m.addSeparator()
        a = QAction('导出三维视图 PNG…', self); a.setShortcut('Ctrl+S')
        a.triggered.connect(self.export_view); m.addAction(a)
        a = QAction('窗口截图…', self); a.setShortcut('Ctrl+Shift+S')
        a.triggered.connect(self.save_shot); m.addAction(a)
        m.addSeparator()
        a = QAction('退出', self); a.setShortcut('Ctrl+Q')
        a.triggered.connect(self.close); m.addAction(a)

        m = mb.addMenu('视图(&V)')
        for name, key, sc in [('等轴测', 'iso', '1'), ('正视', 'front', '2'),
                              ('侧视', 'side', '3'), ('俯视', 'top', '4')]:
            a = QAction(name, self); a.setShortcut(sc)
            a.triggered.connect(lambda _=False, k=key: self.js(f"window.__api.view('{k}')"))
            m.addAction(a)
        m.addSeparator()
        for name, key, sc in [('实体', 'solid', '5'), ('线框', 'edge', '6'), ('实体+边', 'both', '7')]:
            a = QAction(name, self); a.setShortcut(sc)
            a.triggered.connect(lambda _=False, k=key: self.js(f"window.__api.mode('{k}')"))
            m.addAction(a)
        m.addSeparator()
        for name, key in [('GIM 原色', 'gim'), ('按图元类型', 'type'), ('冷灰', 'cool')]:
            a = QAction(name, self)
            a.triggered.connect(lambda _=False, k=key: self.js(f"window.__api.color('{k}')"))
            m.addAction(a)
        m.addSeparator()
        a = QAction('适应窗口', self); a.setShortcut('F')
        a.triggered.connect(lambda: self.js('window.__api.fit()')); m.addAction(a)
        a = QAction('放大', self); a.setShortcut(QKeySequence.ZoomIn)
        a.triggered.connect(lambda: self.js('window.__api.zoom(1.18)')); m.addAction(a)
        a = QAction('缩小', self); a.setShortcut(QKeySequence.ZoomOut)
        a.triggered.connect(lambda: self.js('window.__api.zoom(0.85)')); m.addAction(a)

        m = mb.addMenu('帮助(&H)')
        a = QAction('关于', self); a.triggered.connect(self.about); m.addAction(a)
        a = QAction('快捷键与使用说明', self); a.setShortcut('F1')
        a.triggered.connect(self.help_dialog); m.addAction(a)

    def _rebuild_recent(self):
        self.m_recent.clear()
        if not self.recent:
            a = QAction('（空）', self); a.setEnabled(False); self.m_recent.addAction(a); return
        for p in self.recent[:10]:
            a = QAction(os.path.basename(p), self)
            a.setToolTip(p)
            a.triggered.connect(lambda _=False, path=p: self.open_gim(path))
            self.m_recent.addAction(a)
        self.m_recent.addSeparator()
        a = QAction('清空列表', self); a.triggered.connect(self._clear_recent)
        self.m_recent.addAction(a)

    def _clear_recent(self):
        self.recent = []
        self.settings.setValue('recent', [])
        self._rebuild_recent()

    def _push_recent(self, path):
        self.recent = [path] + [p for p in self.recent if p != path]
        self.recent = self.recent[:10]
        self.settings.setValue('recent', self.recent)
        self._rebuild_recent()

    # ---------- 载入 ----------
    def _load_shell(self):
        self.lb_hint.setText('正在载入渲染内核…')
        self.prog.setVisible(True)
        html = res('viewer_shell.html')
        if not os.path.exists(html):
            QMessageBox.critical(self, '缺少文件', f'找不到渲染页面：\n{html}')
            return
        self.view.setUrl(QUrl.fromLocalFile(html))
        self.view.loadFinished.connect(self._on_loaded)

    def _on_loaded(self, ok):
        self.prog.setVisible(False)
        if not ok:
            self.lb_hint.setText('渲染内核载入失败')
            return
        self.lb_hint.setText('就绪 —— 拖入 .gim 文件，或按 Ctrl+O 打开')
        self.lb_status.setText('就绪')
        # 探测 WebGL
        self.view.page().runJavaScript(
            "(() => { try { const c=document.createElement('canvas');"
            " return !!(c.getContext('webgl2')||c.getContext('webgl')); } catch(e){ return false; } })()",
            self._on_webgl)

    def _on_webgl(self, ok):
        if ok is False:
            QMessageBox.warning(self, 'WebGL 不可用',
                                '当前系统未启用 WebGL，三维视图可能无法显示。\n'
                                '请检查显卡驱动，或告知我以便切换为软件渲染。')

    def js(self, code):
        self.view.page().runJavaScript(code)

    def pick_file(self):
        start = self.settings.value('lastDir', '') or ''
        path, _ = QFileDialog.getOpenFileName(self, '打开 GIM 文件', start, 'GIM 模型 (*.gim);;所有文件 (*)')
        if path:
            self.open_gim(path)

    def open_gim(self, path):
        if not os.path.isfile(path):
            QMessageBox.warning(self, '文件不存在', path)
            return
        if self.worker is not None:
            return
        self.cur_path = path
        self.settings.setValue('lastDir', os.path.dirname(path))
        self.setWindowTitle(f'{os.path.basename(path)} — {APP_NAME}')
        self.lb_hint.setText(f'解析中：{os.path.basename(path)}')
        self.prog.setVisible(True)
        self.lb_status.setText('解析中…')

        self.worker = ParseWorker(path)
        self.worker.start()
        self._poll = QTimer(self)
        self._poll.timeout.connect(self._check_worker)
        self._poll.start(120)

    def _check_worker(self):
        if not self.worker:
            return
        if not self.worker.done:
            return
        self._poll.stop()
        w = self.worker
        self.worker = None
        if w.error:
            self.prog.setVisible(False)
            self.lb_hint.setText('解析失败')
            self.lb_status.setText('解析失败')
            QMessageBox.critical(self, '解析失败', w.error)
            return
        self._inject(w.result)
        self._push_recent(self.cur_path)

    def _inject(self, payload):
        t0 = time.time()
        self.lb_hint.setText('构建几何…')
        self.view.page().runJavaScript(
            f'window.loadModel({payload})',
            self._on_injected)

    def _on_injected(self, r):
        self.prog.setVisible(False)
        try:
            if isinstance(r, str):
                r = json.loads(r)
        except Exception:
            r = None
        if not isinstance(r, dict) or not r.get('ok'):
            self.lb_hint.setText('渲染失败')
            QMessageBox.warning(self, '渲染失败', str(r))
            return
        self.lb_hint.setText(f'已加载 {os.path.basename(self.cur_path)}')
        self.lb_status.setText('左键旋转 · 滚轮缩放 · 右键平移 · 点击拾取')
        self.view.page().runJavaScript(
            "(() => { const m = document.querySelector('#badge_txt');"
            " const d = document.querySelector('#s_size');"
            " return [m?m.textContent:'', d?d.textContent:'']; })()",
            self._update_geo_label)

    def _update_geo_label(self, arr):
        if isinstance(arr, list) and len(arr) == 2:
            self.lb_geo.setText(f'{arr[0]}    包围盒 {arr[1]} m')

    def close_model(self):
        self.cur_path = None
        self.view.page().runJavaScript('window.clearModel()')
        self.setWindowTitle(APP_NAME)
        self.lb_hint.setText('就绪 —— 拖入 .gim 文件，或按 Ctrl+O 打开')
        self.lb_geo.setText('')

    # ---------- 截图 ----------
    def save_shot(self):
        if not self.cur_path:
            QMessageBox.information(self, '提示', '请先打开一个模型。')
            return
        default = os.path.splitext(os.path.basename(self.cur_path))[0] + '.png'
        path, _ = QFileDialog.getSaveFileName(self, '保存截图',
                                              os.path.join(self.settings.value('lastDir', ''), default),
                                              'PNG 图片 (*.png)')
        if not path:
            return
        # 先尝试系统层抓窗口（QtWebEngine 的内容不在 QWidget 绘制缓冲里）
        pix = None
        try:
            scr = QGuiApplication.primaryScreen()
            if scr:
                pix = scr.grabWindow(int(self.winId()))
        except Exception:
            pix = None
        if (pix is None or pix.isNull()) and hasattr(self.view, 'grab'):
            pix = self.view.grab()
        if pix is not None and not pix.isNull() and pix.save(path, 'PNG'):
            self.lb_status.setText(f'已保存截图：{path}')
        else:
            QMessageBox.warning(self, '保存失败', path)

    def export_view(self):
        """只导出三维视图（不含界面），按当前窗口 2 倍分辨率"""
        if not self.cur_path:
            QMessageBox.information(self, '提示', '请先打开一个模型。')
            return
        default = os.path.splitext(os.path.basename(self.cur_path))[0] + '_视图.png'
        path, _ = QFileDialog.getSaveFileName(self, '导出三维视图',
                                              os.path.join(self.settings.value('lastDir', ''), default),
                                              'PNG 图片 (*.png)')
        if not path:
            return
        self._export_to = path
        self.view.page().runJavaScript('window.__api.snapshot()', self._on_snapshot)

    def _on_snapshot(self, dataurl):
        path = getattr(self, '_export_to', None)
        if not dataurl or not isinstance(dataurl, str) or not path:
            QMessageBox.warning(self, '导出失败', '未能取到画布内容。')
            return
        try:
            import base64
            b64 = dataurl.split(',', 1)[1]
            with open(path, 'wb') as f:
                f.write(base64.b64decode(b64))
            self.lb_status.setText(f'已导出视图：{path}')
        except Exception as e:
            QMessageBox.warning(self, '导出失败', str(e))

    # ---------- 拖放 ----------
    def dragEnterEvent(self, ev):
        if ev.mimeData().hasUrls():
            for u in ev.mimeData().urls():
                if u.toLocalFile().lower().endswith('.gim'):
                    ev.acceptProposedAction(); return
        ev.ignore()

    def dropEvent(self, ev):
        for u in ev.mimeData().urls():
            p = u.toLocalFile()
            if p.lower().endswith('.gim'):
                self.open_gim(p); return

    # ---------- 对话框 ----------
    def about(self):
        QMessageBox.about(self, '关于', f"""
        <h3>{APP_NAME}</h3>
        <p style="color:#5c6b7f">版本 {APP_VER}</p>
        <p>解析国网三维设计 GIM 设备模型并实时三维重建。<br>
        支持 GIMPKGS/GIMPKGT 封装与裸 7z 容器。</p>
        <p style="font-size:12px;color:#7b8899">
        几何全部由 mod 中的参数化图元重建：<br>
        Cuboid / Cylinder / Sphere / TruncatedCone / StretchedBody /<br>
        PorcelainBushing / Ring / TerminalBlock / Boolean 等</p>
        """)

    def help_dialog(self):
        QMessageBox.information(self, '使用说明', """
操作
  拖入 .gim 文件，或 Ctrl+O 打开
  左键拖动旋转 · 滚轮缩放 · 右键拖动平移
  点击模型或右侧列表项查看实体参数

快捷键
  1/2/3/4   等轴测 / 正视 / 侧视 / 俯视
  5/6/7     实体 / 线框 / 实体+边
  F         适应窗口
  Ctrl+S    保存截图
  F5        重新载入渲染内核

教学提示
  · 左侧「图元类型」可点击筛选，只显示某一类几何
  · 顶部「按图元」配色可一眼区分圆柱、长方体、拉伸体等构成
  · 右下「分解视图」滑块可把装配体拆开看层次
  · 「显示隐藏实体」可查看 Visible=false 的辅助几何
        """)


def main():
    QApplication.setAttribute(Qt.AA_ShareOpenGLContexts, True)
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setWindowIcon(app_icon())
    w = MainWindow()
    w.show()

    # 自检：自动打开指定模型并截图退出
    if '--smoke' in sys.argv:
        idx = sys.argv.index('--smoke')
        target = sys.argv[idx+1] if len(sys.argv) > idx+2 else ''
        outpng = sys.argv[idx+2] if len(sys.argv) > idx+2 else 'smoke.png'
        smode = os.environ.get('GIM_SMOKE_MODE', 'solid')   # solid / edge / both
        def go():
            if target and os.path.isfile(target):
                w.open_gim(target)
        def shot():
            # 用画布导出验证真实渲染结果（窗口截图抓不到 GPU 合成层）
            def cb(url):
                try:
                    import base64
                    if url and isinstance(url, str):
                        open(outpng, 'wb').write(base64.b64decode(url.split(',',1)[1]))
                        print('SMOKE_SHOT', outpng, flush=True)
                    else:
                        print('SMOKE_EMPTY_CANVAS', flush=True)
                except Exception as e:
                    print('SMOKE_FAIL', e, flush=True)
                app.quit()
            if smode == 'solid':
                w.view.page().runJavaScript('window.__api.snapshot()', cb)
            else:
                w.view.page().runJavaScript("window.__api.mode('%s')" % smode, lambda _: None)
                QTimer.singleShot(900, lambda: w.view.page().runJavaScript(
                    'window.__api.snapshot()', cb))
        QTimer.singleShot(2500, go)
        QTimer.singleShot(9000, shot)

    sys.exit(app.exec())


if __name__ == '__main__':
    main()
