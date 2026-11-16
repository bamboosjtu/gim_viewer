"""The tool's source-identified v1 import cache."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
from datetime import datetime, timezone

def resources() -> Path:
    return Path(getattr(sys, '_MEIPASS', Path(__file__).parent)) / 'assets'

def application_home() -> Path:
    return Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent

def node_runtime() -> Path:
    return application_home()/'runtime/node.exe' if getattr(sys, 'frozen', False) else resources()/'runtime/node.exe'

def demo_runtime() -> Path:
    return application_home()/'demo' if getattr(sys, 'frozen', False) else resources()/'web'

def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = path.with_name(path.name + '.staging')
    staging.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    staging.replace(path)

def read_json(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))

def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')

def not_linked(path: Path):
    if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
        raise ValueError('缓存路径不能是符号链接或目录联接：' + str(path))

def remove_owned_tree(folder: Path):
    not_linked(folder)
    for root, dirs, files in os.walk(folder, followlinks=False):
        for name in dirs + files:
            not_linked(Path(root)/name)
    shutil.rmtree(folder)

class Library:
    def __init__(self, home: Path):
        self.home = Path(home).resolve()
        self.data = self.home / 'data'
        self.projects = self.data / 'projects'
        for p in (self.data, self.projects, self.data / 'tmp'):
            not_linked(p)
            p.mkdir(parents=True, exist_ok=True)

    def project(self, identity: str) -> Path:
        if not re.fullmatch('[a-f0-9]{64}', identity):
            raise ValueError('无效的项目身份')
        p = self.projects / identity
        not_linked(p)
        return p

    def entries(self):
        rows = []
        for path in self.projects.iterdir():
            if not re.fullmatch('[a-f0-9]{64}', path.name):
                continue
            not_linked(path)
            try:
                rec = read_json(path / 'project.json')
                if rec.get('version') == 1 and rec.get('id') == path.name:
                    rows.append(rec)
            except (OSError, ValueError):
                continue
        return sorted(rows, key=lambda r: r.get('importedAt', ''), reverse=True)

    def cache(self, source: Path):
        source = Path(source).resolve()
        if source.suffix.lower() != '.gim' or not source.is_file():
            raise ValueError('请选择有效的 .gim 文件')
        # Hash while copying once: source bytes define the cache identity.
        staging = self.data / 'tmp' / ('import-' + os.urandom(8).hex() + '.gim')
        digest = hashlib.sha256()
        try:
            with source.open('rb') as inp, staging.open('xb') as out:
                for block in iter(lambda: inp.read(1024 * 1024), b''):
                    digest.update(block)
                    out.write(block)
            ident = digest.hexdigest()
            folder = self.project(ident)
            previous = read_json(folder / 'project.json') if (folder / 'project.json').exists() else None
            if previous and previous.get('status') in ('ready', 'partial') and self.ready(previous):
                return previous, True
            folder.mkdir(exist_ok=True)
            staging.replace(folder / 'source.gim')
            rec = {'version': 1, 'id': ident, 'sourceName': source.name,
                   'title': (previous or {}).get('title') or source.stem,
                   'sourceBytes': source.stat().st_size, 'status': 'converting',
                   'importedAt': (previous or {}).get('importedAt') or now(), 'updatedAt': now()}
            self.save(rec)
            return rec, False
        finally:
            staging.unlink(missing_ok=True)

    def save(self, rec):
        write_json(self.project(rec['id']) / 'project.json', rec)

    def ready(self, rec):
        folder = self.project(rec['id']) / 'result'
        not_linked(folder)
        not_linked(folder/'web')
        return rec.get('status') in ('ready', 'partial') and all(
            (folder / rel).is_file() for rel in ['project.blend', 'web/index.html', 'web/assets/world.glb', 'web/assets/scene.json'])

    def delete(self, ident):
        folder = self.project(ident)
        if not (folder / 'project.json').is_file():
            raise ValueError('这不是已导入的项目目录')
        # Check the complete owned tree before recursive deletion on Windows.
        remove_owned_tree(folder)
