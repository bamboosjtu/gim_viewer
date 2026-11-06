# -*- mode: python ; coding: utf-8 -*-
"""Onefile package for the GIM file and reference browser."""
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
    runtime_hooks=[],
    excludes=[
        'gim_gui', 'gim_core', 'btv_class', 'btv_dev', 'btv_file', 'btv_ifc',
        'btv_split', 'dev_inst', 'fusion', 'ifc_lookup', 'ifc_probe', 'bay_infer',
    ],
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
    a.binaries,
    a.datas,
    [],
    name='GIM信息阅读器',
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
)
