from pathlib import Path
tool = Path(SPECPATH).resolve()
a = Analysis([str(tool/'app.py')], pathex=[str(tool), str(tool/'assets/scripts')],
    datas=[(str(tool/'assets/scripts'),'assets/scripts'),(str(tool/'assets/node'),'assets/node'),(str(tool/'snapshot.json'),'.')],
    binaries=[], hiddenimports=['numpy','py7zr','archive_index','extract_gim','site_steps','equipment_collision','project_identity'],
    runtime_hooks=[str(tool/'packaging_runtime.py')], excludes=['PySide6','PyQt6','matplotlib'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz,a.scripts,[],exclude_binaries=True,name='gim_blender',console=False,upx=False)
app = COLLECT(exe,a.binaries,a.datas,name='gim_blender',upx=False)
