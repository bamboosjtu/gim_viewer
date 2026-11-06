# -*- coding: utf-8 -*-
"""diag —— 诊断日志（写入 %TEMP%/gim_reader.log，无控制台模式也可排查）。"""
import os, time, tempfile

LOG_PATH = os.path.join(tempfile.gettempdir(), 'gim_reader.log')

def _log(msg):
    try:
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write('[%s] %s\n' % (time.strftime('%m-%d %H:%M:%S'), msg))
    except Exception:
        pass
