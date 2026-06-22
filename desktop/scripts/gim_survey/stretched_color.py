#!/usr/bin/env python3
"""变电 XML MOD 的 StretchedBody / Color / Visible 批量复核（Round 6.3 + 6.4）。

对每个变电样本的全部 XML 几何文件（.mod + .gl）统计：
- Color：R/G/B/A 通道分布（top）、RGB 组合 top、越界值
- StretchedBody：Array 点数分布、Normal 向量长度分布（旧基线恒 304.8）
- Visible 取值形态

输出 stdout 汇总 + docs/schema/_generated/<sid>/stretched-color.csv
"""
from __future__ import annotations

import csv
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEMO = ROOT / "demo"
OUT = ROOT / "docs" / "schema" / "_generated"

SUBSTATION_IDS = ["demo-substation", "substation02", "substation03", "substation04"]


def scan(sid: str) -> None:
    root = DEMO / sid
    color_r: Counter = Counter()
    color_g: Counter = Counter()
    color_b: Counter = Counter()
    color_a: Counter = Counter()
    rgb_combo: Counter = Counter()
    out_of_range = 0
    color_total = 0
    sb_count = 0
    sb_points: Counter = Counter()
    normal_len: Counter = Counter()
    visible_vals: Counter = Counter()

    for p in list(root.rglob("*.mod")) + list(root.rglob("*.gl")):
        try:
            text = p.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        if "<Entity" not in text:
            continue

        for m in re.finditer(r'<Color\b([^/>]*)/?>', text):
            attrs = dict(re.findall(r'(\w+)\s*=\s*"([^"]*)"', m.group(1)))
            r, g, b, a = (attrs.get(k) for k in ("R", "G", "B", "A"))
            color_total += 1
            try:
                ri, gi, bi, ai = int(r), int(g), int(b), int(a)
                color_r[ri] += 1; color_g[gi] += 1
                color_b[bi] += 1; color_a[ai] += 1
                rgb_combo[(ri, gi, bi)] += 1
                if not all(0 <= v <= 255 for v in (ri, gi, bi)) or not 0 <= ai <= 100:
                    out_of_range += 1
            except (TypeError, ValueError):
                pass

        for m in re.finditer(r'<StretchedBody\b([^>]*)>', text):
            sb_count += 1
            attrs = m.group(1)
            am = re.search(r'Array\s*=\s*"([^"]*)"', attrs)
            if am:
                pts = [s for s in am.group(1).split(";") if s.strip()]
                sb_points[len(pts)] += 1
            nm = re.search(r'Normal\s*=\s*"([^"]*)"', attrs)
            if nm:
                try:
                    x, y, z = (float(v) for v in nm.group(1).split(","))
                    L = round((x * x + y * y + z * z) ** 0.5, 2)
                    normal_len[L] += 1
                except ValueError:
                    pass

        for m in re.finditer(r'<Entity\b[^>]*Visible="([^"]*)"', text):
            visible_vals[m.group(1)] += 1

    print(f"\n=== {sid} ===")
    print(f"  Color 总数={color_total} 越界={out_of_range}")
    print(f"  R top5: {color_r.most_common(5)}")
    print(f"  G top5: {color_g.most_common(5)}")
    print(f"  B top5: {color_b.most_common(5)}")
    print(f"  A 分布: {color_a.most_common(8)}")
    print(f"  RGB 组合 top5: {rgb_combo.most_common(5)}")
    print(f"  StretchedBody 总数={sb_count}")
    if sb_points or normal_len:
        pts_sorted = sorted(sb_points.items())
        lens = sorted(normal_len.items(), key=lambda kv: -kv[1])
        all_pts = [n for k, c in pts_sorted for n in [k] * 0]
        print(f"  Array 点数 min/max: {pts_sorted[0][0]}/{pts_sorted[-1][0]}  变体数={len(pts_sorted)}")
        print(f"  Normal 长度分布 top5: {lens[:5]}  变体数={len(lens)}")
    print(f"  Visible 形态: {dict(visible_vals.most_common(6))}")

    with open(OUT / sid / "stretched-color.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["item", "value", "count"])
        w.writerow(["colorTotal", "", color_total])
        w.writerow(["colorOutOfRange", "", out_of_range])
        for k, n in color_r.most_common(20): w.writerow(["channelR", k, n])
        for k, n in color_g.most_common(20): w.writerow(["channelG", k, n])
        for k, n in color_b.most_common(20): w.writerow(["channelB", k, n])
        for k, n in color_a.most_common(20): w.writerow(["channelA", k, n])
        for k, n in rgb_combo.most_common(20): w.writerow(["rgbCombo", str(k), n])
        w.writerow(["stretchedBodyTotal", "", sb_count])
        for k, n in sorted(sb_points.items()): w.writerow(["arrayPoints", k, n])
        for k, n in sorted(normal_len.items()): w.writerow(["normalLength", k, n])
        for k, n in visible_vals.most_common(): w.writerow([f"visible:{k}", "", n])


if __name__ == "__main__":
    for sid in SUBSTATION_IDS:
        scan(sid)
