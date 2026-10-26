# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置 —— 单文件 exe，内嵌 QtWebEngine 与 three.js 渲染层"""
from PyInstaller.utils.hooks import collect_all
import os

try:                                    # PyInstaller 注入 SPECPATH；直接 python 打开时回退
    HERE = SPECPATH
except NameError:                       # noqa: F821
    HERE = os.path.dirname(os.path.abspath(__file__))

_d = lambda n: (os.path.join(HERE, n), '.')

datas = [
    _d('viewer_shell.html'),
    _d('three.min.js'),
    _d('OrbitControls.js'),
    _d('app.ico'),
]
binaries = []
hiddenimports = []

# py7zr 的解压后端全是编译扩展，必须完整收集
for pkg in ['py7zr', 'pyzstd', 'pyppmd', 'pybcj', 'multivolumefile',
            'inflate64', 'brotli', 'brotlicffi', 'pycryptodomex', 'Cryptodome']:
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

hiddenimports += ['gim_core']

a = Analysis(
    [os.path.join(HERE, 'viewer_app.py')],
    pathex=[HERE],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter', 'matplotlib', 'numpy', 'PIL', 'scipy', 'pandas',
        'PySide6.QtQml', 'PySide6.QtQuick', 'PySide6.Qt3D',
        'PySide6.QtMultimedia', 'PySide6.QtBluetooth', 'PySide6.QtNfc',
        'PySide6.QtPositioning', 'PySide6.QtSensors', 'PySide6.QtCharts',
        'PySide6.QtDataVisualization', 'PySide6.QtDesigner', 'PySide6.QtHelp',
        'PySide6.QtSql', 'PySide6.QtTest', 'PySide6.QtSerialPort',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='GIM设备查看器',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=os.path.join(HERE, 'app.ico'),
)
