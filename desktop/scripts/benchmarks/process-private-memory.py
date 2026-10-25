"""Read only an explicitly owned Windows process tree, using PrivateUsage.

Not RSS/working set or GPU VRAM. Failed process queries remain explicit.
"""
import ctypes as c
from ctypes import wintypes as w
import json
import sys

class Entry(c.Structure):
    _fields_=[('size',w.DWORD),('usage',w.DWORD),('pid',w.DWORD),('heap',c.c_size_t),
      ('module',w.DWORD),('threads',w.DWORD),('parent',w.DWORD),('priority',w.LONG),('flags',w.DWORD),('name',w.WCHAR*260)]
class Counters(c.Structure):
    _fields_=[('cb',w.DWORD),('faults',w.DWORD)]+[(name,c.c_size_t) for name in
      ['peakWorkingSet','workingSet','peakPaged','paged','peakNonpaged','nonpaged','pagefile','peakPagefile','private']]

k=c.WinDLL('kernel32',use_last_error=True); p=c.WinDLL('psapi',use_last_error=True)
k.CreateToolhelp32Snapshot.argtypes=[w.DWORD,w.DWORD]; k.CreateToolhelp32Snapshot.restype=w.HANDLE
k.Process32FirstW.argtypes=[w.HANDLE,c.POINTER(Entry)]; k.Process32NextW.argtypes=k.Process32FirstW.argtypes
k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD]; k.OpenProcess.restype=w.HANDLE
k.CloseHandle.argtypes=[w.HANDLE]
p.GetProcessMemoryInfo.argtypes=[w.HANDLE,c.POINTER(Counters),w.DWORD]
root=int(sys.argv[1]); snapshot=k.CreateToolhelp32Snapshot(2,0)
if snapshot==c.c_void_p(-1).value: raise c.WinError(c.get_last_error())
entries=[]; entry=Entry(); entry.size=c.sizeof(entry)
try:
    more=k.Process32FirstW(snapshot,c.byref(entry))
    while more:
        entries.append((entry.pid,entry.parent,entry.name));more=k.Process32NextW(snapshot,c.byref(entry))
finally: k.CloseHandle(snapshot)
owned={root}
while True:
    expanded=owned|{pid for pid,parent,_ in entries if parent in owned}
    if expanded==owned:break
    owned=expanded
rows=[];errors=[]
for pid,parent,name in entries:
    if pid not in owned:continue
    handle=k.OpenProcess(0x0400|0x0010,False,pid)
    if not handle: errors.append({'pid':pid,'error':c.get_last_error()});continue
    try:
        counters=Counters();counters.cb=c.sizeof(counters)
        if not p.GetProcessMemoryInfo(handle,c.byref(counters),counters.cb):errors.append({'pid':pid,'error':c.get_last_error()})
        else:rows.append({'pid':pid,'parent':parent,'name':name,'privateBytes':counters.private,'workingSetBytes':counters.workingSet})
    finally:k.CloseHandle(handle)
valid=not errors and any(row['pid']==root for row in rows)
print(json.dumps({'rootPid':root,'available':valid,'privateBytes':sum(row['privateBytes'] for row in rows) if valid else None,'processes':rows,'errors':errors}))
