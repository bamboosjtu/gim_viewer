# -*- coding: utf-8 -*-
"""cli —— GIM 文件浏览器命令行入口

  python gim_reader.py <解包目录>          打开浏览器（默认）
  python gim_reader.py --smoke <目录>      冒烟：文件表 / 指针体检 / 主链（无 Qt）
  python gim_reader.py --guitest <目录>    界面自检：跳一次指针、退回来、截图
  python gim_reader.py --legacy <目录>     旧的实体/融合树界面（仅源码运行，exe 不含）
"""
import sys
import time

from gimbrowse import Index
from ptr_kinds import PTR_KINDS, KIND_ORDER, KIND_GROUP, KIND_NAME


def smoke(d):
    """无 GUI 冒烟：文件表 → 指针索引 → 体检 → 主链。"""
    t0 = time.time()
    ix = Index(d)
    print('目录:', d)
    print('文件:', ix.stat(), '合计', len(ix.files))
    t1 = time.time()
    st = ix.build_refs(lambda m: None)
    print('索引用时 %.1fs' % (time.time() - t1))
    print('指针: 文件 %s · 指针 %s · 可达 %s · 跨目录 %s · 多义 %s · 悬空 %s'
          % (st['文件'], st['指针'], st['可达'], st['跨目录'], st['多义'], st['悬空']))
    print('按后缀:', st['按后缀'])
    print('指针类型（%d 种 / %d 大类）:' % (len(PTR_KINDS), len(set(KIND_GROUP.values()))))
    for c in KIND_ORDER:
        n = st['按类型'].get(c, 0)
        m = st['标识按类型'].get(c, 0)
        extra = (' · 标识键 %d 条（不跳转）' % m) if m else ''
        print('   %-4s %-10s %-4s %6d 条%s' % (c, KIND_NAME[c], KIND_GROUP[c], n, extra))
    print('   标识/占位键（不跳转）: %d 条' % st['标识键'])
    print('按大类:', st['按大类'])
    print('主链:')
    for rel, nm, k in ix.chain():
        print('   %-54s %-12s %s' % (rel, nm or '-', k or '-'))
    rows = ix.chain_files(ix._root_cbm())
    print('引用链清单: %d 行 · 已下载 %d · 待下载 %d'
          % (len(rows), sum(1 for x in rows if x[4]),
             sum(1 for x in rows if not x[4])))
    miss = st['悬空样例']
    if miss:
        print('悬空样例（前 5）:')
        for rel, k, v in miss[:5]:
            print('   %s  %s = %s' % (rel, k, v))
    print('总用时 %.1fs' % (time.time() - t0))


def main():
    if '--self-check' in sys.argv:
        from PySide6 import QtWidgets
        return
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    if '--legacy' in sys.argv:                 # 旧界面：实体四本账 / 融合树
        from gim_gui import run_gui
        run_gui(args[0] if args else None, selftest='--guitest' in sys.argv)
        return
    if '--smoke' in sys.argv:
        smoke(args[0] if args else '.')
        return
    from browse_gui import run_browser
    run_browser(args[0] if args else None, selftest='--guitest' in sys.argv)


if __name__ == '__main__':
    main()
