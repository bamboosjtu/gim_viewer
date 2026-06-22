#!/usr/bin/env python3
"""线路悬链线候选字段证据复现（对照 15-wire-catenary-evidence.md），6 个在册线路样本。

对每个线路样本统计：
- CBM 层：WIRE 节点数、KVALUE 覆盖率/零值占比/非零值范围、ISJUMPER 分布
- WIRE 的 MATRIX0（挂点偏移）字段：覆盖率、x/y/z 分量分布
- TOWER/塔位节点 BLHA 覆盖率与分量量级（纬度,经度,高程,方位角）
- interPoint 拓扑分类字段存在性

输出 docs/schema/_generated/catenary-evidence-summary.csv + stdout。
"""
from __future__ import annotations

import csv
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEMO = ROOT / "demo"
OUT = ROOT / "docs" / "schema" / "_generated"

LINE_IDS = ["demo-line1", "line02", "line03", "line04", "line05", "line06"]

NUM = re.compile(r"^-?\d+(\.\d+)?([eE][-+]?\d+)?$")


def scan(sid: str) -> dict:
    root = DEMO / sid
    wire_n = jumper_n = 0
    kvalue_vals: list[float] = []
    kvalue_zero = 0
    m0_cover = 0
    m0_x: list[float] = []
    m0_y: list[float] = []
    m0_z: list[float] = []
    tower_blha = 0
    tower_n = 0
    blha_lat: list[float] = []
    blha_alt: list[float] = []

    for p in root.rglob("*.cbm"):
        text = p.read_text(encoding="utf-8-sig", errors="replace")
        kv: dict[str, str] = {}
        for line in text.splitlines():
            k, _, v = line.partition("=")
            kv[k.strip().upper()] = v.strip()
        ent = kv.get("ENTITYNAME", "").upper()
        # POINTn.MATRIX0 / POINTn.BLHA 复合键（WIRE 挂点字段）
        point_matrices = [v for k, v in kv.items()
                          if re.match(r"^POINT\d+\.MATRIX0$", k)]
        if ent == "WIRE":
            wire_n += 1
            if kv.get("ISJUMPER"):
                jumper_n += 1
            kvv = kv.get("KVALUE", "")
            if kvv:
                try:
                    f = float(kvv)
                    kvalue_vals.append(f)
                    if abs(f) < 1e-12:
                        kvalue_zero += 1
                except ValueError:
                    pass
            for m0 in point_matrices:
                parts = [x for x in m0.split(",") if x.strip()]
                if len(parts) >= 15 and all(NUM.match(x) for x in parts[:14]):
                    m0_cover += 1
                    try:
                        x, y, z = (float(parts[12]), float(parts[13]), float(parts[14]))
                        m0_x.append(x); m0_y.append(y); m0_z.append(z)
                    except ValueError:
                        pass
        elif ent in ("TOWER_DEVICE", "F4SYSTEM") and kv.get("BLHA"):
            # 塔位级 BLHA：只统计含 4 分量且非全零的
            parts = [x for x in kv["BLHA"].split(",") if x.strip()]
            if len(parts) == 4 and all(NUM.match(x) for x in parts):
                lat, lon, alt, az = (float(x) for x in parts)
                tower_n += 1
                if lat > 0 and lon > 0:
                    tower_blha += 1
                    blha_lat.append(lat)
                    blha_alt.append(alt)

    def rng(v: list[float]):
        if not v:
            return "n/a"
        return f"{min(v):.4g}~{max(v):.4g}"

    print(f"\n=== {sid} ===")
    print(f"  WIRE 节点={wire_n}  ISJUMPER 非空={jumper_n}")
    if wire_n:
        cov = len(kvalue_vals) / wire_n * 100
        zero = kvalue_zero / len(kvalue_vals) * 100 if kvalue_vals else 0
        nz = [v for v in kvalue_vals if abs(v) > 1e-12]
        print(f"  KVALUE 覆盖={cov:.1f}% 零值占 {zero:.1f}% 非零范围 {rng(nz)}")
        print(f"  MATRIX0 覆盖={m0_cover/wire_n*100:.1f}%"
              + (f"  x:{rng(m0_x)} y:{rng(m0_y)} z:{rng(m0_z)}" if m0_x else ""))
    print(f"  塔位 BLHA(经纬度>0): {tower_blha}/{tower_n}"
          + (f"  纬度 {rng(blha_lat)} 高程 {rng(blha_alt)}" if blha_lat else ""))

    return {"sid": sid, "wires": wire_n, "kvalueCov": round(len(kvalue_vals)/max(1,wire_n)*100,1),
            "kvalueZeroPct": round(kvalue_zero/max(1,len(kvalue_vals))*100,1),
            "kvalueRange": rng([v for v in kvalue_vals if abs(v)>1e-12]),
            "matrix0Cov": round(m0_cover/max(1,wire_n)*100,1),
            "m0x": rng(m0_x), "m0y": rng(m0_y), "m0z": rng(m0_z),
            "towerBlha": f"{tower_blha}/{tower_n}"}


if __name__ == "__main__":
    rows = [scan(s) for s in LINE_IDS]
    with open(OUT / "catenary-evidence-summary.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    print("\nCSV -> catenary-evidence-summary.csv")
