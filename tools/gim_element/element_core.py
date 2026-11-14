# -*- coding: utf-8 -*-
"""Standalone standard recognition: container input, orchestration and reports."""
import os,json,shutil,tempfile,time
import entity_std as S
G_DEV,G_MAT,G_STR,G_OTH='设备','装置性材料','构件','其他'
T_DEV,T_IFC='dev','ifc'
TRACK_NAME={T_DEV:'dev 轨道',T_IFC:'ifc 轨道'}

MAGIC_7Z = b'7z\xbc\xaf\x27\x1c'


def sniff(path):
    with open(path, 'rb') as f:
        head = f.read(8)
    magic = head.rstrip(b'\x00')
    if magic.startswith(b'GIMPKG'):
        return 'gimpkg'
    if head.startswith(MAGIC_7Z):
        return 'raw7z'
    if head.startswith(b'PK'):
        return 'zip'
    return 'unknown'


def unpack(path, out_dir):
    """把 .gim 解开到 out_dir，返回 (kind, note)。"""
    kind = sniff(path)
    os.makedirs(out_dir, exist_ok=True)
    if kind == 'zip':
        import zipfile
        with zipfile.ZipFile(path) as z:
            z.extractall(out_dir)
        return kind, ''
    if kind == 'gimpkg':
        with open(path, 'rb') as f:
            buf = f.read(8192)
        off = buf.find(MAGIC_7Z)
        if off < 0:
            raise ValueError('未找到 7z 签名，容器可能损坏或加密')
        payload = os.path.join(out_dir, '_payload.7z')
        with open(path, 'rb') as f, open(payload, 'wb') as o:
            f.seek(off)
            shutil.copyfileobj(f, o)
        src = payload
    elif kind == 'raw7z':
        src = path
    else:
        raise ValueError('无法识别的容器格式（既非 GIMPKGS 头也非 7z/zip）')
    import py7zr
    with py7zr.SevenZipFile(src) as z:
        if z.needs_password():
            raise ValueError('压缩包已加密，暂不支持')
        z.extractall(out_dir)
    if kind == 'gimpkg':
        try:
            os.remove(payload)
        except OSError:
            pass
    return kind, ''


def scan(path, progress=None, work_dir=None, cleanup=True):
    """解析一个 GIM 工程或单体设备包。

    path: .gim 文件或已解包目录
    返回 result dict（可 json 化）。
    """
    prog = progress or (lambda m: None)
    t0 = time.time()
    tmp = work_dir or tempfile.mkdtemp(prefix='gimelem_')
    own = work_dir is None
    try:
        container, note = '', ''
        if os.path.isfile(path):
            prog('解包 %s…' % os.path.basename(path))
            container, note = unpack(path, tmp)
            root = tmp
        else:
            root = path

        from standard_recognition import scan_standard, ledger_from_standard
        import hashlib
        scope = None
        if os.path.isfile(path):
            digest = hashlib.sha256()
            with open(path, 'rb') as source:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    digest.update(block)
            scope = digest.hexdigest()
        prog('运行工具内置标准实体识别算法…')
        data = scan_standard(root, scope)
        result = ledger_from_standard(data)
        result['meta'] = {'source': os.path.abspath(path), 'kind': 'gim文件' if os.path.isfile(path) else '解包目录',
                          'container': container, 'containerNote': note, 'elapsed': round(time.time() - t0, 1),
                          'engine': 'independent-python', 'engineRulesVersion': data['engine']['rulesVersion'],
                          'complete': data['complete'], 'incompleteReasons': data['incompleteReasons']}
        prog('标准实体识别完成；整体 %s，待归 %s' % (result['stats']['整体'], result['stats']['待归整体']))
        return result
    finally:
        if own and cleanup:
            shutil.rmtree(tmp, ignore_errors=True)


_STYLE = """
body{font-family:"Microsoft YaHei",sans-serif;max-width:1080px;margin:0 auto;
padding:0 20px 50px;color:#1c1c1e;line-height:1.65;font-size:14px;background:#fff}
h1{font-size:22px;margin:26px 0 4px}h2{font-size:16px;color:#1a5fb4;margin:30px 0 8px;
padding-left:10px;border-left:4px solid #1a5fb4}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.kpi div{background:#f4f8fd;border:1px solid #c9dbf5;border-radius:10px;padding:10px 14px}
.kpi b{display:block;font-size:22px;color:#1a5fb4}
.kpi span{font-size:12px;color:#5b6472}
table{border-collapse:collapse;width:100%;font-size:12.5px;margin:10px 0}
th,td{border:1px solid #d8dee8;padding:4px 8px;text-align:left}
th{background:#f4f7fc}.n{text-align:right;font-variant-numeric:tabular-nums}
.small{font-size:12px;color:#5b6472}
"""


def build_html(result):
    from html import escape
    text = lambda value: escape(str(value), quote=True)
    m, st, tt, rows = result['meta'], result['stats'], result['totals'], result['rows']
    out = ['<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
           '<title>GIM 实体盘点报告</title><style>', _STYLE, '</style></head><body>']
    out.append('<h1>GIM 实体盘点报告</h1>')
    out.append('<p class="small">来源：%s（%s%s） · 用时 %.1f 秒 · 生成 %s</p>'
               % (text(m['source']), text(m['kind']),
                  '，容器 ' + text(m['container']) if m['container'] else '',
                  m['elapsed'], time.strftime('%Y-%m-%d %H:%M')))
    out.append('<div class="kpi">')
    out.append('<div><b>%s</b><span>设备（台，已确认 %s · 候选 %s；另附件 %s + 部件上卷 %s）</span></div>'
               % (format(tt[G_DEV]['台数'], ','),
                  format(tt[G_DEV].get('已确认', 0), ','),
                  format(tt[G_DEV].get('候选', 0), ','),
                  format(tt[G_DEV].get('附件并入', 0), ','),
                  format(tt[G_DEV].get('部件上卷', 0), ',')))
    for g, unit in ((G_MAT, '装置性材料（件）'), (G_STR, '构件（件）'), (G_OTH, '其他（条）')):
        n = tt[g]['dev'] + tt[g]['ifc']
        out.append('<div><b>%s</b><span>%s · 已确认 %s / 候选 %s / 未确认 %s</span></div>'
                   % (format(n, ','), unit, format(tt[g].get('已确认', 0), ','),
                      format(tt[g].get('候选', 0), ','),
                      format(tt[g].get('未确认', 0), ',')))
    out.append('</div>')
    out.append('<p class="small">dev 轨道：dev位 %s · cbm %s · fam %s · dev %s ｜ '
               'ifc 轨道：文件 %s · 实体行 %s · 暴露层 %s · 封装内部 %s</p>'
               % (format(st.get('dev位', 0), ','), format(st.get('cbm文件', 0), ','),
                  format(st.get('fam文件', 0), ','), format(st.get('dev文件', 0), ','),
                  format(st.get('ifc文件', 0), ','), format(st.get('ifc实体行', 0), ','),
                  format(st.get('ifc暴露层', 0), ','), format(st.get('ifc封装内部', 0), ',')))
    for g in (G_DEV, G_MAT, G_STR, G_OTH):
        sub = [r for r in rows if r['group'] == g and (r['dev'] or r['ifc'])]
        if not sub:
            continue
        # 报告与界面同口径：按目录编码排序（E01→E19→E-T；M01→M09；C-A1→C-D6），
        # 设备内 E16 细分按标准顺序，其余同编码内按数量降序。
        sub.sort(key=lambda r: (S.order_key(r.get('code', '')),
                                S.E16_SEQ.get(r.get('std_sub') or '', 99) if g == G_DEV else 99,
                                r['cat'], -r['total']))
        out.append('<h2>%s</h2><table><tr><th>编码</th><th>类别</th><th>子类</th>'
                   '<th>名称模板</th><th class="n">dev 轨道</th><th class="n">ifc 轨道</th>'
                   '<th class="n">合计</th><th>状态</th></tr>' % g)
        for r in sub:
            stt = r.get('st') or {}
            stxt = ' / '.join('%s %s' % (k, format(v, ','))
                              for k, v in ((S.ST_OK, stt.get(S.ST_OK, 0)),
                                           (S.ST_CAND, stt.get(S.ST_CAND, 0)),
                                           (S.ST_UNC, stt.get(S.ST_UNC, 0))) if v)
            out.append('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td>'
                       '<td class="n">%s</td><td class="n">%s</td><td class="n">%s</td>'
                       '<td class="small">%s</td></tr>'
                       % (text(r.get('code', '')), text(r['cat']), text(r['sub'] or '—'),
                          text(r['template'] or '—'),
                          format(r['dev'], ','), format(r['ifc'], ','),
                          format(r['total'], ','), text(stxt or '—')))
        out.append('</table>')
    if result.get('entityTree'):
        out.append('<h2>整体—部件与来源关系</h2><p class="small">属性引用不生成物理根；归属候选与未决结果保留，原始父级不会被改写。</p>')
        for entity in result['entityTree']:
            out.append('<details><summary>%s · %s</summary><table><tr><th>来源名称</th><th>类型/角色</th><th>归属状态</th><th>原始父级</th><th>sourceId</th></tr>' % (text(entity['name']),text(entity['category'])))
            for part in entity['parts']:
                interpretation=part['interpretation']
                out.append('<tr><td>%s</td><td>%s · %s</td><td>%s</td><td>%s</td><td>%s</td></tr>' % (text(part['name']),text(part['type']),text(interpretation['meaning']),text(interpretation.get('membershipStatus','')),text(part['rawParent']),text(part['sourceId'])))
            out.append('</table></details>')
    out.append('</body></html>')
    return '\n'.join(out)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    import argparse
    ap = argparse.ArgumentParser(description='GIM 实体盘点（设备/装置性材料/构件/其他）')
    ap.add_argument('path', help='.gim 文件或解包目录')
    ap.add_argument('--json', dest='json_out', help='输出 JSON 路径')
    ap.add_argument('--html', dest='html_out', help='输出 HTML 报告路径')
    ap.add_argument('--csv', dest='csv_out', help='输出 CSV 路径')
    args = ap.parse_args()

    last = ['']
    def prog(msg):
        last[0] = msg
        print(msg, flush=True)

    result = scan(args.path, prog)
    tt = result['totals']
    print('\n===== 盘点结果 =====')
    print('设备        : %s 台（已确认 %s · 候选 %s；dev %s + ifc %s；附件 %s 并入本体、部件 %s 上卷）'
          % (format(tt[G_DEV]['台数'], ','),
             format(tt[G_DEV].get('已确认', 0), ','), format(tt[G_DEV].get('候选', 0), ','),
             format(tt[G_DEV]['dev'], ','),
             format(tt[G_DEV]['ifc'], ','), format(tt[G_DEV].get('附件并入', 0), ','),
             format(tt[G_DEV].get('部件上卷', 0), ',')))
    for g in (G_MAT, G_STR, G_OTH):
        print('%s : %s（dev %s + ifc %s；已确认 %s · 候选 %s · 未确认 %s）'
              % (g.ljust(6, '　'), format(tt[g]['dev'] + tt[g]['ifc'], ','),
                 format(tt[g]['dev'], ','), format(tt[g]['ifc'], ','),
                 format(tt[g].get('已确认', 0), ','), format(tt[g].get('候选', 0), ','),
                 format(tt[g].get('未确认', 0), ',')))
    if args.json_out:
        with open(args.json_out, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        print('JSON ->', args.json_out)
    if args.html_out:
        with open(args.html_out, 'w', encoding='utf-8') as f:
            f.write(build_html(result))
        print('HTML ->', args.html_out)
    if args.csv_out:
        import csv
        with open(args.csv_out, 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.writer(f)
            w.writerow(['组', '编码', '类别', '子类', '名称模板', 'dev轨道', 'ifc轨道', '合计',
                        '已确认', '候选', '未确认'])
            for r in result['rows']:
                stt = r.get('st') or {}
                w.writerow([r['group'], r.get('code', ''), r['cat'], r['sub'], r['template'],
                            r['dev'], r['ifc'], r['total'],
                            stt.get(S.ST_OK, 0), stt.get(S.ST_CAND, 0), stt.get(S.ST_UNC, 0)])
        print('CSV ->', args.csv_out)


if __name__ == '__main__':
    main()
