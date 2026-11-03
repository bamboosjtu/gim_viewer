"""Prepare bounded raw semantic fixtures from the nine pinned source archives."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import sys
import subprocess
import zipfile

REPO = Path(__file__).resolve().parents[3]
try:
    import py7zr
except ImportError:
    candidate = REPO / 'tools/gim_element/.venv/Scripts/python.exe'
    if candidate.is_file() and candidate.resolve() != Path(sys.executable).resolve():
        raise SystemExit(subprocess.run([str(candidate),str(Path(__file__).resolve()),*sys.argv[1:]],creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0).returncode)
    raise SystemExit('Install py7zr for this Python interpreter before preparing the corpus')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def prepare(sample):
    source = REPO / sample['path']
    data = source.read_bytes()
    if len(data) != sample['bytes'] or sha(data) != sample['sha256']:
        raise ValueError(f"Source identity mismatch: {sample['id']}")
    offset = sample['payloadOffset']
    target = REPO / 'output/engineering-stage3/corpus-v1' / sample['id']
    receipt = target / 'identity.json'
    if receipt.is_file():
        saved = json.loads(receipt.read_text(encoding='utf-8'))
        if saved.get('sha256') == sample['sha256'] and all((target / 'files' / item['path']).is_file() for item in saved['semantic']):
            print(sample['id'], 'existing raw corpus', flush=True)
            return
    target.mkdir(parents=True, exist_ok=True)
    raw = target / 'files'
    raw.mkdir(exist_ok=True)
    payload = io.BytesIO(data[offset:])
    is_seven = data[offset:offset+6] == b'7z\xbc\xaf\x27\x1c'
    if is_seven:
        archive = py7zr.SevenZipFile(payload, 'r')
        entries = [(f.filename, f.uncompressed or 0, f.is_directory) for f in archive.list()]
    else:
        archive = zipfile.ZipFile(payload)
        entries = [(f.filename, f.file_size, f.is_dir()) for f in archive.infolist()]
    with archive:
        paths, semantic = [], []
        for name, size, directory in entries:
            path = PurePosixPath(name.replace('\\', '/'))
            if path.is_absolute() or '..' in path.parts or ':' in name:
                raise ValueError('Archive path outside fixture workspace')
            if directory:
                continue
            paths.append(name)
            if path.suffix.lower() in {'.cbm', '.dev', '.fam', '.ifc'}:
                semantic.append((name, size))
        if len(paths) > 250000 or sum(n for _, n in semantic) > 4 * 1024**3:
            raise ValueError('Raw corpus quota exceeded')
        selected = [name for name, _ in semantic]
        if is_seven:
            archive.extract(path=raw, targets=selected)
        else:
            for name in selected:
                archive.extract(name, raw)
    values = [{'path': name, 'sha256': sha((raw / name).read_bytes())} for name in selected]
    receipt.write_text(json.dumps({'sample': sample['id'], 'sha256': sample['sha256'], 'payloadOffset': offset,
                                  'paths': sorted(paths), 'semantic': values}, ensure_ascii=False), encoding='utf-8')
    print(sample['id'], len(paths), 'entries;', len(values), 'semantic files', flush=True)


def geometry(sample):
    target = REPO / 'output/engineering-stage3/corpus-v1' / sample['id']
    receipt = target / 'identity.json'
    saved = json.loads(receipt.read_text(encoding='utf-8'))
    if saved.get('geometry') is not None:
        print(sample['id'], 'existing PHM corpus', flush=True)
        return
    data = (REPO / sample['path']).read_bytes()
    if sha(data) != sample['sha256']:
        raise ValueError('Geometry source package identity mismatch')
    selected = [name for name in saved['paths'] if name.lower().endswith('.phm')]
    with py7zr.SevenZipFile(io.BytesIO(data[sample['payloadOffset']:]), 'r') as archive:
        archive.extract(path=target / 'files', targets=selected)
    saved['geometry'] = [{'path': name, 'sha256': sha((target / 'files' / name).read_bytes())} for name in selected]
    temporary = receipt.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(saved, ensure_ascii=False), encoding='utf-8')
    temporary.replace(receipt)
    print(sample['id'], len(selected), 'PHM files', flush=True)


if __name__ == '__main__':
    corpus = json.loads((REPO / 'desktop/acceptance/engineering/corpus.json').read_text(encoding='utf-8'))
    for entry in corpus['samples']:
        (geometry if '--geometry' in sys.argv else prepare)(entry)
