#!/usr/bin/env python3
"""IFCGUID 文本级命中复算（Round 2.5），4 个变电样本全量。

对每个变电样本：
1. 从 CBM 收集 (IFCFILE, IFCGUID) 对
2. 读入对应 IFC 文件全文，检查 GUID 是否出现（精确 / 大小写不敏感 / 任意 IFC 兜底）
3. 对硬未命中输出 CBM 上下文分型（ENTITYNAME / OBJECTMODELPOINTER 是否为空）

输出 docs/schema/_generated/<sid>/ifc-guid-summary.csv + 汇总 stdout。
"""
from __future__ import annotations

import csv
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEMO = ROOT / "demo"
OUT = ROOT / "docs" / "schema" / "_generated"

SUBSTATION_IDS = ["demo-substation", "substation02", "substation03", "substation04"]

GUID_RE = re.compile(r"^[0-9A-Za-z_$]{22}$")


def scan(sid: str) -> None:
    root = DEMO / sid
    pairs: dict[str, set[str]] = defaultdict(set)   # ifcfile -> guids
    ctx: dict[str, dict[str, str]] = {}             # guid -> entityName/objectModelPointer

    for p in root.rglob("*.cbm"):
        ent = omp = ""
        ifile = ""
        guid = ""
        for line in p.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            k, _, v = line.partition("=")
            ku = k.strip().upper()
            v = v.strip()
            if ku == "ENTITYNAME":
                ent = v
            elif ku == "OBJECTMODELPOINTER":
                omp = v
            elif ku == "IFCFILE" and v.lower().endswith(".ifc"):
                ifile = v
            elif ku == "IFCGUID" and GUID_RE.match(v):
                guid = v
        if ifile and guid:
            pairs[ifile].add(guid)
            ctx.setdefault(guid, {"entity": ent or "?", "ompEmpty": "yes" if not omp else "no"})

    # 读入全部 IFC 文本
    ifc_texts: dict[str, str] = {}
    ifc_texts_lower: dict[str, str] = {}
    for p in root.rglob("*.ifc"):
        t = p.read_text(encoding="utf-8", errors="replace")
        ifc_texts[p.name.lower()] = t
        ifc_texts_lower[p.name.lower()] = t.lower()

    all_text = "\n".join(ifc_texts.values())
    all_lower = all_text.lower()

    rows = []
    total = exact_hit = ci_hit_declared = hard_miss = 0
    hard_by_entity: Counter = Counter()
    for ifile, guids in sorted(pairs.items()):
        key = ifile.lower().rsplit("/", 1)[-1]
        text = ifc_texts.get(key)
        text_l = ifc_texts_lower.get(key)
        for g in sorted(guids):
            total += 1
            exact = bool(text) and g in text
            ci = False
            if exact:
                exact_hit += 1
            elif text_l is not None:
                ci = g.lower() in text_l
                if ci:
                    ci_hit_declared += 1
            if not exact and not ci:
                # 任意 IFC 兜底
                if g.lower() in all_lower:
                    ci += True
                    ci_hit_declared += 0  # 已计 declared? no—declared 未命中才走这
                hard_miss += 1
                c = ctx.get(g, {})
                hard_by_entity[(c.get("entity", "?"), c.get("ompEmpty", "?"))] += 1
            rows.append((ifile, g, "exact" if exact else ("ci" if ci else "missing")))

    out_dir = OUT / sid
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / "ifc-guid-detail.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["ifcFile", "guid", "status"])
        w.writerows(rows)

    print(f"\n=== {sid} ===")
    if not total:
        print("  无 (IFCFILE, IFCGUID) 声明对（可能无 IFCGUID 字段或格式不同）")
        return
    print(f"  声明对总数(去重)={total} 精确命中={exact_hit} ({exact_hit/total*100:.2f}%) "
          f"大小写不敏感命中(声明文件)={ci_hit_declared} 硬未命中={hard_miss} ({hard_miss/total*100:.2f}%)")
    print(f"  IFC 文件数={len(ifc_texts)} 唯一GUID数={len(ctx)}")
    print(f"  硬未命中上下文分布: {dict(hard_by_entity.most_common(6))}")


if __name__ == "__main__":
    for sid in SUBSTATION_IDS:
        scan(sid)
