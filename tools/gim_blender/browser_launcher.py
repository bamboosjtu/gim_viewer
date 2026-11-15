"""Open the local demo outside the GUI process and its frozen DLL search path."""
from __future__ import annotations
import ctypes
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit
from library import write_json


def local_demo_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port or parsed.username or parsed.password:
        raise ValueError('Only this tool\'s localhost demo URL can be opened')
    return url


def split_windows_command(command):
    shell = ctypes.WinDLL('shell32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    shell.CommandLineToArgvW.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
    shell.CommandLineToArgvW.restype = ctypes.POINTER(ctypes.c_wchar_p)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    count = ctypes.c_int()
    pointer = shell.CommandLineToArgvW(command, ctypes.byref(count))
    if not pointer:
        raise OSError(ctypes.get_last_error(), 'Cannot parse default-browser command')
    try:
        return [pointer[i] for i in range(count.value)]
    finally:
        kernel.LocalFree(pointer)


def command_for_url(argv, url):
    if not argv:
        raise ValueError('Empty browser command')
    argv = [os.path.expandvars(part) for part in argv]
    replaced = False
    for index, value in enumerate(argv):
        for token in ['%1', '%l', '%L', '%*']:
            if token in value:
                value = value.replace(token, url)
                replaced = True
        argv[index] = value
    if not replaced:
        argv.append(url)
    return argv


def default_browser_command(url):
    import winreg
    key = r'Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice'
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
        progid = winreg.QueryValueEx(handle, 'ProgId')[0]
    with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, progid+r'\shell\open\command') as handle:
        command = winreg.QueryValueEx(handle, None)[0]
    return command_for_url(split_windows_command(command), url)


def open_demo(url, result_path):
    report = {'ok': False, 'url': url}
    try:
        local_demo_url(url)
        if sys.platform == 'win32':
            # Bootloader DLL search paths must not be inherited by a system app.
            # This is a short-lived helper: changing it cannot race the GUI.
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.SetDllDirectoryW.argtypes = [ctypes.c_wchar_p]
            kernel.SetDllDirectoryW.restype = ctypes.c_int
            if not kernel.SetDllDirectoryW(None):
                raise OSError(ctypes.get_last_error(), 'Cannot reset DLL search directory')
            report['dllDirectoryReset'] = True
            clean_env = {key:value for key,value in os.environ.items()
                         if not key.startswith('_PYI_') and key not in ('TCL_LIBRARY','TK_LIBRARY','PYTHONHOME','PYTHONPATH')}
            bundle = Path(getattr(sys, '_MEIPASS', Path(__file__).parent)).resolve()
            clean_env['PATH'] = os.pathsep.join(value for value in clean_env.get('PATH','').split(os.pathsep)
                                               if value and not Path(value).resolve().is_relative_to(bundle))
            system_directory = Path(os.environ['SystemRoot'])/'System32'
            report['workingDirectorySanitized'] = True
            command = default_browser_command(url)
            profile = Path(result_path).parent.parent/'browser'
            if Path(command[0]).name.casefold() in ('msedge.exe','chrome.exe','chromium.exe','brave.exe','vivaldi.exe'):
                profile.mkdir(parents=True, exist_ok=True)
                # Shell-only --single-argument mode bypasses Chromium's normal
                # option parsing, including the independent profile switch.
                command = [command[0], '--user-data-dir='+str(profile), '--no-first-run', '--no-default-browser-check', url]
                report['profileMode'] = 'tool-managed'
            if not Path(command[0]).is_file():
                raise FileNotFoundError('Default browser executable is unavailable')
            process = subprocess.Popen(command, cwd=system_directory, env=clean_env,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                code = process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                code = None
            if code not in (None, 0):
                raise OSError(f'Default browser exited during startup: {code}')
            report.update(ok=True, method='registered-default-browser', browser=Path(command[0]).name,
                          pid=process.pid, startupExitCode=code)

        else:
            import webbrowser
            report.update(ok=bool(webbrowser.open(url)), method='webbrowser')
            if not report['ok']:
                report['error'] = 'System browser launcher returned false'
    except Exception as exc:
        report['error'] = str(exc)
    write_json(Path(result_path), report)
    return 0 if report['ok'] else 1
