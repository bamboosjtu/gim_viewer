"""GUI-side command launcher only. The service runs in a detached Node process."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.request import build_opener, ProxyHandler
from library import application_home, node_runtime, demo_runtime


class ServiceLauncher:
    def __init__(self, home):
        self.home=Path(home).resolve()
        self.status_file=self.home/'data/service/server.json'
        self.log_file=self.home/'data/service/server.log'

    def status(self):
        try:
            saved=json.loads(self.status_file.read_text(encoding='utf-8'))
            if saved['version']!=1 or saved['data']!=str(self.home/'data') or not saved['url'].startswith('http://127.0.0.1:'):
                return None
            with build_opener(ProxyHandler({})).open(saved['url']+'__gim_blender_service__',timeout=.4) as reply:
                current=json.load(reply)
            return saved if current['instance']==saved['instance'] and current['pid']==saved['pid'] else None
        except (OSError,ValueError,KeyError):
            return None

    def launch(self, open_browser=True):
        script=application_home()/'server/server.cjs'
        command=[str(node_runtime()),str(script),'--data',str(self.home/'data'),'--runtime',str(demo_runtime()),'--port','8765']
        if open_browser:command.append('--open')
        self.log_file.parent.mkdir(parents=True,exist_ok=True)
        env={k:v for k,v in os.environ.items() if not k.startswith('_PYI_') and k not in ('TCL_LIBRARY','TK_LIBRARY','PYTHONHOME','PYTHONPATH')}
        kernel=None
        if sys.platform=='win32' and getattr(sys,'frozen',False):
            kernel=ctypes.WinDLL('kernel32',use_last_error=True);kernel.SetDllDirectoryW.argtypes=[ctypes.c_wchar_p];kernel.SetDllDirectoryW(None)
        try:
            with self.log_file.open('ab',buffering=0) as log:
                flags=(subprocess.DETACHED_PROCESS|subprocess.CREATE_NEW_PROCESS_GROUP) if os.name=='nt' else 0
                return subprocess.Popen(command,cwd=self.home,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=flags,close_fds=True)
        finally:
            if kernel:kernel.SetDllDirectoryW(str(sys._MEIPASS))
