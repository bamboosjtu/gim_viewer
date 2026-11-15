"""Publish only application resources, excluding the user's data/ library."""
import argparse
import os
from pathlib import Path
import zipfile


def publish(bundle, output):
    bundle, output = Path(bundle).resolve(), Path(output).resolve()
    if not (bundle/'gim_blender.exe').is_file() or not (bundle/'_internal').is_dir():
        raise ValueError('Incomplete application directory')
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = output.with_suffix('.zip.staging')
    with zipfile.ZipFile(staging, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name in ['gim_blender.exe', 'README.md', 'THIRD_PARTY.md', 'snapshot.json', '_internal', 'runtime']:
            source = bundle/name
            if source.is_file():
                archive.write(source, 'gim_blender/'+name)
            elif source.is_dir():
                for directory, dirs, files in os.walk(source, followlinks=False):
                    dirs.sort()
                    for file in sorted(files):
                        item = Path(directory)/file
                        if item.suffix.casefold() == '.gim':
                            raise ValueError('Source GIM cannot be distributed in application resources')
                        archive.write(item, 'gim_blender/'+item.relative_to(bundle).as_posix())
    staging.replace(output)


if __name__=='__main__':
    tool = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default=str(tool/'dist/gim_blender.zip'))
    args = parser.parse_args()
    publish(tool/'dist/gim_blender', args.out)
