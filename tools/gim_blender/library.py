"""The tool's v1 cache and localhost-only serving boundary."""
from __future__ import annotations
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shutil
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

def resources() -> Path:
    return Path(getattr(sys, '_MEIPASS', Path(__file__).parent)) / 'assets'

def application_home() -> Path:
    return Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent

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

    def catalog_html(self):
        cards = []
        for rec in self.entries():
            if not self.ready(rec):
                continue
            title = html.escape(rec['title'])
            partial = '<span class="badge">部分表示</span>' if rec['status'] == 'partial' else ''
            cards.append(f'<a class="card" href="/{rec["id"]}/index.html" data-level="{rec["id"]}">'
                         f'<span class="badge">变电站巡检</span>{partial}<h2>{title}</h2>'
                         '<p>从整站大门出发，步行巡视设备区，开门进入建筑。</p><b>进入漫游 →</b></a>')
        return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width,initial-scale=1">'
                '<title>GIM Blender · 变电站巡检</title><link rel="icon" href="data:,">'
                '<link rel="stylesheet" href="/catalog.css"><main id="catalog-welcome">'
                '<small>GIM BLENDER / VIRTUAL INSPECTION</small><h1>走进一座<span>变电站</span></h1>'
                '<p>选择工程，从整站大门开始第一人称模拟巡视。Esc 暂停并释放鼠标。</p>'
                '<div class="controls">WASD 行走　鼠标 环顾　E 开关门　Space 跳跃　M 地图　R 返回大门　Q 返回工程选择</div>'
                '<section>' + ''.join(cards) + '</section></main>'
                '<button id="catalog-back" hidden>← 返回工程选择 (Q)</button>'
                '<script src="/catalog.js"></script></html>').encode('utf-8')

class DemoServer:
    def __init__(self, library: Library):
        self.library = library
        self.server = None
        self.thread = None
        self.on_html_request = None
        self.page_requested = threading.Event()

    def start(self):
        if self.server:
            return self.url
        library = self.library
        class Handler(SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                route = unquote(urlsplit(self.path).path)
                if route in ('/', '/index.html'):
                    body = library.catalog_html()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html; charset=utf-8')
                    self.send_header('Content-Length', str(len(body)))
                    self.send_header('Cache-Control', 'no-store')
                    self.end_headers()
                    self.wfile.write(body)
                    if self.headers.get('User-Agent', '').startswith('Mozilla/'):
                        owner.page_requested.set()
                    if owner.on_html_request:
                        owner.on_html_request({'route':route, 'userAgent':self.headers.get('User-Agent', '')})
                    return
                pieces = route.strip('/').split('/')
                folder = None
                if route in ('/catalog.js', '/catalog.css'):
                    folder = resources() / 'catalog'
                    pieces = [pieces[0]]
                elif len(pieces) > 1 and re.fullmatch('[a-f0-9]{64}', pieces[0]):
                    project = library.project(pieces.pop(0))
                    try:
                        if library.ready(read_json(project / 'project.json')):
                            # Runtime belongs to the installed tool; geometry
                            # belongs to the source-identified import. Updating
                            # controls/rendering must not require reconversion.
                            folder = resources()/'web' if pieces[0] in ('js','css','vendor') else project/'result/web'
                    except (OSError, ValueError):
                        pass
                if folder is None or any(x in ('', '.', '..') or '\\' in x or ':' in x for x in pieces):
                    self.send_error(404)
                    return
                target = folder.joinpath(*pieces)
                if not target.resolve().is_relative_to(folder.resolve()) or not target.is_file():
                    self.send_error(404)
                    return
                # No directory listings, original GIM, work files or write APIs.
                try:
                    with target.open('rb') as inp:
                        self.send_response(200)
                        content_type = {'.js': 'application/javascript', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary'}.get(target.suffix, self.guess_type(str(target)))
                        self.send_header('Content-Type', content_type)
                        self.send_header('Content-Length', str(target.stat().st_size))
                        self.send_header('Cache-Control', 'no-cache')
                        self.end_headers()
                        shutil.copyfileobj(inp, self.wfile)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_HEAD(self):
                self.send_error(405)
        owner = self
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.url = 'http://127.0.0.1:' + str(self.server.server_port) + '/'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self.url

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.server = None
