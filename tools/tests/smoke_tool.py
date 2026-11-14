"""Exercise each actual directory package using generated inputs, never demo/ data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile

from PyInstaller.archive.readers import CArchiveReader
from fixtures import device_sources, information_sources, write_sources, write_zip

ROOT = Path(__file__).resolve().parents[2]
_TEMP = ROOT / 'tmp/tests/tools-smoke'
_TEMP.mkdir(parents=True,exist_ok=True)
os.environ.update(TEMP=str(_TEMP),TMP=str(_TEMP),TMPDIR=str(_TEMP))
EXES = {'gim_device': 'GIM设备查看器.exe', 'gim_element': 'GIM实体盘点器.exe',
        'gim_info': 'GIM信息阅读器.exe'}


def digest(stream):
    result = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        result.update(block)
    return result.hexdigest()


def run_owned(command, out, env, timeout=120):
    process = subprocess.Popen(command, cwd=out, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace',
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            process.kill()
        output, _ = process.communicate()
        (out / 'process.log').write_text(output, encoding='utf-8')
        raise RuntimeError(f'Owned smoke process timed out: {command}')
    with (out / 'process.log').open('a', encoding='utf-8') as log:
        log.write(output)
    if process.returncode:
        raise RuntimeError(f'Smoke process failed ({process.returncode}): {command}\n{output}')


def verify_package(tool, exe):
    archive = CArchiveReader(str(exe))
    forbidden = {'icuuc.dll', 'icuin.dll', 'icudt.dll', 'icu.dll'}
    names = {name.replace('\\', '/').rsplit('/', 1)[-1].lower() for name in [*archive.toc,*[str(p) for p in (exe.parent/'_internal').rglob('*')]]}
    if names & forbidden:
        raise AssertionError(f'Unexpected ICU DLLs: {names & forbidden}')
    if tool == 'gim_device':
        for name in ['viewer_shell.html', 'three.min.js', 'OrbitControls.js']:
            assert (exe.parent/'_internal'/name).read_bytes(), f'Embedded renderer asset missing: {name}'
        assert 'qtwebengineprocess.exe' in names, 'QtWebEngine child executable missing'
    if tool == 'gim_element':
        assert hashlib.sha256((exe.parent/'_internal/catalog.json').read_bytes()).hexdigest() == hashlib.sha256(
            (ROOT / 'tools/gim_element/catalog.json').read_bytes()).hexdigest()
    with exe.open('rb') as stream:
        sha = digest(stream)
    bundle = exe.parent.with_suffix('.zip')
    with zipfile.ZipFile(bundle) as zipped:
        assert any('/_internal/' in n for n in zipped.namelist()), 'ZIP dependencies missing'
        with zipped.open(exe.parent.name+'/'+exe.name) as stream:
            assert digest(stream) == sha, 'ZIP executable differs from the tested EXE'
    return {'exeSha256': sha, 'exeBytes': exe.stat().st_size, 'zipBytes': bundle.stat().st_size}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--tool', choices=EXES, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    for name in ['device.png.json', 'packaged.png.json', 'browse-selftest.json',
                 'device.png', 'packaged.png', '_browse.png', '_chain_view.png', '_xml_view.png']:
        (out / name).unlink(missing_ok=True)
    (out / 'ci-receipt.json').write_text(json.dumps({'passed': False, 'tool': args.tool}), encoding='utf-8')
    (out / 'process.log').write_text('', encoding='utf-8')
    exe = ROOT / 'tools' / args.tool / 'dist' / Path(EXES[args.tool]).stem / EXES[args.tool]
    package = verify_package(args.tool, exe)
    env = {**os.environ, 'PYTHONUTF8': '1', 'QT_QPA_PLATFORM': 'offscreen',
           'QTWEBENGINE_CHROMIUM_FLAGS': '--ignore-gpu-blocklist --enable-unsafe-swiftshader '
                                        '--disable-background-timer-throttling --disable-renderer-backgrounding'}
    if os.name == 'nt':
        env['QT_QPA_FONTDIR'] = str(Path(os.environ['WINDIR']) / 'Fonts')
        if args.tool == 'gim_device':
            # WebEngine uses a native surface outside the screen; suppressing
            # the QPA surface would prevent the actual WebGL smoke contract.
            env['QT_QPA_PLATFORM'] = 'windows'
    if args.tool == 'gim_info':
        runtime_log = out / 'info-runtime.log'
        runtime_log.write_text('', encoding='utf-8')
        env['GIM_READER_LOG_PATH'] = str(runtime_log)
    run_owned([str(exe), '--self-check'], out, env, timeout=60)
    if args.tool == 'gim_element':
        run_owned([os.sys.executable, str(ROOT / 'tools/gim_element/smoke_packaged.py'), '--out', str(out)], out, env)
        evidence = json.loads((out / 'packaged.png.json').read_text(encoding='utf-8'))
        assert evidence['frozen'] and evidence['totals']['设备']['台数'] == 1
    elif args.tool == 'gim_device':
        fixture = write_zip(out / 'device.gim', device_sources())
        png = out / 'device.png'
        run_owned([str(exe), '--smoke', str(fixture), str(png)], out, env)
        evidence = json.loads(Path(str(png) + '.json').read_text(encoding='utf-8'))
        assert evidence['ok'] and evidence['frozen'], evidence
        assert evidence['stats']['meshes'] == 2 and evidence['stats']['triangles'] > 0, evidence
        assert png.read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
    else:
        fixture = write_sources(out / 'source', information_sources())
        run_owned([str(exe), '--smoke', str(fixture)], out, env)
        run_owned([str(exe), '--guitest', str(fixture)], out, env)
        evidence = json.loads((out / 'browse-selftest.json').read_text(encoding='utf-8'))
        assert evidence['ok'] and evidence['frozen'] and evidence['ambiguous'] == 2, evidence
        assert evidence['rootChildren'] == 2 and evidence['historyEntries'] >= 2, evidence
        for name in ['_browse.png', '_chain_view.png', '_xml_view.png']:
            assert (out / name).read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
    receipt = {'passed': True, 'tool': args.tool, 'commit': os.environ.get('GITHUB_SHA'),
               **package, 'evidence': evidence}
    (out / 'ci-receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
