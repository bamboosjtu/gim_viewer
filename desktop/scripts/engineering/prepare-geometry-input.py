"""Extract geometry evidence into a separate output, preserving research inputs."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT / 'output/refactor-source-geometry-input-v1'


def main() -> None:
    args = argparse.ArgumentParser()
    args.add_argument('--samples', nargs='*')
    selected = args.parse_args().samples
    manifest = json.loads((ROOT / 'output/refactor-baseline/manifest.json').read_text('utf-8'))
    seven = ROOT / 'desktop/node_modules/7zip-bin/win/x64/7za.exe'
    for package in manifest['packages']:
        sample, source = package['sample'], package['source']
        if selected and sample not in selected:
            continue
        data = (ROOT / source['path']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == source['sha256'], f'{sample}: source SHA changed'
        payload = ROOT / f'output/entity-normalization/source-v1/{sample}/payload.7z'
        assert payload.read_bytes() == data[source['offset']:], f'{sample}: payload differs from original source'
        target = DEST / sample
        identity = target / 'identity.json'
        if identity.exists():
            existing = json.loads(identity.read_text('utf-8'))
            if existing['sourceSha256'] == source['sha256'] and all(
                (target / 'files' / entry['path']).is_file()
                and hashlib.sha256((target / 'files' / entry['path']).read_bytes()).hexdigest() == entry['sha256']
                for entry in existing['entries']
            ):
                print(f'{sample}: verified {len(existing["entries"])} existing geometry files', flush=True)
                continue
        files = target / 'files'
        files.mkdir(parents=True, exist_ok=True)
        subprocess.run([str(seven), 'x', str(payload), f'-o{files}', '-y', '-r',
                        '*.dev', '*.phm', '*.mod', '*.stl', '*.gl'], check=True, stdout=subprocess.DEVNULL)
        entries = [{'path': p.relative_to(files).as_posix(), 'bytes': p.stat().st_size,
                    'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                   for p in sorted(files.rglob('*')) if p.is_file()]
        identity.write_text(json.dumps({'sample': sample, 'sourceSha256': source['sha256'], 'entries': entries}, indent=2), encoding='utf-8', newline='\n')
        print(f'{sample}: extracted {len(entries)} geometry files', flush=True)


if __name__ == '__main__':
    main()
