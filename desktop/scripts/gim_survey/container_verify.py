#!/usr/bin/env python3
"""GIM 容器层批量验证（skill: gim-sample-verification / Round 1.1）。

对 demo/*.gim 逐个计算：
- SHA-256、大小、mtime
- 头部魔数（前 7 字节 ASCII：GIMPKGS=变电 / GIMPKGT=线路）
- 头部固定布局元数据字段（工程名/设计单位/业主/导出软件/导出日期）
- payload 压缩格式（7z / ZIP 签名，在头部之后 1MB 窗口内搜索）与偏移

输出：docs/schema/_generated/container-survey.csv + stdout 汇总表。
用法：python desktop/scripts/gim_survey/container_verify.py
"""
from __future__ import annotations

import csv
import hashlib
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEMO = ROOT / "demo"
OUT = ROOT / "docs" / "schema" / "_generated"

SIG_7Z = b"7z\xbc\xaf\x27\x1c"
SIG_ZIP = b"PK\x03\x04"
WINDOW = 1024 * 1024

# 实证发现的头部固定布局（UTF-8，\0 填充，各字段独立区段）：
#   [0:7]     魔数 GIMPKGS/GIMPKGT
#   [16:?]    工程/项目文件名（含 .gim 后缀）
#   [272:?]   设计单位
#   [336:?]   业主/建设单位
#   [592:?]   导出软件
#   [720:?]   导出日期时间（ASCII）
HEADER_FIELDS = [
    (16, "proj_name"),
    (272, "designer"),
    (336, "owner"),
    (592, "software"),
    (720, "export_date"),
]


def find_payload(data: bytes, search_from: int) -> tuple[str, int] | None:
    end = min(len(data), search_from + WINDOW)
    best: tuple[str, int] | None = None
    for name, sig in (("7z", SIG_7Z), ("zip", SIG_ZIP)):
        idx = data.find(sig, search_from, end)
        if idx >= 0 and (best is None or idx < best[1]):
            best = (name, idx)
    return best


def read_field(data: bytes, start: int) -> str:
    end = data.find(b"\x00", start)
    raw = data[start:end] if end >= 0 else data[start:start + 256]
    try:
        return raw.decode("utf-8").strip()
    except UnicodeDecodeError:
        return raw.decode("gbk", errors="replace").strip()


def survey(path: Path) -> dict:
    data = path.read_bytes()
    magic = data[:7].decode("ascii", errors="replace")
    payload = find_payload(data, 7)
    h = hashlib.sha256(data).hexdigest().upper()
    st = path.stat()
    row = {
        "file": path.name,
        "size": st.st_size,
        "sha256": h,
        "magic": magic,
        "payload_format": payload[0] if payload else "NOT_FOUND",
        "payload_offset": payload[1] if payload else -1,
        "type_guess": ("substation" if magic == "GIMPKGS" else "line" if magic == "GIMPKGT" else "UNKNOWN"),
        "mtime": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
    }
    for off, name in HEADER_FIELDS:
        row[name] = read_field(data, off)
    return row


def main() -> None:
    files = sorted(DEMO.glob("*.gim"))
    rows = [survey(f) for f in files]
    OUT.mkdir(parents=True, exist_ok=True)
    csv_path = OUT / "container-survey.csv"
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    print(f"{'file':<50} {'off':>4} {'software':<46} {'date':<17} type")
    for r in rows:
        print(f"{r['file']:<50} {r['payload_offset']:>4} {r['software'][:46]:<46} "
              f"{r['export_date'][:17]:<17} {r['type_guess']}")
        print(f"{'':2}proj: {r['proj_name']}")
        print(f"{'':2}designer: {r['designer']} | owner: {r['owner']}")
    print(f"\nCSV -> {csv_path}")


if __name__ == "__main__":
    main()
