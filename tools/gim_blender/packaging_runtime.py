"""Onedir: no system-temp self-extraction; writable cache is data/ beside exe."""
import os, sys, tempfile
from pathlib import Path
if getattr(sys, 'frozen', False) and '--self-check' not in sys.argv:
    work = Path(sys.executable).resolve().parent/'data/tmp'
    work.mkdir(parents=True, exist_ok=True)
    os.environ.update(TEMP=str(work), TMP=str(work), TMPDIR=str(work), PYTHONDONTWRITEBYTECODE='1')
    tempfile.tempdir = str(work)
