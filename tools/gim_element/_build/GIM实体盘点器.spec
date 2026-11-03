# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

tool_root = Path(SPECPATH).resolve().parent
catalog = tool_root.parents[1] / 'desktop' / 'src' / 'engineering' / 'catalog.json'
if not catalog.is_file():
    raise FileNotFoundError(f'Shared engineering catalog missing: {catalog}')

a = Analysis(
    [str(tool_root / 'element_app.py')],
    pathex=[str(tool_root)],
    binaries=[],
    datas=[(str(catalog), '.')],
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[str(tool_root / 'packaging_runtime.py')],
    excludes=[],
    noarchive=False,
)
# This Qt build imports the Windows native, unversioned ICU API. Unrelated
# PATH entries (e.g. Poppler/Conda) can make bindepend collect an incompatible
# ICU with versioned exports. Leave these OS components to System32.
a.binaries = [entry for entry in a.binaries if Path(entry[0]).name.lower() not in {'icuuc.dll', 'icuin.dll', 'icudt.dll', 'icu.dll'}]
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [], exclude_binaries=True,
    name='GIM实体盘点器', debug=False, bootloader_ignore_signals=False,
    strip=False, upx=False, console=False,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='GIM实体盘点器')
