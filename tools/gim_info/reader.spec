# -*- mode: python ; coding: utf-8 -*-
"""Directory package for the GIM file and reference browser."""
from pathlib import Path

try:
    TOOL_ROOT = Path(SPECPATH).resolve()
except NameError:
    TOOL_ROOT = Path(__file__).resolve().parent

a = Analysis(
    [str(TOOL_ROOT / 'gim_reader.py')],
    pathex=[str(TOOL_ROOT)],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[str(Path(SPECPATH) / 'packaging_runtime.py')],
    excludes=[],
    noarchive=False,
    optimize=0,
)

# Use the Windows native ICU API, as in element.spec.
_ICU = {'icuuc.dll', 'icuin.dll', 'icudt.dll', 'icu.dll'}
a.binaries = [entry for entry in a.binaries if Path(entry[0]).name.lower() not in _ICU]

pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='GIM信息阅读器',
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

app = COLLECT(exe,a.binaries,a.datas,strip=False,upx=False,name='GIM信息阅读器')
