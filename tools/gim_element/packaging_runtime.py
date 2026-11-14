"""Frozen tools keep temporary files beside their executable."""
import os,sys,tempfile
from pathlib import Path

if getattr(sys,'frozen',False):
    work=Path(sys.executable).resolve().parent/'tmp'
    work.mkdir(exist_ok=True)
    os.environ.update(TEMP=str(work),TMP=str(work),TMPDIR=str(work))
    tempfile.tempdir=str(work)

if '--smoke' in sys.argv:
    index=sys.argv.index('--smoke')
    if len(sys.argv)>index+2:
        log=open(Path(sys.argv[index+2]+'.log'),'w',encoding='utf-8',buffering=1)
        sys.stdout=log;sys.stderr=log
