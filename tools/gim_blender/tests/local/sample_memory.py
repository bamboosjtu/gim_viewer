"""Read only the explicitly owned browser process tree for a local probe."""
import json
from pathlib import Path
import sys,time
import psutil
pid_file=Path(sys.argv[1])
with Path(sys.argv[2]).open('w',encoding='utf-8',buffering=1) as stream:
    while True:
        try:pids=json.loads(pid_file.read_text(encoding='utf-8'))
        except (OSError,ValueError):time.sleep(.1);continue
        private=0;available=0;unavailable=0
        for pid in pids:
            try:
                process=psutil.Process(pid)
                info=process.memory_info()
                private+=getattr(info,'private',info.rss)
                available+=1
            except (psutil.NoSuchProcess,psutil.AccessDenied):
                unavailable+=1
        stream.write(json.dumps({'time':time.monotonic(),'privateBytes':private,'processes':available,'unavailable':unavailable})+'\n')
        time.sleep(.25)
