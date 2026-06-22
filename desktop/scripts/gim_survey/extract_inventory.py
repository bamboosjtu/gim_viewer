#!/usr/bin/env python3
"""GIM 样本批量解压 + 文件清单统计（skill: gim-sample-verification / Round 1.2 + 1.3）。

- 用 py7zr 解压 demo/*.gim 到 demo/<sampleId>/（已解压则跳过）
- 统计每个样本：扩展名 × 顶层目录交叉分布、文本/二进制粗判
- 输出 docs/schema/_generated/file-inventory.csv 与 file-inventory-summary.md

sampleId 映射表维护在本脚本 SAMPLES 常量中（与 00-sample-corpus.md 一致）。
"""
from __future__ import annotations

import csv
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

import py7zr

ROOT = Path(__file__).resolve().parents[3]
DEMO = ROOT / "demo"
OUT = ROOT / "docs" / "schema" / "_generated"

# 文件名 -> sampleId（与 docs/schema/00-sample-corpus.md 保持一致）
SAMPLES: dict[str, str] = {
    "substation01.gim": "demo-substation",
    "substation02.gim": "substation02",
    "substation03.gim": "substation03",
    "substation04.gim": "substation04",
    "line01.gim": "demo-line1",
    "line02.gim": "line02",
    "line03.gim": "line03",
    "line04.gim": "line04",
    "line05.gim": "line05",
    "line06.gim": "line06",
}


SIG_7Z = b"7z\xbc\xaf\x27\x1c"


def locate_payload(data: bytes) -> int:
    idx = data.find(SIG_7Z, 7, 7 + 1024 * 1024)
    if idx < 0:
        idx = data.find(b"PK\x03\x04", 7, 7 + 1024 * 1024)
    if idx < 0:
        raise ValueError("payload 签名未找到")
    return idx


def extract_all() -> None:
    for fname, sid in SAMPLES.items():
        gim = DEMO / fname
        target = DEMO / sid
        if not gim.exists():
            print(f"[skip] {fname} 不存在")
            continue
        if target.is_dir() and any(target.iterdir()):
            print(f"[skip] {sid} 已解压")
            continue
        t0 = time.time()
        print(f"[7z ] {sid} <- {fname} ...", flush=True)
        data = gim.read_bytes()
        off = locate_payload(data)
        payload_path = DEMO / f"_{sid}.payload.7z"
        payload_path.write_bytes(data[off:])
        try:
            with py7zr.SevenZipFile(payload_path) as z:
                z.extractall(target)
        finally:
            payload_path.unlink(missing_ok=True)
        print(f"[done] {sid} offset={off} 用时 {time.time() - t0:.0f}s", flush=True)


def classify_text(path: Path) -> str:
    try:
        head = path.open("rb").read(4096)
    except OSError:
        return "unreadable"
    if not head:
        return "empty"
    if b"\x00" in head:
        return "binary-like"
    try:
        text = head.decode("utf-8")
    except UnicodeDecodeError:
        return "unknown-text"
    if text.lstrip().startswith("<?xml") or text.lstrip().startswith("<"):
        return "text-like-xml"
    if "=" in text or ";" in text or "," in text:
        return "text-like"
    return "unknown-text"


def inventory(sid: str) -> dict:
    root = DEMO / sid
    ext_counter: Counter[str] = Counter()
    dir_ext_counter: Counter[tuple[str, str]] = Counter()
    text_class: Counter[tuple[str, str]] = Counter()
    total = 0
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        total += 1
        rel = p.relative_to(root)
        top = rel.parts[0] if len(rel.parts) > 1 else "(root)"
        ext = p.suffix.lower() or "(none)"
        ext_counter[ext] += 1
        dir_ext_counter[(top, ext)] += 1
    # 文本/二进制粗判只对关键扩展名抽样全量执行
    for p in root.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in {
            ".cbm", ".fam", ".dev", ".phm", ".mod", ".stl", ".ifc", ".sch", ".std", ".sld"
        }:
            continue
        top = p.relative_to(root).parts[0]
        text_class[(p.suffix.lower(), classify_text(p))] += 1
    return {
        "sid": sid,
        "total": total,
        "ext": ext_counter,
        "dir_ext": dir_ext_counter,
        "text_class": text_class,
    }


def main() -> None:
    extract_all()
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for fname, sid in sorted(SAMPLES.items(), key=lambda kv: kv[1]):
        if not (DEMO / sid).is_dir():
            continue
        inv = inventory(sid)
        rows.append(inv)
        print(f"\n=== {sid} ({inv['total']} files) ===")
        for ext, n in inv["ext"].most_common():
            print(f"  {ext:<8} {n:>7}")

    with open(OUT / "file-inventory.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["sampleId", "topDir", "ext", "count"])
        for inv in rows:
            for (top, ext), n in sorted(inv["dir_ext"].items()):
                w.writerow([inv["sid"], top, ext, n])
    with open(OUT / "text-binary-survey.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["sampleId", "ext", "textClass", "count"])
        for inv in rows:
            for (ext, cls), n in sorted(inv["text_class"].items()):
                w.writerow([inv["sid"], ext, cls, n])
    print("\nCSV -> file-inventory.csv, text-binary-survey.csv")


if __name__ == "__main__":
    main()
