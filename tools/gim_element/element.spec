# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置 —— 免自解包目录包"""
from pathlib import Path

try:                                    # PyInstaller 注入 SPECPATH；直接 python 打开时回退
    TOOL_ROOT = Path(SPECPATH).resolve()
except NameError:                       # noqa: F821
    TOOL_ROOT = Path(__file__).resolve().parent

CATALOG = TOOL_ROOT / 'catalog.json'
if not CATALOG.is_file():
    raise SystemExit(f'Standalone engineering catalog missing: {CATALOG}')
ASSETS = ['catalog.json','standardCatalog.json','sourceVocabulary.json','sourceTypeAliases.json','catalogRules.json','proxyCategories.json']
if any(not (TOOL_ROOT / name).is_file() for name in ASSETS):
    raise SystemExit('Standalone recognition vocabulary is incomplete')

a = Analysis(
    [str(TOOL_ROOT / 'element_app.py')],
    pathex=[str(TOOL_ROOT)],
    binaries=[],
    datas=[(str(TOOL_ROOT / name), '.') for name in ASSETS],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[str(TOOL_ROOT / 'packaging_runtime.py')],
    excludes=[],
    noarchive=False,
    optimize=0,
)

# This Qt build imports the Windows native, unversioned ICU API. Unrelated
# PATH entries (e.g. Poppler/Conda) can make bindepend collect an incompatible
# ICU with versioned exports. Leave these OS components to System32.
_ICU = {'icuuc.dll', 'icuin.dll', 'icudt.dll', 'icu.dll'}
a.binaries = [entry for entry in a.binaries if Path(entry[0]).name.lower() not in _ICU]
_left = [entry[0] for entry in a.binaries if Path(entry[0]).name.lower() in _ICU]
if _left:
    raise SystemExit(f'Incompatible ICU DLL still collected: {_left}')

pyz = PYZ(a.pure)

# 依赖在 _internal 中，启动前不向系统 TEMP 自解包。
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='GIM实体盘点器',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

app = COLLECT(exe,a.binaries,a.datas,strip=False,upx=False,name='GIM实体盘点器')
