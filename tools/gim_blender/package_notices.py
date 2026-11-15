"""Copy notices from this tool's build environment into its directory package."""
import importlib.metadata
from pathlib import Path
import shutil
import sys

def main():
    tool = Path(__file__).resolve().parent
    bundle = (tool/'dist/gim_blender').resolve()
    assert bundle.is_relative_to(tool/'dist') and (bundle/'gim_blender.exe').is_file()
    for name in ['README.md','THIRD_PARTY.md','snapshot.json']:
        shutil.copy2(tool/name, bundle/name)
    node = bundle/'_internal/assets/runtime/node.exe'
    installed_node = Path(shutil.which('node.exe') or shutil.which('node') or '')
    license_file = installed_node.parent/'LICENSE'
    if not license_file.is_file():
        raise RuntimeError('Node distribution LICENSE is missing beside the build-time node executable')
    shutil.copy2(license_file, node.parent/'Node-LICENSE.txt')
    for package in ['py7zr','numpy','brotli','pycryptodomex','pyppmd','pybcj','inflate64','backports.zstd','multivolumefile','texttable','PyInstaller']:
        dist = importlib.metadata.distribution(package)
        for item in dist.files or []:
            if not any(part.endswith('.dist-info') for part in item.parts):
                continue
            source = Path(dist.locate_file(item))
            if not source.is_file():
                continue
            index = next(i for i, part in enumerate(item.parts) if part.endswith('.dist-info'))
            target = bundle/'_internal/third-party'/Path(*item.parts[index:])
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

if __name__=='__main__':
    main()
