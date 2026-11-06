# -*- coding: utf-8 -*-
"""gimbrowse —— GIM 文件信息浏览器：只看文件、键值、指针，不做实体识别

设计目标（对应《线路GIM文件拆解》教程）
    GIM 解包后是四个目录（Cbm/Dev/Phm/Mod）里的一堆文件，文件之间靠**值等一个文件名**
    互相指向：cbm 的 SUBSYSTEM/SUBDEVICE 指向下一个 .cbm，OBJECTMODELPOINTER 指向 .dev，
    dev 的 SOLIDMODELn 指向 .dev/.phm，BASEFAMILY 指向 .fam……本模块只做三件事：
      1. 把目录里的文件列出来（文件表）；
      2. 把每个文件里的「值以模型文件后缀结尾」的键认成**指针**，解析到目标文件；
      3. 记住「谁指向我」（反向引用），供界面做跳转与返回。

明确不做：实体分类、四本账、BTV 业务树、IFC 挂接、坐标推断。
    —— 那些是 gim_element / 05-模型树 的职责，本工具只回答
       「这个文件里有什么键」「这个指针跳到哪个文件」「跳过去之后怎么回来」。

指针判定（与教程 Step 6/8 同口径，类型以 `ptr_kinds.py` 为唯一真源）
    · 键以 `.NUM` 结尾 → 计数键，不是指针；
    · 值去空白后以模型/逻辑/资料后缀结尾 → 指针，共 **9 种语义类型**；
    · 解析顺序：显式路径 / 相对路径 → 全库唯一同名 → 多义或悬空；
      后缀约定目录仅提供悬空下载提示，不能裁决多义目标；
    · 悬空时 target 给「期望路径」（如 CBM/xxx.cbm）——样本只下载到 F2 时，
      这些就是按引用链继续下载所需的文件名，链与导出清单都会保留它们；
    · 引用链 `edges()` 覆盖**每一个指针**（含 BASEFAMILY1..n / IFCFILE / IFCn / SCHn），
      属性表里能点的链接，链上和下载清单里都必须有；
    · `IFCGUID` / `MATERIALSHEET` / `FILEn.NAME` 不是文件指针，走 `markers()`，
      界面只标注不跳转，避免被误判成悬空指针。
"""
import collections
from dataclasses import dataclass
import os
import posixpath
import re
import threading
import xml.etree.ElementTree as ET

from ptr_kinds import (PTR_EXT, CORE_EXT, LOGIC_EXT, AUX_EXT, RX_NUMKEY,
                       RX_IFCGUID, RX_MATSHEET, RX_FILE_NAME,
                       KIND_GROUP, KIND_COLOR, KIND_BASIS, KIND_NOTE,
                       KIND_ORDER, PTR_KINDS, GROUPS, EXCLUDES,
                       classify, kind_name, kind_group, kind_tooltip, key_family)

GIM_DIRS = ('cbm', 'dev', 'phm', 'mod')
# 文件表收录的后缀（比 PTR_EXT 少 dgn：出图文件不在 GIM 包内）
SCAN_EXT = tuple(e.lstrip('.') for e in CORE_EXT + LOGIC_EXT + AUX_EXT)
# 解包后各后缀的约定目录：cbm 全在 CBM/、dev 全在 DEV/，不需要猜跨目录
DIR_FOR_EXT = {'cbm': 'CBM', 'dev': 'DEV', 'phm': 'PHM', 'mod': 'MOD'}
# 样本里该后缀一个文件都没有时（只下载到 F2 的教学包）用的兜底目录
FALLBACK_HOME = {'fam': 'CBM', 'ifc': 'DEV', 'stl': 'MOD',
                 'sch': 'CBM', 'sld': 'CBM', 'std': 'CBM',
                 'gl': 'MOD', 'xml': 'CBM', 'dgn': 'CBM'}
# 这些后缀不做「默认 KV 解析」：可能是 STEP/IFC 文本、XML、SVG 或二进制。
# 显示时由 content() 判定是 KV / 文本 / 二进制，不能一概当成空文件。
NO_KV_EXT = ('ifc', 'stl', 'sld', 'std', 'gl', 'xml', 'dgn')
TEXT_MAX_BYTES = 1024 * 1024      # 文本预览最多读 1 MB
TEXT_MAX_LINES = 4000
XML_MAX_BYTES = 8 * 1024 * 1024   # 超过 8 MB 的 XML 退回按行文本，不整篇建树
RX_KV_KEY = re.compile(r'^[A-Za-z][A-Za-z0-9_.]*$')

KIND_NAME = {'cbm': '工程节点', 'dev': '设备图元', 'phm': '几何实体',
             'mod': '几何模型', 'fam': '族属性', 'stl': '网格', 'ifc': 'IFC',
             'sch': '逻辑模型清单', 'sld': '逻辑图形', 'std': '系统拓扑',
             'gl': '接线点语义', 'xml': '材料单', 'dgn': '出图文件'}


def kv_read(path):
    """读 GIM 的 KEY=VALUE 文本（容忍 BOM / 空行 / 无等号行）。

    XML / SVG 不是 KV：首行以 `<` 开头就直接返回空，否则 `<?xml version=…`
    和 `<Entity ID=…>` 会被按等号拆成「键=`<?xml version`」这种假键，
    进而污染全库指针统计。XML 的结构化显示由 Index.content() 负责。
    """
    out = {}
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            first = True
            for line in f:
                line = line.strip().lstrip('\ufeff')
                if first:
                    first = False
                    if line.startswith('<'):
                        return {}
                if not line or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                out[k.strip()] = v.strip()
    except OSError:
        pass
    return out


def _decode(raw):
    """GIM 里 UTF-8 与 GBK 混用；优先 UTF-8，失败退 GB18030。"""
    if raw[:2] in (b'\xff\xfe', b'\xfe\xff'):
        return raw.decode('utf-16', errors='replace'), 'utf-16'
    for enc in ('utf-8-sig', 'gb18030'):
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return raw.decode('utf-8', errors='replace'), 'utf-8(替换)'


def _looks_binary(raw):
    head = raw[:4096]
    if not head:
        return False
    if b'\x00' in head:
        return True
    ok = sum(1 for b in head
             if b in (9, 10, 13) or 32 <= b < 127 or b >= 128)
    return ok / len(head) < 0.85


def _hex_lines(raw, per=16, count=16):
    """二进制预览 → [(偏移, 十六进制 / ASCII)]。"""
    out = []
    for off in range(0, min(len(raw), per * count), per):
        chunk = raw[off:off + per]
        hx = ' '.join('%02X' % b for b in chunk)
        asc = ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)
        out.append(('%04X' % off, '%-47s  |%s|' % (hx, asc)))
    return out


def _strict_kv(lines):
    """严格 KV 判定：每个非空行都是 `标识符=值`。

    IFC 的 `#12=IFC…(`、XML 的 `<?xml version=…` 都不算，避免把整篇文本
    误当成键，也避免把 `FILE_NAME('x.ifc'…)` 里的后缀误认成指针。
    """
    out = {}
    for line in lines:
        s = line.strip()
        if not s:
            continue
        if '=' not in s:
            return None
        k, v = s.split('=', 1)
        k = k.strip()
        if len(k) > 64 or not RX_KV_KEY.match(k):
            return None
        out[k] = v.strip()
    return out or None


# ---------- XML：按元素 / 属性结构展开，而不是按行文本 ----------
def _looks_xml(raw):
    """文件头是否 XML（含带 BOM、DOCTYPE 的 SVG / 逻辑图形 / 系统拓扑）。"""
    s = raw[:512].lstrip(b'\xef\xbb\xbf \t\r\n')
    return s.startswith((b'<?xml', b'<!DOCTYPE', b'<')) if s else False


def _tag_name(tag):
    """去掉 ElementTree 的 `{namespace}` 前缀；注释 / 处理指令返回空串。"""
    if not isinstance(tag, str):
        return ''
    return tag.rsplit('}', 1)[-1] if tag.startswith('{') else tag


def _xml_flat(root, max_rows=TEXT_MAX_LINES):
    """XML 树 → ([(标签, 值)], 元素数, 属性数, 是否截断)。

    两类行：元素行 `  <Entity[2]>`（缩进表达层级，同名兄弟加序号），
    属性行 `    @ID`（值列写属性值）；元素的文本写在元素行的值列。
    """
    lines = []
    stat = {'elem': 0, 'attr': 0, 'cut': False}

    def emit(el, depth, label):
        """先输出本元素与它的属性，再按同名序号递归子元素。"""
        if len(lines) >= max_rows:
            stat['cut'] = True
            return
        stat['elem'] += 1
        txt = (el.text or '').strip()
        lines.append(('  ' * depth + '<' + label + '>',
                      '#text: ' + txt if txt else ''))
        for k, v in el.attrib.items():
            if len(lines) >= max_rows:
                stat['cut'] = True
                return
            stat['attr'] += 1
            lines.append(('  ' * (depth + 1) + '@' + _tag_name(k), v))
        counts = collections.Counter(
            _tag_name(c.tag) for c in el if isinstance(c.tag, str))
        seen = collections.Counter()
        for child in el:
            name = _tag_name(child.tag)
            if not name or stat['cut']:
                continue
            seen[name] += 1
            tag = name if counts[name] == 1 else '%s[%d]' % (name, seen[name])
            emit(child, depth + 1, tag)

    name = _tag_name(root.tag)
    if name:
        emit(root, 0, name)
    return lines, stat['elem'], stat['attr'], stat['cut']


def _xml_encoding(raw):
    m = re.search(rb'encoding\s*=\s*["\']([\w.-]+)["\']', raw[:200])
    if m:
        return m.group(1).decode('ascii', 'replace')
    return _decode(raw[:4096])[1]


def ext_of(value):
    return posixpath.splitext((value or '').strip().replace('\\', '/'))[1].lower()


def is_pointer_value(value):
    """值是否像指针：以模型文件后缀结尾，且不是纯路径分隔符/占位。"""
    v = (value or '').strip().strip('"')
    if not v or v in ('-', '$', '/'):
        return False
    if ext_of(v) not in PTR_EXT:
        return False
    # 值里带空格/中文说明的（如「见 xxx.dev」）不算严格指针，但仍解析 basename
    return True


class Entry:
    """一个文件的静态信息 + 惰性键值/内容缓存。"""
    __slots__ = ('rel', 'name', 'dir', 'ext', 'size', 'kv', 'text')

    def __init__(self, rel, size):
        self.rel = rel
        self.name = posixpath.basename(rel)
        self.dir = posixpath.dirname(rel)
        self.ext = posixpath.splitext(self.name)[1].lower().lstrip('.')
        self.size = size
        self.kv = None
        self.text = None


@dataclass(frozen=True)
class Resolution:
    """Unique target or all unresolved candidates; ambiguity never selects a file.

    Two-value unpacking remains compatible with existing callers. New callers
    can inspect candidates and expected without interpreting them as targets.
    """
    target: str
    status: str
    candidates: tuple[str, ...] = ()
    expected: str = ''

    def __iter__(self):
        yield self.target
        yield self.status


class Ptr:
    """一条指针：键 → 目标。status: ok / cross / ambiguous / missing。

    kind 是 `ptr_kinds.PTR_KINDS` 的 9 种类型码（L1/L2/M/G/A/I/U/S/D）。
    """
    __slots__ = ('key', 'value', 'target', 'status', 'note', 'kind', 'candidates', 'expected')

    def __init__(self, key, value, target, status, note='', kind='D', candidates=(), expected=''):
        self.key, self.value, self.target = key, value, target
        self.status, self.note, self.kind = status, note, kind
        self.candidates, self.expected = tuple(candidates), expected

    @property
    def type_name(self):
        return kind_name(self.kind)

    @property
    def group(self):
        return kind_group(self.kind)

    def as_dict(self):
        return {'key': self.key, 'value': self.value, 'target': self.target,
                'status': self.status, 'note': self.note,
                'kind': self.kind, 'type': self.type_name,
                'candidates': list(self.candidates), 'expected': self.expected}


class Index:
    """文件表 + 指针解析 + 反向引用。"""

    def __init__(self, root):
        self.root = root
        self.dirs = {}                 # 小写目录名 -> 实际目录名
        self.files = {}                # rel('CBM/x.cbm') -> Entry
        self.by_stem = collections.defaultdict(list)   # 小写 stem -> [rel]
        self.by_name = collections.defaultdict(list)   # 小写文件名 -> [rel]
        self.by_path = collections.defaultdict(list)   # 小写完整路径 -> [rel]
        self.refs = {}                 # rel -> [Ptr]
        self.kinds = {}                # rel -> {键: 9 种类型码}
        self.marks = {}                # rel -> [(键, 值, 类型码)]：非跳转标识/占位
        self.back = collections.defaultdict(list)      # rel -> [(src_rel, Ptr)]
        self.possible_back = collections.defaultdict(list)  # 多义候选，不属于确定反向引用
        self.built = False
        self.lock = threading.Lock()
        self.progress = None
        self._scan_dirs()
        self._scan_files()

    # ---------- 文件表 ----------
    def _scan_dirs(self):
        try:
            entries = os.listdir(self.root)
        except OSError:
            entries = []
        for e in entries:
            p = os.path.join(self.root, e)
            if os.path.isdir(p) and e.lower() in GIM_DIRS:
                self.dirs[e.lower()] = e

    def _scan_files(self):
        for low, real in self.dirs.items():
            base = os.path.join(self.root, real)
            for fn in os.listdir(base):
                p = os.path.join(base, fn)
                if not os.path.isfile(p):
                    continue
                ext = os.path.splitext(fn)[1].lower().lstrip('.')
                if ext not in SCAN_EXT:
                    continue
                rel = '%s/%s' % (real, fn)
                self.files[rel] = Entry(rel, os.path.getsize(p))
                self.by_stem[posixpath.splitext(fn)[0].lower()].append(rel)
                self.by_name[fn.lower()].append(rel)
                self.by_path[rel.lower()].append(rel)
        # 各后缀实际集中放在哪个目录（不同样本 ifc 可能在 DEV/ 也可能在 CBM/ 下）
        homes = collections.defaultdict(collections.Counter)
        for rel, e in self.files.items():
            homes[e.ext][posixpath.dirname(rel)] += 1
        self.ext_home = {ext: cnt.most_common(1)[0][0]
                         for ext, cnt in homes.items()}

    def path_of(self, rel):
        return os.path.join(self.root, *rel.split('/'))

    def read(self, rel):
        """供指针/引用链使用的键值（只认 GIM 的 KEY=VALUE 文件）。

        非 KV 后缀、以及 XML 文件默认给空字典，保持全库扫描（search /
        build_refs）足够轻；只有 content() 判定出「其实是 KV 文件」时才会
        把 e.kv 填回去。XML 的结构化展示不走键值，也不产生指针。
        """
        e = self.files.get(rel)
        if e is None:
            return {}
        if e.kv is None:
            e.kv = {} if e.ext in NO_KV_EXT else kv_read(self.path_of(rel))
        return e.kv

    def _xml_content(self, rel, base, max_lines):
        """XML → 结构化内容；不合法 / 过大 / 二进制时返回 None 交回文本分支。"""
        try:
            with open(self.path_of(rel), 'rb') as f:
                raw = f.read(XML_MAX_BYTES + 1)
        except OSError:
            return None
        if len(raw) > XML_MAX_BYTES or _looks_binary(raw):
            return None
        try:
            # 必须传 bytes：ET 自己按 XML 声明解码；传 str 会与 encoding 声明冲突
            root = ET.fromstring(raw)
        except ET.ParseError:
            return None
        lines, nelem, nattr, cut = _xml_flat(root, max_lines)
        return dict(base, mode='xml', lines=lines, total=len(lines),
                    elements=nelem, attrs=nattr, root=_tag_name(root.tag),
                    encoding=_xml_encoding(raw), truncated=cut)

    def content(self, rel, max_lines=TEXT_MAX_LINES, max_bytes=TEXT_MAX_BYTES):
        """文件内容 → 统一结构，供界面显示。

        mode:
          kv     —— KEY=VALUE，界面显示「键 / 值」两列，指针值仍是链接；
          xml    —— XML（.mod / .sld / .std / SVG 等），界面按
                    「XML 元素 / 属性 · 值」显示元素层级与 @属性；
          text   —— 其它非 KV 文本（IFC/STEP、ASCII STL 等），按「行 / 文本」逐行显示；
          binary —— 二进制，按「偏移 / 十六进制 · ASCII」预览前 256 字节。
        返回 {'mode', 'kv', 'lines', 'total', 'encoding', 'truncated',
              'size', 'elements', 'attrs', 'root'}，lines = [(标签, 文本)]。
        """
        e = self.files.get(rel)
        if e is None:
            return {'mode': 'empty', 'kv': {}, 'lines': [],
                    'total': 0, 'encoding': '', 'truncated': False, 'size': 0,
                    'elements': 0, 'attrs': 0, 'root': ''}
        if e.text is not None:
            return e.text
        base = {'mode': 'empty', 'kv': {}, 'lines': [], 'total': 0,
                'encoding': '', 'truncated': False, 'size': e.size,
                'elements': 0, 'attrs': 0, 'root': ''}
        # XML 按结构解析，不看后缀：mod / sld / std / xml / SVG 都是 XML
        try:
            with open(self.path_of(rel), 'rb') as f:
                head = f.read(512)
        except OSError:
            head = b''
        xmlish = _looks_xml(head)
        if xmlish:
            c = self._xml_content(rel, base, max_lines)
            if c is not None:
                e.text = c
                return c
        # XML 解析失败也不能按 KV 拆（首行是 `<`），退回按行显示原文
        if not xmlish and e.ext not in NO_KV_EXT:
            kv = self.read(rel)
            c = dict(base, mode='kv', kv=kv, total=len(kv))
            e.text = c
            return c
        try:
            with open(self.path_of(rel), 'rb') as f:
                raw = f.read(max_bytes + 1)
        except OSError as ex:
            c = dict(base, mode='text', lines=[('—', '读取失败：%s' % ex)])
            e.text = c
            return c
        truncated = len(raw) > max_bytes
        raw = raw[:max_bytes]
        if not raw:
            c = dict(base, mode='empty')
            e.text = c
            return c
        if _looks_binary(raw):
            c = dict(base, mode='binary', lines=_hex_lines(raw),
                     total=len(_hex_lines(raw)), truncated=e.size > 256)
            e.text = c
            return c
        text, enc = _decode(raw)
        all_lines = text.splitlines()
        kv = _strict_kv(all_lines)
        if kv is not None:
            e.kv = kv                       # 后续指针/搜索也按 KV 处理
            c = dict(base, mode='kv', kv=kv, total=len(kv),
                     encoding=enc, truncated=truncated)
            e.text = c
            return c
        shown = all_lines[:max_lines]
        lines = [('%d' % (i + 1), ln) for i, ln in enumerate(shown)]
        c = dict(base, mode='text', lines=lines, total=len(all_lines),
                 encoding=enc, truncated=truncated or len(all_lines) > max_lines)
        e.text = c
        return c

    def stat(self):
        by_dir = collections.Counter()
        for rel in self.files:
            by_dir[posixpath.dirname(rel)] += 1
        return dict(by_dir)

    # ---------- 指针解析 ----------
    def expected_rel(self, value, src_rel=''):
        """指针值 → 期望的下载路径（文件没随包下载时也能给出准确取用路径）。"""
        v = (value or '').strip().strip('"').replace('\\', '/')
        base = posixpath.basename(v)
        if not base:
            return ''
        if '/' in v:                       # 值自带目录，如 CBM/xxx.cbm
            d = posixpath.basename(posixpath.dirname(v)).lower()
            real = self.dirs.get(d)
            if real:
                return '%s/%s' % (real, base)
        ext = ext_of(base).lstrip('.')
        if ext in DIR_FOR_EXT:
            real = self.dirs.get(ext, DIR_FOR_EXT[ext])
            return '%s/%s' % (real, base)
        # fam / ifc / stl：优先用该后缀在样本里实际所在的目录
        home = self.ext_home.get(ext) or FALLBACK_HOME.get(ext)
        if home:
            return '%s/%s' % (home, base)
        d = posixpath.dirname(src_rel)
        return '%s/%s' % (d, base) if d else base

    def resolve(self, src_rel, value):
        """Return Resolution; only explicit/relative paths or unique names resolve.

        A conventional directory is a missing-file hint, never a tie-breaker.
        """
        v = (value or '').strip().strip('"').replace('\\', '/')
        if not v:
            return Resolution('', 'missing')
        base = posixpath.basename(v)
        exp = self.expected_rel(v, src_rel)
        paths = []
        if '/' in v:
            paths.append(posixpath.normpath(v))
        paths.append(posixpath.normpath(posixpath.join(posixpath.dirname(src_rel), v)))
        for path in paths:
            hits = tuple(sorted(set(self.by_path.get(path.lower(), []))))
            if len(hits) == 1:
                target = hits[0]
                status = 'ok' if posixpath.dirname(target).lower() == posixpath.dirname(src_rel).lower() else 'cross'
                return Resolution(target, status, hits, exp)
            if len(hits) > 1:
                return Resolution('', 'ambiguous', hits, exp)
        hits = tuple(sorted(set(self.by_name.get(base.lower(), []))))
        if len(hits) == 1:
            return Resolution(hits[0], 'cross', hits, exp)
        if len(hits) > 1:
            return Resolution('', 'ambiguous', hits, exp)
        return Resolution(exp, 'missing', (), exp)

    def classify_ptr(self, rel, key, value, target='', status='ok'):
        """单条指针 → 9 种类型码。只在 cbm→cbm 且需要区分 PARTINDEX 时读目标。"""
        e = self.files.get(rel)
        se = e.ext if e else ''
        te = ext_of(value).lstrip('.')
        ent = ''
        ku = key.upper()
        if te == 'cbm' and status in ('ok', 'cross') and target in self.files:
            if ku.startswith('SUBDEVICE') or 'PARTINDEX' in ku:
                ent = self.read(target).get('ENTITYNAME', '')
        return classify(key, value, se, te, ent, posixpath.basename(rel))

    def pointers(self, rel):
        """某文件的全部可跳转指针（缓存），每条都带 9 种类型码之一。"""
        if rel in self.refs:
            return self.refs[rel]
        out, kmap, marks = [], {}, []
        for k, v in self.read(rel).items():
            ku = k.upper()
            if RX_NUMKEY.search(k):
                continue
            # 非文件指针：IFCGUID / 材料表 / 出图名 / 逻辑描述文件占位
            if (RX_IFCGUID.match(ku) or RX_MATSHEET.match(ku)
                    or RX_FILE_NAME.match(ku) or '逻辑描述文件' in ku):
                if not is_pointer_value(v):
                    marks.append((k, v, self.classify_ptr(rel, k, v)))
                    continue
            if not is_pointer_value(v):
                continue
            resolution = self.resolve(rel, v)
            tgt, st = resolution
            kind = self.classify_ptr(rel, k, v, tgt, st)
            kmap[k] = kind
            out.append(Ptr(k, v, tgt, st, kind=kind, candidates=resolution.candidates,
                           expected=resolution.expected))
        self.refs[rel] = out
        self.kinds[rel] = kmap
        self.marks[rel] = marks
        return out

    def markers(self, rel):
        """非跳转的标识/占位键 → [(键, 值, 类型码)]，界面只标注不做链接。"""
        self.pointers(rel)
        return self.marks.get(rel, [])

    def kind_of(self, rel, key):
        self.pointers(rel)
        return self.kinds.get(rel, {}).get(key, '')

    def kind_stats(self, rel=''):
        """按 9 种类型统计指针数（rel 为空则统计全库已扫描部分）。"""
        out = collections.Counter()
        rels = [rel] if rel else list(self.files)
        for r in rels:
            for p in self.pointers(r):
                out[p.kind] += 1
        return out

    # ---------- 反向引用 ----------
    def build_refs(self, progress=None, workers=16):
        """全量扫描一遍，建 refs + back。文件多时用线程池读。"""
        from concurrent.futures import ThreadPoolExecutor
        self.progress = progress or (lambda m: None)
        rels = list(self.files)
        self.progress('读取文件键值 %d 个…' % len(rels))
        done = [0]

        def one(rel):
            r = (rel, self.pointers(rel))
            with self.lock:
                done[0] += 1
                if done[0] % 2000 == 0:
                    self.progress('读取 %d/%d…' % (done[0], len(rels)))
            return r

        self.back = collections.defaultdict(list)
        self.possible_back = collections.defaultdict(list)
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for rel, ptrs in ex.map(one, rels):
                for p in ptrs:
                    if p.status in ('ok', 'cross') and p.target in self.files:
                        self.back[p.target].append((rel, p))
                    elif p.status == 'ambiguous':
                        for candidate in p.candidates:
                            self.possible_back[candidate].append((rel, p))
        self.built = True
        self.progress('指针索引完成：文件 %d · 指针 %d · 有反向引用的文件 %d'
                      % (len(rels), sum(len(v) for v in self.refs.values()),
                         len(self.back)))
        return self.check(scan=False)

    def back_refs(self, rel):
        return self.back.get(rel, [])

    def possible_back_refs(self, rel):
        """Unconfirmed references, kept separate even after a navigation choice."""
        return self.possible_back.get(rel, [])

    # ---------- 统计 ----------
    def check(self, scan=True):
        """指针体检：可达 / 跨目录 / 多义 / 悬空，按扩展名分布。"""
        if scan and not self.built:
            self.build_refs(lambda m: None)
        st = collections.Counter()
        miss = []
        by_ext = collections.Counter()
        by_kind = collections.Counter()
        by_group = collections.Counter()
        by_mark = collections.Counter()
        for _k, _v, c in (m for ms in self.marks.values() for m in ms):
            by_mark[c] += 1
        for rel, ptrs in self.refs.items():
            for p in ptrs:
                st[p.status] += 1
                by_ext[ext_of(p.value)] += 1
                by_kind[p.kind] += 1
                by_group[p.group] += 1
                if p.status == 'missing' and len(miss) < 50:
                    miss.append((rel, p.key, p.value))
        return {'文件': len(self.files), '指针': sum(st.values()),
                '可达': st['ok'], '跨目录': st['cross'],
                '多义': st['ambiguous'], '悬空': st['missing'],
                '按后缀': dict(by_ext), '按类型': dict(by_kind),
                '按大类': dict(by_group), '标识按类型': dict(by_mark),
                '悬空样例': miss,
                '标识键': sum(len(v) for v in self.marks.values()),
                '目录': self.stat()}

    # ---------- 引用链：F1→F2→F3→F4→PARTINDEX + 模型边 / 属性边 ----------
    def _cbm_edge_values(self, rel):
        """cbm 里所有指向 .cbm 的键值，按 SUBSYSTEM → SUBDEVICE/GROUP → 其余 排序。"""
        if not rel.lower().endswith('.cbm'):
            return []
        kv = self.read(rel)
        out, seen = [], set()

        def push(k, v):
            if (k, v) not in seen:
                seen.add((k, v))
                out.append((k, v))

        v = kv.get('SUBSYSTEM')
        if v and is_pointer_value(v) and ext_of(v) == '.cbm':
            push('SUBSYSTEM', v)
        for pref in ('SUBSYSTEM', 'SUBDEVICE', 'GROUP'):
            for k, v in kv.items():
                if RX_NUMKEY.search(k) or not is_pointer_value(v) or ext_of(v) != '.cbm':
                    continue
                if k.upper().startswith(pref):
                    push(k, v)
        for k, v in kv.items():
            if RX_NUMKEY.search(k) or not is_pointer_value(v) or ext_of(v) != '.cbm':
                continue
            push(k, v)
        return out

    def cbm_edges(self, rel):
        """层级边 → [(key, target, 层名, 是否存在)]，未下载的 cbm 也保留（期望路径）。"""
        out, seen = [], set()
        for k, v in self._cbm_edge_values(rel):
            tgt, st = self.resolve(rel, v)
            if st == 'missing':
                tgt = self.expected_rel(v, rel)
            identity = (rel, k, tgt)
            if identity in seen:
                continue
            seen.add(identity)
            ok = tgt in self.files
            out.append((k, tgt, self.level_name(tgt) if ok else '', ok))
        return out

    def cbm_children(self, rel):
        """已下载的下级 cbm → [(key, target, 层名)]（兼容旧调用）。"""
        return [(k, t, lv) for k, t, lv, ok in self.cbm_edges(rel) if ok]

    def level_name(self, rel):
        """cbm 的层名：读 ENTITYNAME（F1System/F2System/…/PARTINDEX），否则按扩展名。"""
        e = self.files.get(rel)
        if e is None:
            return ''
        if e.ext == 'cbm':
            n = self.read(rel).get('ENTITYNAME') or ''
            return n
        return KIND_NAME.get(e.ext, e.ext)

    def model_ptr(self, rel):
        """cbm → dev（模型边 OBJECTMODELPOINTER）。"""
        v = self.read(rel).get('OBJECTMODELPOINTER') or ''
        if not is_pointer_value(v):
            return None
        tgt, st = self.resolve(rel, v)
        return tgt if st in ('ok', 'cross') else None

    def attr_ptr(self, rel):
        """任意文件 → fam（属性边 BASEFAMILY）。"""
        v = self.read(rel).get('BASEFAMILY') or ''
        if not is_pointer_value(v):
            return None
        tgt, st = self.resolve(rel, v)
        return tgt if st in ('ok', 'cross') else None

    def geo_edges(self, rel):
        """dev/phm → 子装配与几何（SOLIDMODELn / SUBDEVICEn）。

        → [(key, target, 类别, 是否存在)]；未下载的几何也保留（期望路径）。
        """
        out = []
        for k, v in self.read(rel).items():
            if RX_NUMKEY.search(k) or not is_pointer_value(v):
                continue
            if not k.upper().startswith(('SOLIDMODEL', 'SUBDEVICE')):
                continue
            tgt, st = self.resolve(rel, v)
            if st == 'missing':
                tgt = self.expected_rel(v, rel)
            out.append((k, tgt, ext_of(v).lstrip('.'), tgt in self.files))
        return out

    def geo_children(self, rel):
        """已下载的几何 → [(key, target, 类别)]（兼容旧调用）。"""
        return [(k, t, c) for k, t, c, ok in self.geo_edges(rel) if ok]

    def _ptr_edge(self, rel, key, how):
        """单条具名指针边（模型 / 属性）→ (how, key, target, 存在) 或 None。"""
        v = self.read(rel).get(key) or ''
        if not is_pointer_value(v):
            return None
        tgt, st = self.resolve(rel, v)
        if st == 'missing':
            tgt = self.expected_rel(v, rel)
        return (how, key, tgt, tgt in self.files)

    def edges(self, rel):
        """某文件的**全部指针出边** → [(指针类型, 键, 目标/期望路径, 是否存在)]。

        类型名取自 `ptr_kinds.PTR_KINDS`（9 种），是引用链树与下载清单的唯一数据源。
        不同来源键保留不同边；多义边 target 为空，候选见 pointers()，不自动遍历。
        属性表里每个能点的链接都必须在这里有一条边，否则链上会漏文件
        （实测 s01 的 `BASEFAMILY1..4`、`IFCFILE`、`IFCn`、`SCHn` 曾被漏掉）。
        """
        e = self.files.get(rel)
        if e is None:
            return []
        kv = self.read(rel)
        self.pointers(rel)                      # 先填充类型表，再取引用
        kmap = self.kinds.get(rel, {})
        out, seen = [], set()

        def add(k, v):
            how = kind_name(kmap.get(k, 'D'))
            tgt, st = self.resolve(rel, v)
            if st == 'missing':
                tgt = self.expected_rel(v, rel)
            identity = (rel, k, tgt)
            if identity in seen:
                return
            seen.add(identity)
            out.append((how, k, tgt, tgt in self.files))

        # 层级边放最前，保证树里是 F1→F2→F3→F4 的自然次序
        if e.ext == 'cbm':
            for k, v in self._cbm_edge_values(rel):
                add(k, v)
        # 其余指针一律收进来：BASEFAMILYn / IFCFILE / OBJECTMODELPOINTER /
        # SOLIDMODELn / SUBDEVICEn / SCHn / 任意资料后缀引用都不漏
        for k, v in kv.items():
            if RX_NUMKEY.search(k) or not is_pointer_value(v):
                continue
            add(k, v)
        return out

    def chain_files(self, rel, limit=200000, include_missing=True):
        """沿引用链递归收集下载清单 → [(路径, 深度, 关系, 键, 是否存在)]。

        未下载的引用也列进去（路径是约定的期望路径），这样「只下载到 F2」的
        样本仍能导出 F3/F4/PARTINDEX 待取文件名，按清单继续下载。
        这是文件清单：同一文件只列一次，多义候选不作为已确定的引用或待下载文件。
        """
        out, seen = [], set()
        stack = [(rel, 0, '根', '', rel in self.files)]
        while stack and len(out) < limit:
            cur, d, how, key, ok = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            if not ok and not include_missing:
                continue
            out.append((cur, d, how, key, ok))
            if not ok or cur not in self.files:
                continue
            for how2, key2, tgt, ok2 in reversed(self.edges(cur)):
                if tgt and tgt not in seen:
                    stack.append((tgt, d + 1, how2, key2, ok2))
        return out

    # ---------- 主链（教程 Step 7） ----------
    def _first_out(self, rel, kv):
        """主链下一跳：cbm 优先 SUBSYSTEM → SUBDEVICE/GROUP → 任意 .cbm → 其它指针。"""
        cands = []
        if rel.lower().endswith('.cbm'):
            v = kv.get('SUBSYSTEM')
            if is_pointer_value(v) and ext_of(v) == '.cbm':
                cands.append(('SUBSYSTEM', v))
            for k, v in kv.items():
                if RX_NUMKEY.search(k) or not is_pointer_value(v) or ext_of(v) != '.cbm':
                    continue
                if k.upper().startswith(('SUBSYSTEM', 'SUBDEVICE', 'GROUP')):
                    cands.append((k, v))
            for k, v in kv.items():
                if RX_NUMKEY.search(k) or not is_pointer_value(v) or ext_of(v) != '.cbm':
                    continue
                cands.append((k, v))
        for k, v in kv.items():
            if RX_NUMKEY.search(k) or not is_pointer_value(v):
                continue
            cands.append((k, v))
        for k, v in cands:
            tgt, st = self.resolve(rel, v)
            if st == 'ambiguous':
                return k, ''
            if st in ('ok', 'cross'):
                return k, tgt
        return '', ''

    def chain(self, rel=None, max_depth=12):
        """每层取第一条主链出边，返回 [(rel, ENTITYNAME/标题, key)]。"""
        rel = rel or self._root_cbm()
        out = []
        seen = set()
        while rel and rel in self.files and rel not in seen and len(out) < max_depth:
            seen.add(rel)
            kv = self.read(rel)
            key, nxt = self._first_out(rel, kv)
            out.append((rel, kv.get('ENTITYNAME') or kv.get('NAME') or '', key))
            rel = nxt
        return out

    def _root_cbm(self):
        """根文件：优先 project.cbm，否则取唯一一个没人指向的 cbm。"""
        for rel in self.files:
            if posixpath.basename(rel).lower() == 'project.cbm':
                return rel
        if not self.built:
            return sorted(self.files)[0] if self.files else ''
        pointed = {p.target for ptrs in self.refs.values() for p in ptrs}
        roots = [r for r in self.files if r.lower().endswith('.cbm') and r not in pointed]
        return sorted(roots)[0] if roots else ''

    # ---------- 搜索 ----------
    def search(self, text, limit=200):
        """在键/值里找（大小写不敏感），返回 [(rel, key, value)]。"""
        q = (text or '').strip().lower()
        if not q:
            return []
        out = []
        for rel in self.files:
            kv = self.read(rel)
            for k, v in kv.items():
                if q in k.lower() or q in str(v).lower():
                    out.append((rel, k, v))
                    if len(out) >= limit:
                        return out
        return out
