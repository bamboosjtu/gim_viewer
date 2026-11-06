# -*- coding: utf-8 -*-
"""ifc_lookup —— IFC 实体属性按需查找（mmap 定向读行，无需整库解析）。"""
import os, re, mmap

from ifc_probe import ifc_unescape

# ---------------- IFC 实体属性按需查找（mmap 定向，无需整库解析） ----------------

def split_top(s):
    """按顶层逗号切分 IFC 属性串（跳过括号与引号内内容）。"""
    out, buf, depth, q = [], [], 0, False
    i = 0
    while i < len(s):
        c = s[i]
        if q:
            buf.append(c)
            if c == "'":
                if i + 1 < len(s) and s[i + 1] == "'":
                    buf.append("'"); i += 1
                else:
                    q = False
        else:
            if c == "'":
                q = True; buf.append(c)
            elif c == '(':
                depth += 1; buf.append(c)
            elif c == ')':
                depth -= 1; buf.append(c)
            elif c == ',' and depth == 0:
                out.append(''.join(buf)); buf = []
            else:
                buf.append(c)
        i += 1
    if buf:
        out.append(''.join(buf))
    return out

_IFC_LINE = re.compile(r'^\s*#(\d+)\s*=\s*(IFC[A-Z0-9_]+)\s*\((.*)\)\s*;?\s*$', re.S)

def parse_ifc_line(line):
    m = _IFC_LINE.match(line)
    if not m:
        return None
    num, typ, argstr = int(m.group(1)), m.group(2), m.group(3)
    return num, typ, split_top(argstr)

_COMMON_ATTRS = ['GlobalId', 'OwnerHistory', 'Name', 'Description',
                 'ObjectType']

class IfcLookup:
    """按 IFCGUID 在指定 .ifc 文件中定位实体并提取属性（mmap 快查 + 缓存）。"""

    REF_LIMIT = 40          # 一级引用展开上限
    VAL_TRUNC = 160         # 属性值显示截断

    def __init__(self):
        self.cache = {}          # (path, guid) -> 正向 rows | None
        self.rcache = {}         # (path, guid) -> 反向 rows | None
        self._mm = {}            # path -> [mmap, file]（LRU 只留 2 个）

    def _get_mm(self, path):
        ent = self._mm.get(path)
        if ent is None:
            if len(self._mm) >= 2:
                for k, (m, fh) in list(self._mm.items()):
                    try:
                        m.close(); fh.close()
                    except Exception:
                        pass
                self._mm.clear()
            fh = open(path, 'rb')
            mm = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
            ent = [mm, fh]
            self._mm[path] = ent
        return ent[0]

    def _line_of(self, mm, pos):
        s = mm.rfind(b'\n#', 0, pos + 1) + 1
        e = mm.find(b';', pos)
        if e < 0:
            e = len(mm) - 1
        return mm[s:e + 1].decode('utf-8', errors='replace')

    def _resolve_ref(self, mm, num):
        """把 #n 解析为『类型：摘要』（摘要取首个字符串型属性）。"""
        try:
            num = int(str(num).strip())
        except ValueError:
            return None
        pos = mm.find(('#%d=' % num).encode())
        if pos < 0:
            return None
        ent = parse_ifc_line(self._line_of(mm, pos))
        if not ent:
            return None
        _num, typ, args = ent
        name = ''
        for a in args[:6]:
            a = a.strip()
            if a.startswith("'") and len(a) > 2:
                name = ifc_unescape(a).strip("'")
                break
            if a.startswith(('$', '#', '*', '(', '.')):
                continue
            name = a
            break
        return ('%s  %s' % (typ, name[:60])) if name else typ

    def _ent_at(self, mm, pos):
        s = mm.rfind(b'\n#', 0, pos + 1) + 1
        e = mm.find(b';', pos)
        if e < 0:
            e = len(mm) - 1
        return parse_ifc_line(mm[s:e + 1].decode('utf-8', errors='replace'))

    def _locate(self, mm, guid):
        pos = mm.find(guid.encode())
        while pos >= 0:
            ent = parse_ifc_line(self._line_of(mm, pos))
            if ent and ent[2] and ent[2][0].strip("'") == guid:
                return ent
            pos = mm.find(guid.encode(), pos + 1)
        return None

    def find(self, path, guid):
        """返回正向属性行 [(组, 键, 值), ...]；未找到返回 None。"""
        key = (path, guid)
        if key in self.cache:
            return self.cache[key]
        rows = None
        try:
            mm = self._get_mm(path)
            ent = self._locate(mm, guid)
            if ent:
                rows = self._rows(mm, path, ent)
        except OSError:
            rows = None
        self.cache[key] = rows
        return rows

    # ---- 反向关联（谁引用了这个实体） ----

    RROW_LIMIT = 400        # 反向属性行上限
    PSET_LIMIT = 80         # 单个属性集条目上限

    @staticmethod
    def _val(v):
        """IFC 属性值解码：去 IFCTYPE 包装与引号，解 \\X2\\。"""
        v = v.strip()
        m = re.match(r'^IFC[A-Z0-9_]*\((.*)\)$', v, re.S)
        if m:
            v = m.group(1)
        if len(v) >= 2 and v.startswith("'") and v.endswith("'"):
            v = v[1:-1]
        return ifc_unescape(v)

    def _ent(self, mm, n):
        pos = mm.find(('#%d=' % n).encode())
        if pos < 0:
            return None
        return self._ent_at(mm, pos)

    def _label(self, mm, ref):
        """'#n' → '#n TYPE「Name」' 摘要（Name 优先取 arg2）。"""
        ref = (ref or '').strip()
        if not ref.startswith('#'):
            return ref
        try:
            n = int(ref[1:].split('[')[0])
        except ValueError:
            return ref
        ent = self._ent(mm, n)
        if not ent:
            return ref
        _n, t, a = ent
        nm = ''
        if len(a) >= 3 and a[2].strip().startswith("'") \
                and len(a[2].strip()) > 2:
            nm = ifc_unescape(a[2].strip()[1:-1])
        else:
            for x in a[:6]:
                x = x.strip()
                if x.startswith("'") and len(x) > 2:
                    nm = ifc_unescape(x[1:-1])
                    break
        return '#%d %s%s' % (n, t, ('「%s」' % nm[:40]) if nm else '')

    @staticmethod
    def _refs(arg):
        return set(int(x) for x in re.findall(r'#(\d+)', arg or ''))

    def reverse_rows(self, path, guid):
        """反向关联行：楼层/类型/属性集/材料等。未找到返回 None。"""
        key = (path, guid)
        if key in self.rcache:
            return self.rcache[key]
        rows = None
        try:
            mm = self._get_mm(path)
            ent = self._locate(mm, guid)
            if ent:
                rows = self._reverse(mm, ent)
        except OSError:
            rows = None
        self.rcache[key] = rows
        return rows

    def _reverse(self, mm, ent):
        num, typ, args = ent
        rows = []
        pat = ('#%d' % num).encode()
        L, size = len(pat), len(mm)
        rels, seen = [], set()
        pos = mm.find(pat)
        while pos >= 0:
            j = pos + L
            if j < size and not (48 <= mm[j] <= 57):   # 后随非数字才是真引用
                rel = self._ent_at(mm, pos)
                if rel and rel[0] != num and rel[0] not in seen:
                    seen.add(rel[0])
                    rels.append(rel)
            pos = mm.find(pat, pos + 1)
        for rnum, rtyp, rargs in rels:
            if len(rows) >= self.RROW_LIMIT:
                rows.append(('IFC 反向', '…', '反向关联过多，已截断'))
                break
            if rtyp == 'IFCRELCONTAINEDINSPATIALSTRUCTURE' and len(rargs) >= 6:
                if num in self._refs(rargs[4]):
                    rows.append(('IFC 反向', '所属空间',
                                 self._label(mm, rargs[5])))
            elif rtyp == 'IFCRELAGGREGATES' and len(rargs) >= 6:
                if num in self._refs(rargs[5]):
                    rows.append(('IFC 反向', '聚合于(父)',
                                 self._label(mm, rargs[4])))
                elif rargs[4].strip() == '#%d' % num:
                    rows.append(('IFC 反向', '聚合包含(子)', rargs[5][:120]))
            elif rtyp == 'IFCRELDEFINESBYTYPE' and len(rargs) >= 6:
                rows.append(('IFC 反向', '实例化类型',
                             self._label(mm, rargs[5])))
            elif rtyp == 'IFCRELDEFINESBYPROPERTIES' and len(rargs) >= 6:
                rows.extend(self._pset_rows(mm, rargs[5]))
            elif rtyp == 'IFCRELASSOCIATESMATERIAL' and len(rargs) >= 6:
                rows.append(('IFC 反向', '材料',
                             self._material(mm, rargs[5])))
            else:
                rows.append(('IFC 反向', rtyp, '#%d' % rnum))
        return rows or [('IFC 反向', '结果', '未发现引用该实体的关系对象')]

    def _pset_rows(self, mm, ref):
        out = []
        ref = ref.strip()
        if not ref.startswith('#'):
            return out
        try:
            n = int(ref[1:])
        except ValueError:
            return out
        ent = self._ent(mm, n)
        if not ent:
            return out
        _n, t, a = ent
        if t != 'IFCPROPERTYSET':
            out.append(('IFC 反向', t, ref))
            return out
        nm = self._val(a[2]) if len(a) >= 3 else ''
        parg = next((x for x in a
                     if re.fullmatch(r'\(#[\d#, \$]*\)', x.strip())), '')
        pids = re.findall(r'#(\d+)', parg)
        out.append(('IFC 反向', '属性集', '#%d 「%s」 %d 项' % (n, nm, len(pids))))
        for pid in pids:
            pent = self._ent(mm, int(pid))
            if not pent:
                continue
            _n2, t2, a2 = pent
            if t2 in ('IFCPROPERTYSINGLEVALUE', 'IFCPROPERTYENUMERATEDVALUE',
                      'IFCPROPERTYLISTVALUE'):
                key = self._val(a2[0]) if a2 else '?'
                val = a2[2] if len(a2) > 2 else '$'
                if val.strip().startswith('#'):
                    val = self._label(mm, val.strip())
                else:
                    val = self._val(val)
                out.append(('IFC 反向', '%s·%s' % (nm, key), val[:160]))
            if len(out) > self.PSET_LIMIT:
                out.append(('IFC 反向', '…', '属性集条目过多，已截断'))
                break
        return out

    def _material(self, mm, ref):
        ref = ref.strip()
        if not ref.startswith('#'):
            return ref
        try:
            n = int(ref[1:])
        except ValueError:
            return ref
        ent = self._ent(mm, n)
        if not ent:
            return ref
        _n, t, a = ent
        if t == 'IFCMATERIAL' and a:
            return self._val(a[0])
        if t == 'IFCMATERIALLIST':
            names = []
            for arg in a:                       # Materials 是唯一属性
                for r in re.findall(r'#(\d+)', arg):
                    me = self._ent(mm, int(r))
                    if me and me[2]:
                        names.append(self._val(me[2][0]))
            return '、'.join(names) or ref
        return '%s %s' % (t, ref)

    def _rows(self, mm, path, ent):
        num, typ, args = ent
        g = os.path.basename(path)
        rows = [('IFC 实体', '源 IFC 文件', g),
                ('IFC 实体', '实体', '#%d  %s' % (num, typ))]
        for i, a in enumerate(args):
            label = _COMMON_ATTRS[i] if i < len(_COMMON_ATTRS) else '属性%d' % (i + 1)
            v = ifc_unescape(a).strip("'")
            if v.startswith('#'):
                summ = self._resolve_ref(mm, v[1:].split('[')[0])
                v = '%s  →  %s' % (v, summ) if summ else v
            if len(v) > self.VAL_TRUNC:
                v = v[:self.VAL_TRUNC] + '…'
            if v:
                rows.append(('IFC 实体', label, v))
        refs = []
        for a in args:
            for m in re.finditer(r'#(\d+)', a):
                n = int(m.group(1))
                if n not in refs:
                    refs.append(n)
        for n in refs[:self.REF_LIMIT]:
            summ = self._resolve_ref(mm, n)
            if summ:
                rows.append(('IFC 引用', '#%d' % n, summ))
        if len(refs) > self.REF_LIMIT:
            rows.append(('IFC 引用', '…', '另有 %d 个引用未展开' %
                         (len(refs) - self.REF_LIMIT)))
        return rows


