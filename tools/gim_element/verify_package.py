"""Check the frozen onefile artifact without launching the GUI."""
import sys
from pathlib import Path

from PyInstaller.archive.readers import CArchiveReader

ICU = {'icuuc.dll', 'icuin.dll', 'icudt.dll', 'icu.dll'}


def main(exe):
    exe = Path(exe).resolve()
    if not exe.is_file():
        raise SystemExit(f'Missing packaged executable: {exe}')
    toc = CArchiveReader(str(exe)).toc
    if 'catalog.json' not in toc:
        raise SystemExit('catalog.json missing from the packaged exe')
    bundled_icu = sorted({name.replace('\\', '/').rsplit('/', 1)[-1] for name in toc} & ICU)
    if bundled_icu:
        raise SystemExit('Incompatible ICU DLL bundled: ' + ', '.join(bundled_icu))
    size = exe.stat().st_size / (1024 * 1024)
    print(f'onefile archive verified: {size:.1f} MB, {len(toc)} entries')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: verify_package.py <exe>')
    main(sys.argv[1])
