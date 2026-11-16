"""Independent conversion worker. All mutable files belong to one data/ project."""
from __future__ import annotations
import importlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import runpy
import shutil
import subprocess
import sys
import tempfile
from library import Library, resources, read_json, write_json, now, remove_owned_tree, node_runtime, demo_runtime

SIG7Z = bytes.fromhex('377abcaf271c')

def progress(index, text):
    print('@progress ' + json.dumps({'step': index, 'total': 8, 'text': text}, ensure_ascii=False), flush=True)

def find_blender(home: Path):
    configured = os.environ.get('GIM_BLENDER_EXE')
    candidates = [Path(configured)] if configured else []
    candidates += [home/'runtime/blender/blender.exe', home/'blender/blender.exe']
    found = shutil.which('blender')
    if found:
        candidates.append(Path(found))
    for parent in [Path(os.environ.get('ProgramFiles', 'C:/Program Files'))/'Blender Foundation', Path('C:/Tools')]:
        if parent.is_dir():
            candidates += sorted(parent.glob('*/blender.exe'), reverse=True)
    return next((p.resolve() for p in candidates if p.is_file()), None)

def run(command, env, cwd, timeout=None):
    print('> ' + ' '.join(map(str, command)), flush=True)
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    process = subprocess.Popen(list(map(str, command)), cwd=cwd, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', creationflags=flags)
    try:
        for line in process.stdout:
            print(line.rstrip(), flush=True)
        code = process.wait(timeout=timeout)
    except BaseException:
        process.kill()
        process.wait()
        raise
    if code:
        raise RuntimeError(f'转换子进程退出：{code}；请查看 data 中本次导入日志')

def python_stage(name, argv=()):
    script_dir = resources()/'scripts'
    if str(script_dir) not in sys.path:
        sys.path.insert(0, str(script_dir))
    old = sys.argv
    try:
        sys.argv = [str(script_dir/name), *map(str, argv)]
        runpy.run_path(str(script_dir/name), run_name='__main__')
    finally:
        sys.argv = old

def extraction_root(folder):
    matches = [p for p in folder.rglob('*') if p.is_file() and p.name.casefold() == 'project.cbm']
    if not matches:
        raise ValueError('文件中没有 project.cbm，当前工具需要变电站工程 GIM')
    depth = min(len(p.parts) for p in matches)
    matches = [p for p in matches if len(p.parts) == depth]
    if len(matches) != 1:
        raise ValueError('GIM 中存在多个工程根，无法唯一确定')
    parent = matches[0].parent
    return parent.parent if parent.name.casefold() == 'cbm' else parent

def extract(source, work):
    import py7zr
    raw = source.read_bytes()
    if raw[:7] not in (b'GIMPKGS', b'GIMPKGT') and not raw.startswith(SIG7Z):
        raise ValueError('不支持的 GIM 容器标识')
    at = raw.find(SIG7Z)
    if at < 0:
        raise ValueError('GIM 中未找到 7z 数据，文件可能已损坏')
    payload = work/'source.7z'
    payload.write_bytes(raw[at:])
    folder = work/'extracted'
    folder.mkdir()
    with py7zr.SevenZipFile(payload, 'r') as archive:
        for item in archive.list():
            name = item.filename.replace('\\', '/')
            p = PurePosixPath(name)
            if p.is_absolute() or '..' in p.parts or ':' in name or getattr(item, 'is_symlink', False):
                raise ValueError('归档中存在非法路径或链接')
        archive.extractall(folder)
    return extraction_root(folder)

def nav_bounds(ifc, placements):
    import re
    files = [f for f in ifc.get('files', []) if f.get('bounds') and
             all(isinstance(x, (int, float)) and math.isfinite(x) for x in f['bounds']) and
             not re.search('总图|总平面|site|masterplan|道路', f.get('file', ''), re.I)]
    box = [min(f['bounds'][k] for f in files) for k in range(3)] + [max(f['bounds'][k+3] for f in files) for k in range(3)] if files else ifc.get('bounds')
    lo = list(box[:3]) if box else [math.inf]*3
    hi = list(box[3:]) if box else [-math.inf]*3
    for item in placements:
        m = item.get('matrix', [])
        if len(m) == 16:
            for k in (0, 1):
                lo[k] = min(lo[k], m[12+k]/1000)
                hi[k] = max(hi[k], m[12+k]/1000)
    if not all(math.isfinite(x) for x in [*lo[:2], *hi[:2]]):
        raise ValueError('未找到可用的工程空间范围')
    result = [math.floor(lo[0]-20), math.floor(lo[1]-20), math.ceil(hi[0]+20), math.ceil(hi[1]+20)]
    return result

def convert(home, source):
    library = Library(Path(home))
    progress(0, '正在缓存 GIM')
    rec, cached = library.cache(Path(source))
    if cached:
        progress(8, '该文件已导入，使用现有结果')
        return rec
    folder = library.project(rec['id'])
    work = folder/'work'
    try:
        template = demo_runtime()
        if not (template/'index.html').is_file():
            raise FileNotFoundError('工具缺少网页资源 demo/index.html，请完整解压程序包后重试；GIM 已缓存，无需删除。')
        blender = find_blender(library.home)
        if not blender:
            raise ValueError('未找到 Blender。请安装 Blender，或将便携版放在程序旁 runtime/blender/ 下，然后重新导入。也可设置 GIM_BLENDER_EXE。')
        node = node_runtime()
        if not node.is_file():
            node = Path(shutil.which('node') or '')
        if not node.is_file():
            raise ValueError('工具缺少 Node 运行资源，请使用完整目录包')
        # A retry uses a fresh, owned work directory. No old format migration.
        if work.exists():
            remove_owned_tree(work)
        for sub in ['temp', 'build', 'renders', 'web', 'blender/config', 'blender/scripts', 'blender/datafiles', 'blender/extensions']:
            (work/sub).mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env.update({'TEMP': str(work/'temp'), 'TMP': str(work/'temp'), 'TMPDIR': str(work/'temp'),
                    'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONIOENCODING': 'utf-8',
                    'GIM_BLENDER_BUILD': str(work/'build'), 'GIM_BLENDER_WEB': str(work/'web'),
                    'GIM_BLENDER_RENDERS': str(work/'renders'), 'GIM_BLENDER_GIM_LOD': '0',
                    'GIM_BLENDER_SOURCE_NAME': rec['sourceName'], 'GIM_BLENDER_SKIP_RENDERS': '1',
                    'GIM_BLENDER_PROFILE': str(work/'build/profile.json'),
                    'BLENDER_USER_CONFIG': str(work/'blender/config'), 'BLENDER_USER_SCRIPTS': str(work/'blender/scripts'),
                    'BLENDER_USER_DATAFILES': str(work/'blender/datafiles'), 'BLENDER_USER_EXTENSIONS': str(work/'blender/extensions')})
        os.environ.update(env)
        tempfile.tempdir = str(work/'temp')
        progress(1, '正在解包工程')
        root = extract(folder/'source.gim', work)
        env['GIM_BLENDER_EXTRACT'] = str(root)
        os.environ.update(env)
        progress(2, '正在解析设备装配与几何')
        python_stage('extract_gim.py')
        run([node, resources()/'node/export_gim.mjs'], env, work)
        progress(3, '正在解析建筑与场地')
        run([node, resources()/'node/probe_ifc_bounds.cjs'], env, work)
        build = work/'build'
        graph = read_json(build/'gim_placements.json')
        bounds = nav_bounds(read_json(build/'ifc_bounds.json'), graph['placements'])
        env['GIM_BLENDER_NAV_BOUNDS'] = ','.join(map(str, bounds))
        os.environ.update(env)
        progress(4, '正在生成碰撞、楼面与门')
        run([node, resources()/'node/export_ifc.cjs'], env, work)
        ifc = read_json(build/'ifc_scene.json')
        gim = read_json(build/'gim_scene.json')
        inventory = read_json(build/'ifc_bounds.json')
        if graph['counts']['missing'] or graph['counts']['cycles'] or gim['stats']['skipped']:
            raise ValueError('工程存在缺失引用、循环或未完成几何，未发布漫游结果')
        if set(ifc.get('files', {})) != {f['file'] for f in inventory['files']}:
            raise ValueError('IFC 来源覆盖不完整，未发布漫游结果')
        if ifc['counts']['triangles'] + gim['stats']['tris'] == 0:
            raise ValueError('工程中没有可显示的几何')
        python_stage('derive_profile.py', ['--build', build, '--source', rec['sourceName'], '--slug', 'project'])
        identity = importlib.import_module('project_identity').describe_project(folder/'source.gim', root, source_sha256=rec['id'])
        write_json(build/'identity.json', identity)
        rec['title'] = identity['displayName']
        library.save(rec)
        progress(5, '正在生成 Blender 与 GLB')
        run([blender, '-b', '--factory-startup', '--python', resources()/'scripts/build_scene.py'], env, work)
        progress(6, '正在生成 HTML 与设备碰撞')
        shutil.copytree(template, work/'web', dirs_exist_ok=True)
        python_stage('prepare_web_assets.py')
        progress(7, '正在发布本地结果')
        result = work/'result.staging'
        result.mkdir()
        for name in ['project.blend', 'project.glb']:
            shutil.copy2(build/name, result/name)
        shutil.copytree(work/'web', result/'web')
        scene = read_json(result/'web/assets/scene.json')
        rec.update(status='partial' if scene['geometry']['status']=='partial' else 'ready',
                   updatedAt=now(), counts=scene['counts'], geometry=scene['geometry'], error=None,
                   projectInfo=identity, runtime=scene['buildVersion'])
        manifest = {'version': 1, 'sourceSha256': rec['id'], 'sourceName': rec['sourceName'],
                    'compilerDataVersion': 'gim-blender-v1', 'navBounds': bounds, 'counts': rec['counts'],
                    'ifcFiles': list(ifc['files']), 'geometry': rec['geometry'],
                    'outputs': {'blender': 'project.blend', 'html': 'web/index.html', 'glb': 'project.glb'}}
        if 'viewerParity' in gim:
            manifest['assemblyParity'] = gim['viewerParity']
        write_json(result/'manifest.json', manifest)
        if (folder/'result').exists():
            remove_owned_tree(folder/'result')
        result.replace(folder/'result')
        library.save(rec)
        progress(8, '导入完成' if rec['status']=='ready' else '导入完成，部分几何为浏览近似')
        return rec
    except BaseException as exc:
        rec.update(status='error', error=str(exc), updatedAt=now())
        library.save(rec)
        raise
