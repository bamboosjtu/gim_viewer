"""Check the frozen directory package without launching the GUI."""
import sys
from pathlib import Path

from PyInstaller.archive.readers import CArchiveReader

ICU = {'icuuc.dll', 'icuin.dll', 'icudt.dll', 'icu.dll'}


def main(exe):
    exe = Path(exe).resolve()
    if not exe.is_file():
        raise SystemExit(f'Missing packaged executable: {exe}')
    archive = CArchiveReader(str(exe))
    toc = archive.toc
    assets=exe.parent/'_internal'
    if not (assets/'catalog.json').is_file():
        raise SystemExit('catalog.json missing from the package')
    for name in ['standardCatalog.json', 'sourceVocabulary.json', 'sourceTypeAliases.json', 'catalogRules.json','proxyCategories.json']:
        if not (assets/name).is_file():
            raise SystemExit(name + ' missing from the package')
    if any(name in toc for name in ['node.exe','recognition-engine.cjs']):
        raise SystemExit('Unexpected main-program runtime bundled')
    bundled_icu = sorted({name.replace('\\', '/').rsplit('/', 1)[-1] for name in [*toc,*[str(p) for p in assets.rglob('*.dll')]]} & ICU)
    if bundled_icu:
        raise SystemExit('Incompatible ICU DLL bundled: ' + ', '.join(bundled_icu))
    size = exe.stat().st_size / (1024 * 1024)
    print(f'directory package verified: {size:.1f} MB, {len(toc)} entries')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: verify_package.py <exe>')
    main(sys.argv[1])
