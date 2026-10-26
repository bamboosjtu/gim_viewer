# -*- coding: utf-8 -*-
"""survey_prim.py —— 抽样调研通用模型库 gim 的内部结构与 primitive 类型分布"""
import os, sys, json, random, collections, tempfile, shutil
import xml.etree.ElementTree as ET
import py7zr

ROOT = r'D:/三维设计/相关规范'
SKIP = {'TransformMatrix', 'Color', 'Device', 'Entities', 'Entity'}


def unpack_to(gim_path, out_dir):
    """返回 (魔数, 文件名列表)"""
    with open(gim_path, 'rb') as f:
        head = f.read(8)
    magic = head.rstrip(b'\x00').decode('ascii', errors='replace')[:8]
    src = gim_path
    if magic.startswith('GIMPKG'):
        with open(gim_path, 'rb') as f:
            f.read(8); f.read(768)
            blob = f.read(4096)
        off = blob.find(b'7z\xbc\xaf\x27\x1c')
        if off < 0:
            return magic, [], None
        start = 8 + 768 + off
        tmp = os.path.join(out_dir, '_payload.7z')
        with open(gim_path, 'rb') as f, open(tmp, 'wb') as o:
            f.seek(start)
            shutil.copyfileobj(f, o)
        src = tmp
    with py7zr.SevenZipFile(src) as z:
        names = z.getnames()
        z.extractall(out_dir)
    return magic, names, src


def main():
    random.seed(7)
    all_gim = []
    for base in ('2018', '2025'):
        for dirpath, _, files in os.walk(os.path.join(ROOT, base)):
            for fn in files:
                if fn.lower().endswith('.gim'):
                    all_gim.append(os.path.join(dirpath, fn))
    print(f'样本库 gim 总数: {len(all_gim)}')

    # 按类别分层抽样
    by_cat = collections.defaultdict(list)
    for p in all_gim:
        rel = os.path.relpath(p, ROOT).split(os.sep)
        by_cat[rel[1] if len(rel) > 2 else rel[0]].append(p)

    sample = []
    for cat, paths in by_cat.items():
        sample.extend(random.sample(paths, min(3, len(paths))))
    print(f'抽样: {len(sample)} 个（{len(by_cat)} 类，每类至多 3 个）\n')

    stats = collections.Counter()
    prims = collections.Counter()
    containers = collections.Counter()
    ent_counts = []
    notes = []
    fails = []

    for p in sample:
        tmpd = tempfile.mkdtemp(prefix='gimsurvey_')
        try:
            magic, names, _ = unpack_to(p, tmpd)
            containers[magic[:7]] += 1
            mods = [n for n in names if n.lower().endswith('.mod')]
            if not mods:
                notes.append(f'无 mod: {os.path.basename(p)}')
                continue
            for nm in mods:
                mp = os.path.join(tmpd, nm.replace('/', os.sep))
                if not os.path.exists(mp):
                    continue
                try:
                    root = ET.parse(mp).getroot()
                except Exception as e:
                    fails.append(f'{os.path.basename(p)}: XML {type(e).__name__}')
                    continue
                n_ent = 0
                for e in root.iter('Entity'):
                    n_ent += 1
                    kids = [c.tag for c in e if c.tag not in SKIP]
                    if kids:
                        prims[kids[0]] += 1
                    else:
                        prims['(空)'] += 1
                ent_counts.append(n_ent)
        except Exception as e:
            fails.append(f'{os.path.basename(p)}: {type(e).__name__} {str(e)[:60]}')
        finally:
            shutil.rmtree(tmpd, ignore_errors=True)

    print('=== 容器魔数 ===')
    for k, v in containers.most_common():
        print(f'  {k!r:12s} {v}')
    print(f'\n=== primitive 类型分布（共 {sum(prims.values())} 个 Entity）===')
    for k, v in prims.most_common():
        print(f'  {k:28s} {v:6d}')
    print(f'\n=== 单文件实体数 ===')
    if ent_counts:
        ent_counts.sort()
        print(f'  min {ent_counts[0]}  median {ent_counts[len(ent_counts)//2]}  max {ent_counts[-1]}  n={len(ent_counts)}')
    if notes:
        print('\n=== 备注 ===')
        for n in notes[:10]:
            print('  ', n)
    if fails:
        print('\n=== 失败 ===')
        for n in fails[:10]:
            print('  ', n)

    json.dump({'prims': dict(prims), 'containers': dict(containers)},
              open(r'D:/三维设计/data/survey_prims.json', 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
