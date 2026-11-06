# -*- coding: utf-8 -*-
"""assemble_two_zxd.py —— 把 substation01 的两台主变中性点成套装置
（87a2fa07=110kV / e45d0eeb=220kV）的文件依赖闭包打成裸 7z .gim，
供 gim_device/tools/test_render.py 单独渲染。
用法：系统Python assemble_two_zxd.py
"""
import os, sys, shutil, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # gim_info
from gim_core import kv

ROOT = 'D:/三维设计/sample/substation01'
DIRS = {}
for sub in ('CBM', 'DEV', 'PHM', 'MOD', 'STL'):
    p = os.path.join(ROOT, sub)
    if os.path.isdir(p):
        DIRS[sub.lower()] = p

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_tmp_zxd')
DEVICES = [
    ('87a2fa07-75ec-40fe-b398-32f58fdd6fd4', 'zxd110kV'),   # GTN*100
    ('e45d0eeb-98c6-4eec-a59d-54e0eb4e38ac', 'zxd220kV'),   # GTN*101
]


def find(ext, uuid):
    d = DIRS.get(ext)
    if not d:
        return None
    p = os.path.join(d, uuid + '.' + ext)
    return p if os.path.isfile(p) else None


def collect(root_cbm):
    """返回 {basename: src_path} 依赖闭包。"""
    files = {}
    todo = []

    def add(ext, name):
        if not name:
            return
        base = os.path.basename(name).lower()
        if base in files:
            return
        stem = base.rsplit('.', 1)[0]
        src = find(ext, stem)
        if src is None:
            print('  ! 缺文件 %s' % base)
            return
        files[base] = src
        todo.append((ext, src))

    cbm_src = find('cbm', root_cbm)
    assert cbm_src, root_cbm
    files[os.path.basename(cbm_src).lower()] = cbm_src
    # fam 顺带（渲染不用，但保持链条完整）
    d = kv(cbm_src)
    for k, v in d.items():
        if 'BASEFAMILY' in k.upper() and v.endswith('.fam'):
            add('fam', v)
        if 'OBJECTMODELPOINTER' in k.upper() and v.endswith('.dev'):
            add('dev', v)
    while todo:
        ext, src = todo.pop()
        if ext == 'dev':
            dk = kv(src)
            for k, v in dk.items():
                ku = k.upper()
                v = v.strip()
                if ku.startswith('SUBDEVICE') and ku != 'SUBDEVICES.NUM' and v.endswith('.dev'):
                    add('dev', v)
                elif (ku.startswith('SOLIDMODEL') or ku.startswith('SOLIDS')) \
                        and not ku.endswith('.NUM'):
                    if v.endswith('.phm'):
                        add('phm', v)
                    elif v.endswith('.mod'):
                        add('mod', v)
                    elif v.endswith('.stl'):
                        add('stl', v)
        elif ext == 'phm':
            pk = kv(src)
            for k, v in pk.items():
                ku = k.upper()
                v = v.strip()
                if not ku.endswith('.NUM') and (ku.startswith('SOLIDMODEL')
                                                or ku.startswith('SOLID')):
                    if v.endswith('.mod'):
                        add('mod', v)
                    elif v.endswith('.stl'):
                        add('stl', v)
                elif 'MODPOINTER' in ku or 'MODLINK' in ku:
                    if v.endswith('.mod'):
                        add('mod', v)
                    elif v.endswith('.stl'):
                        add('stl', v)
    return files


def pack(files, gim_out):
    import py7zr
    with py7zr.SevenZipFile(gim_out, 'w') as z:
        for base, src in files.items():
            z.write(src, arcname=base)


def main():
    os.makedirs(OUT, exist_ok=True)
    for uuid, tag in DEVICES:
        print('==', tag, uuid)
        files = collect(uuid)
        out = os.path.join(OUT, tag + '.gim')
        pack(files, out)
        print('   %d 个文件 -> %s (%.1f KB)' %
              (len(files), out, os.path.getsize(out) / 1024))


if __name__ == '__main__':
    main()
