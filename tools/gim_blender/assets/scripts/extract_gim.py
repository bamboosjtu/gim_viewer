"""Extract GIM substation01 assembly graph, placements and system labels.

No third-party dependencies. Writes build/gim_placements.json for inspection.
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter, defaultdict
from archive_index import archive_index

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXTRACT = os.environ.get('GIM_BLENDER_EXTRACT', os.path.join(ROOT, 'extracted'))
BUILD = os.environ.get('GIM_BLENDER_BUILD', os.path.join(ROOT, 'build'))
IDENTITY = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]


def read_text(path: str) -> str:
    with open(path, 'rb') as f:
        b = f.read()
    if b.startswith(b'\xef\xbb\xbf'):
        b = b[3:]
    try:
        return b.decode('utf-8')
    except UnicodeDecodeError:
        return b.decode('gb18030', 'replace')


def parse_kv(text: str) -> dict[str, str]:
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or '=' not in line:
            continue
        k, v = line.split('=', 1)
        if re.match(r'^[A-Za-z][A-Za-z0-9_.]*$', k):
            out[k] = v
    return out


GIM_EMPTY_SENTINELS = {'', '/', '-', 'null'}


def is_gim_empty(value) -> bool:
    if value is None:
        return True
    return str(value).strip().lower() in GIM_EMPTY_SENTINELS


def parse_matrix(text: str) -> list[float]:
    try:
        vals = [float(x) for x in re.split(r'[,\s]+', text.strip()) if x]
    except ValueError:
        return IDENTITY.copy()
    if len(vals) != 16 or any(not (abs(v) < 1e12) for v in vals):
        return IDENTITY.copy()
    return vals


def mat_mul(a: list[float], b: list[float]) -> list[float]:
    """Column-major 4x4, returns a*b."""
    r = [0.0] * 16
    for c in range(4):
        for row in range(4):
            r[c * 4 + row] = sum(a[k * 4 + row] * b[c * 4 + k] for k in range(4))
    return r


def mat_point(m: list[float], p):
    x, y, z = p
    return (
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    )


def lookup(name: str) -> str | None:
    return archive_index(EXTRACT).resolve(name)


CBM_DIR = os.path.join(EXTRACT, 'CBM')
DEV_DIR = os.path.join(EXTRACT, 'DEV')
PHM_DIR = os.path.join(EXTRACT, 'PHM')
MOD_DIR = os.path.join(EXTRACT, 'MOD')


class Graph:
    def __init__(self):
        self.index = archive_index(EXTRACT)
        self.cbm_cache = {}
        self.dev_cache = {}
        self.phm_cache = {}
        self.placements = []
        self.geometry_leaves = []
        self.missing = []
        self.dev_instances = 0
        self.phm_instances = 0
        self.cycles = 0
        self.system_stack = []
        self.max_depth = 0

    def resolve(self, filename, kind):
        try:
            p = self.index.resolve(filename)
        except ValueError:
            self.missing.append(('ambiguous-' + kind, filename))
            return None
        if p is None:
            self.missing.append((kind, filename))
        return p

    def cbm(self, filename):
        p = self.resolve(filename, 'cbm')
        if p is None:
            return None
        if p not in self.cbm_cache:
            self.cbm_cache[p] = parse_kv(read_text(p))
        return self.cbm_cache[p]

    def walk_cbm(self, filename, parent_m, depth=0, inherited_label=''):
        if depth > 64:
            self.cycles += 1
            return
        d = self.cbm(filename)
        if d is None:
            return
        self.max_depth = max(self.max_depth, depth)
        entity = d.get('ENTITYNAME', '')
        # The gim_viewer treats a real CBM node's TRANSFORMMATRIX as the
        # cumulative/absolute placement. Only DEV_SUBDEVICE virtual nodes carry
        # a local matrix. The source graph's root matrices are therefore used
        # as-is; an absent matrix inherits the nearest effective parent matrix.
        own = d.get('TRANSFORMMATRIX')
        m = parse_matrix(own) if own else parent_m
        label = inherited_label
        sys_names = [d.get(k, '') for k in ('SYSTEMNAME1', 'SYSTEMNAME2', 'SYSTEMNAME3', 'SYSTEMNAME4')]
        sys_names = [s for s in sys_names if s]
        if sys_names:
            label = '/'.join(sys_names)
        devref = d.get('OBJECTMODELPOINTER')

        if devref:
            # Physical geometry roots are real device CBM nodes. PARTINDEX is a
            # semantic parts index; its DEV is already expanded as a SUBDEVICE
            # of the owning F4 assembly. The viewer excludes it
            # (isSubstationGeometryRoot) and does not recurse CBM SUBDEVICES
            # when a DEV entry exists.
            if entity.upper() not in ('PARTINDEX', 'DEV_SUBDEVICE'):
                node = {
                    'file': filename,
                    'entity': entity,
                    'class': d.get('SYSCLASSIFYNAME', ''),
                    'label': label,
                    'matrix': m,
                    'dev': devref,
                    'ifc': d.get('IFCFILE', ''),
                    'ifcGuid': d.get('IFCGUID', ''),
                }
                self.placements.append(node)
                self.walk_dev(devref, m, label, depth, [])
            # SUBSYSTEMS remain CBM structure edges; SUBDEVICES are DEV parts
            # and are not geometry roots for this node.
            for i in range(int(d.get('SUBSYSTEMS.NUM') or 0)):
                child = d.get(f'SUBSYSTEM{i}')
                if child:
                    self.walk_cbm(child, m, depth + 1, label)
            return

        for i in range(int(d.get('SUBSYSTEMS.NUM') or 0)):
            child = d.get(f'SUBSYSTEM{i}')
            if child:
                self.walk_cbm(child, m, depth + 1, label)
        for i in range(int(d.get('SUBDEVICES.NUM') or 0)):
            child = d.get(f'SUBDEVICE{i}')
            if child and child.lower().endswith('.cbm'):
                self.walk_cbm(child, m, depth + 1, label)

    def dev(self, filename):
        p = self.resolve(filename, 'dev')
        if p is None:
            return None
        if p not in self.dev_cache:
            text = read_text(p)
            self.dev_cache[p] = self._parse_dev(text)
        return self.dev_cache[p]

    def _parse_dev(self, text):
        d = parse_kv(text)
        # Match desktop/src/gim/geometry/devParser.ts: each block owns its own
        # indexed TRANSFORMMATRIX slots. A matrix is only attached when the
        # corresponding SOLIDMODELn/SUBDEVICEn slot exists at that source index.
        try:
            solid_count = int(d.get('SOLIDMODELS.NUM') or 0)
        except ValueError:
            solid_count = 0
        try:
            sub_count = int(d.get('SUBDEVICES.NUM') or 0)
        except ValueError:
            sub_count = 0
        solid_slots = [None] * max(0, min(solid_count, 100000))
        sub_slots = [None] * max(0, min(sub_count, 100000))
        mode = None
        for line in text.splitlines():
            line = line.strip()
            if not line or '=' not in line:
                continue
            k, v = line.split('=', 1)
            ku = k.upper()
            if ku == 'SOLIDMODELS.NUM':
                mode = 'solid'
                continue
            if ku == 'SUBDEVICES.NUM':
                mode = 'sub'
                continue
            m_solid = re.fullmatch(r'SOLIDMODEL(\d+)', ku)
            if m_solid:
                idx = int(m_solid.group(1))
                mode = 'solid'
                if 0 <= idx < len(solid_slots) and not is_gim_empty(v):
                    solid_slots[idx] = {'ref': v.strip(), 'matrix': IDENTITY.copy()}
                continue
            m_sub = re.fullmatch(r'SUBDEVICE(\d+)', ku)
            if m_sub:
                idx = int(m_sub.group(1))
                mode = 'sub'
                if 0 <= idx < len(sub_slots) and not is_gim_empty(v):
                    sub_slots[idx] = {'ref': v.strip(), 'matrix': IDENTITY.copy()}
                continue
            m_tm = re.fullmatch(r'TRANSFORMMATRIX(\d+)', ku)
            if m_tm:
                idx = int(m_tm.group(1))
                matrix = parse_matrix(v)
                if mode == 'solid' and 0 <= idx < len(solid_slots) and solid_slots[idx]:
                    solid_slots[idx]['matrix'] = matrix
                elif mode == 'sub' and 0 <= idx < len(sub_slots) and sub_slots[idx]:
                    sub_slots[idx]['matrix'] = matrix
        solids = [s for s in solid_slots if s]
        subs = [s for s in sub_slots if s]
        return {'meta': d, 'solids': solids, 'subs': subs}

    def walk_dev(self, filename, m, label, depth, stack):
        if filename in stack or depth > 64:
            self.cycles += 1
            return
        d = self.dev(filename)
        if d is None:
            return
        self.dev_instances += 1
        for s in d['solids']:
            self.walk_solid(s['ref'], mat_mul(m, s['matrix']), label, depth + 1, stack + [filename], '')
        for s in d['subs']:
            self.walk_dev(s['ref'], mat_mul(m, s['matrix']), label, depth + 1, stack + [filename])

    def phm(self, filename):
        p = self.resolve(filename, 'phm')
        if p is None:
            return None
        if p not in self.phm_cache:
            text = read_text(p)
            d = parse_kv(text)
            # Match desktop/src/gim/geometry/phmParser.ts: SOLIDSn and
            # SOLIDMODELn are independent groups, each with its own indexed
            # TRANSFORMMATRIXn and COLORn.
            groups = [
                {'prefix': 'SOLIDS', 'count': 0, 'refs': {}, 'mats': {}, 'colors': {}},
                {'prefix': 'SOLIDMODELS', 'count': 0, 'refs': {}, 'mats': {}, 'colors': {}},
            ]
            for gi, group in enumerate(groups):
                try:
                    group['count'] = int(d.get(group['prefix'] + '.NUM') or 0)
                except ValueError:
                    group['count'] = 0
            active = 1
            for line in text.splitlines():
                line = line.strip()
                if not line or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                ku = k.upper()
                if ku == 'SOLIDS.NUM':
                    active = 0
                    continue
                if ku == 'SOLIDMODELS.NUM':
                    active = 1
                    continue
                m_solids = re.fullmatch(r'SOLIDS(\d+)', ku)
                if m_solids:
                    active = 0
                    groups[0]['refs'][int(m_solids.group(1))] = v
                    continue
                m_solidmodels = re.fullmatch(r'SOLIDMODEL(\d+)', ku)
                if m_solidmodels:
                    active = 1
                    groups[1]['refs'][int(m_solidmodels.group(1))] = v
                    continue
                m_tm = re.fullmatch(r'TRANSFORMMATRIX(\d+)', ku)
                if m_tm:
                    groups[active]['mats'][int(m_tm.group(1))] = v
                    continue
                m_color = re.fullmatch(r'COLOR(\d+)', ku)
                if m_color:
                    groups[active]['colors'][int(m_color.group(1))] = v
            refs = []
            for group in groups:
                for i in range(max(0, min(group['count'], 100000))):
                    ref = group['refs'].get(i)
                    if not ref or is_gim_empty(ref):
                        continue
                    refs.append({
                        'ref': ref.strip(),
                        'matrix': parse_matrix(group['mats'].get(i, '')),
                        'color': group['colors'].get(i, ''),
                    })
            self.phm_cache[p] = {'meta': d, 'refs': refs}
        return self.phm_cache[p]

    def walk_solid(self, filename, m, label, depth, stack, color):
        if depth > 64 or filename in stack:
            self.cycles += 1
            return
        base = os.path.basename(filename).lower()
        if base.endswith('.phm'):
            phm = self.phm(filename)
            if phm is None:
                return
            self.phm_instances += 1
            for r in phm['refs']:
                c = r.get('color') or color
                self.walk_solid(r['ref'], mat_mul(m, r['matrix']), label, depth + 1, stack + [filename], c)
        else:
            resolved = self.resolve(filename, 'solid')
            if resolved is None:
                return
            self.geometry_leaves.append({
                'path': os.path.relpath(resolved, EXTRACT).replace('\\', '/'),
                'matrix': m,
            })
            self.models.setdefault(base, [])

    def run(self):
        self.models = {}
        root = self.cbm('project.cbm')
        if not root or not root.get('SUBSYSTEM'):
            raise SystemExit('project.cbm has no SUBSYSTEM')
        self.walk_cbm(root['SUBSYSTEM'], IDENTITY.copy())
        return self


def main():
    g = Graph().run()
    os.makedirs(BUILD, exist_ok=True)
    out = {
        'placements': g.placements,
        'leaf_instances': g.geometry_leaves,
        'counts': {
            'cbm_files_loaded': len(g.cbm_cache),
            'dev_files_loaded': len(g.dev_cache),
            'phm_files_loaded': len(g.phm_cache),
            'dev_instances': g.dev_instances,
            'phm_instances': g.phm_instances,
            'max_depth': g.max_depth,
            'missing': len(g.missing),
            'cycles': g.cycles,
        },
        'missing': g.missing[:200],
    }
    with open(os.path.join(BUILD, 'gim_placements.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(json.dumps(out['counts'], ensure_ascii=False, indent=2))
    print('placements', len(g.placements))
    if g.missing:
        print('missing sample', g.missing[:20])
    # quick label and extent summary
    labels = Counter(p['label'] for p in g.placements)
    print('top labels', labels.most_common(12))
    xs = [p['matrix'][12] / 1000 for p in g.placements]
    ys = [p['matrix'][13] / 1000 for p in g.placements]
    zs = [p['matrix'][14] / 1000 for p in g.placements]
    if xs:
        print('extent m', min(xs), max(xs), min(ys), max(ys), min(zs), max(zs))
    else:
        print('no DEV root placements; IFC coverage is checked separately')


if __name__ == '__main__':
    main()
