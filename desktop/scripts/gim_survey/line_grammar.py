#!/usr/bin/env python3
"""线路 MOD 4 类文本格式族 grammar 批量验证（skill Round 7）。

对全部线路样本逐类检查：
- TEXT_HNUM_COMMA_RECORD：HNum 分布、Body/Leg 记录、R/G/P token 数变体
- TEXT_POINT_LINE：POINT/LINE token 数、CODE 值分布、type 字段取值
- TEXT_SECTION_KV_RECORD：section header 种类、BoltNum 取值、BoltN token 数
- TEXT_KEY_VALUE：key 签名分组（Tower_Device 小写 vs WIRE 大写 vs 新签名）

输出 docs/schema/_generated/line-grammar-summary.csv + stdout。
"""
from __future__ import annotations

import csv
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEMO = ROOT / "demo"
OUT = ROOT / "docs" / "schema" / "_generated"

LINE_SAMPLES = ["demo-line1", "line02", "line03",
                "line04", "line05", "line06"]


def classify(lines: list[str]) -> str:
    if not lines:
        return "EMPTY"
    kv = lambda s: "=" in s
    if re.match(r"(?i)^hnum\s*,", lines[0]):
        return "HNUM"
    up = [l.upper() for l in lines[:50]]
    if any(l.startswith("CODE=") for l in up) and any(l.startswith("POINTNUM=") for l in up):
        return "POINT_LINE"
    if not kv(lines[0]) and sum(kv(l) for l in lines[1:]) >= max(1, len(lines) // 2):
        return "SECTION_KV"
    if sum(kv(l) for l in lines) >= len(lines) * 0.8:
        return "KEY_VALUE"
    return "UNKNOWN"


def analyze_hnum(path: Path, stat: dict):
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    m = re.match(r"(?i)^hnum\s*,\s*(\d+)", lines[0])
    if m:
        stat["hnum_values"][m.group(1)] += 1
    r_tok = stat["r_tokens"]
    g_tok = stat["g_tokens"]
    p_coords = stat["p_xyz"]
    other_first = stat["other_record_heads"]
    body_count = 0
    for ln in lines[1:]:
        t = ln.split(",")
        head = t[0].strip().upper()
        if head == "R":
            r_tok[len(t)] += 1
        elif head == "G":
            g_tok[len(t)] += 1
            if len(t) >= 6 and t[5].lstrip("-").replace(".", "", 1).isdigit():
                pass
        elif head == "P":
            if len(t) >= 4:
                try:
                    p_coords.append((float(t[-3]), float(t[-2]), float(t[-1])))
                except ValueError:
                    pass
        elif re.match(r"^HSUBLEG\d*$", head) or re.match(r"^HLEG\d*$", head):
            pass
        elif "=" not in ln:
            other_first[t[0]] += 1
    _ = body_count


def analyze_point_line(path: Path, stat: dict):
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    code = next((l.split("=", 1)[1] for l in lines[:20]
                 if l.upper().startswith("CODE=")), "")
    stat["code_values"][code] += 1
    for ln in lines:
        if "=" not in ln:
            continue
        k, _, v = ln.partition("=")
        ku = re.sub(r"\d+$", "", k.strip()).upper()
        t = v.split(",")
        if ku == "POINT":
            stat["point_tokens"][len(t)] += 1
            if len(t) == 5:
                stat["point_type"][t[4]] += 1
        elif ku == "LINE":
            stat["line_tokens"][len(t)] += 1


def analyze_section_kv(path: Path, stat: dict):
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    header = lines[0]
    stat["headers"][header] += 1
    numkv = next((l for l in lines[1:3] if "=" in l), "")
    if "NUM" in numkv.upper():
        val = numkv.split("=", 1)[1]
        stat["bolt_num"][val] += 1
    bolt_lines = [l for l in lines if re.match(r"(?i)^bolt\d+=", l)]
    for bl in bolt_lines:
        _, _, val = bl.partition("=")
        segs = val.split(";")
        stat["bolt_segs"][len(segs)] += 1
        stat["bolt_seg1_tokens"][len(segs[0].split(","))] += 1
        for s in segs[1:]:
            stat["bolt_seg_rest_tokens"][len(s.split(","))] += 1


def analyze_key_value(path: Path, stat: dict):
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    keys = tuple(k.strip() for k in (l.split("=", 1)[0] for l in text.splitlines())
                 if k.strip())
    stat["kv_signatures"][keys] += 1


def main() -> None:
    summary: dict[str, dict] = {}
    for sid in LINE_SAMPLES:
        root = DEMO / sid / "Mod"
        stat = {
            "hnum_values": Counter(), "r_tokens": Counter(), "g_tokens": Counter(),
            "other_record_heads": Counter(), "p_xyz": [],
            "code_values": Counter(), "point_tokens": Counter(), "line_tokens": Counter(),
            "point_type": Counter(),
            "headers": Counter(), "bolt_num": Counter(), "bolt_segs": Counter(),
            "bolt_seg1_tokens": Counter(), "bolt_seg_rest_tokens": Counter(),
            "kv_signatures": Counter(),
        }
        counts = Counter()
        for p in root.rglob("*.mod"):
            try:
                text = p.read_text(encoding="utf-8-sig", errors="replace")
            except OSError:
                continue
            lines = [l.strip() for l in text.splitlines() if l.strip()]
            kind = classify(lines)
            counts[kind] += 1
            if kind == "HNUM":
                analyze_hnum(p, stat)
            elif kind == "POINT_LINE":
                analyze_point_line(p, stat)
            elif kind == "SECTION_KV":
                analyze_section_kv(p, stat)
            elif kind == "KEY_VALUE":
                analyze_key_value(p, stat)
        stat["counts"] = counts
        summary[sid] = stat

        print(f"\n=== {sid} ===")
        print("  kinds:", dict(counts))
        print("  HNum 值分布(top):", dict(stat["hnum_values"].most_common(6)))
        print("  R token 变体:", dict(sorted(stat["r_tokens"].items())))
        print("  G token 变体:", dict(sorted(stat["g_tokens"].items())))
        print("  其他记录头(top):", dict(stat["other_record_heads"].most_common(6)))
        print("  CODE 值分布:", dict(stat["code_values"].most_common(12)))
        print("  POINT token 数:", dict(sorted(stat["point_tokens"].items())),
              " type 字段:", dict(stat["point_type"].most_common(6)))
        print("  LINE token 数:", dict(sorted(stat["line_tokens"].items())))
        print("  SECTION headers:", dict(stat["headers"].most_common(5)),
              " BoltNum:", dict(stat["bolt_num"]))
        print("  Bolt 分号段数:", dict(sorted(stat["bolt_segs"].items())),
              " seg1 token 数:", dict(sorted(stat["bolt_seg1_tokens"].items())),
              " 后继段 token 数:", dict(sorted(stat["bolt_seg_rest_tokens"].items())))
        sigs = {",".join(k)[:90]: n for k, n in stat["kv_signatures"].most_common(8)}
        print("  KV 签名:")
        for s, n in sigs.items():
            print(f"    [{n:>4}] {s}")

    # 汇总 CSV（KV 签名跨样本）
    with open(OUT / "line-grammar-summary.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["sampleId", "item", "value", "count"])
        for sid, st in summary.items():
            for name in ("hnum_values", "r_tokens", "g_tokens", "code_values",
                         "point_tokens", "line_tokens", "point_type", "headers",
                         "bolt_num", "bolt_segs", "bolt_seg1_tokens", "bolt_seg_rest_tokens"):
                for v, n in st[name].most_common():
                    w.writerow([sid, name, v, n])
            for k, n in st["kv_signatures"].most_common():
                w.writerow([sid, "kv_signature", "|".join(k)[:200], n])
    print("\nCSV -> line-grammar-summary.csv")


if __name__ == "__main__":
    main()
