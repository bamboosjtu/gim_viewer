#!/usr/bin/env python3
"""CBM / DEV 层变换矩阵覆盖率批量复核（Round 5 扩展）。

对每个解压样本统计：
- CBM：TRANSFORMMATRIX 字段覆盖率（非空值占比）、IDENTITY / 非单位分布、平移分量量级
- DEV：SUBDEVICE 矩阵非单位占比、SOLIDMODEL 矩阵分类

对照旧基线（demo-substation 单样本）：CBM 矩阵覆盖率 53.4%、SUBDEVICES 非单位占比 87.8%。
输出 docs/schema/_generated/cbm-dev-matrix-summary.csv
"""
from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEMO = ROOT / "demo"
OUT = ROOT / "docs" / "schema" / "_generated"

SAMPLE_IDS = [
    "demo-substation", "substation02", "substation03", "substation04",
    "demo-line1", "line02", "line03",
    "line04", "line05", "line06",
]

EPS = 1e-9


def classify(vals: list[float]) -> str:
    is_id = all(abs(vals[i] - (1.0 if i in (0, 5, 10, 15) else 0.0)) < EPS for i in range(16))
    if is_id:
        return "IDENTITY"
    rot = any(abs(vals[i]) > EPS for i in (0, 1, 2, 4, 5, 6, 8, 9, 10))
    trans = any(abs(vals[i]) > EPS for i in (12, 13, 14))
    if rot and trans:
        return "TRANS+ROT"
    return "TRANS_ONLY" if trans else ("ROT_ONLY" if rot else "OTHER")


def parse16(raw: str) -> list[float] | None:
    parts = [p for p in raw.split(",") if p.strip()]
    if len(parts) != 16:
        return None
    vals = [float(p) for p in parts]
    return None if any(v != v for v in vals) else vals


def scan(sid: str) -> dict:
    root = DEMO / sid
    cbm_total = cbm_with_tm = 0
    cbm_kind: Counter = Counter()
    cbm_trans_mag: list[float] = []
    dev_sub_kind: Counter = Counter()
    dev_solid_kind: Counter = Counter()
    dev_sub_total = dev_solid_total = 0

    for p in root.rglob("*.cbm"):
        cbm_total += 1
        tm_raw = ""
        for line in p.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            k, _, v = line.partition("=")
            if k.strip().upper() == "TRANSFORMMATRIX":
                tm_raw = v.strip()
                break
        if tm_raw:
            cbm_with_tm += 1
            vals = parse16(tm_raw)
            if vals:
                cbm_kind[classify(vals)] += 1
                mag = (vals[12] ** 2 + vals[13] ** 2 + vals[14] ** 2) ** 0.5
                if mag > EPS:
                    cbm_trans_mag.append(mag)

    for p in root.rglob("*.dev"):
        text = p.read_text(encoding="utf-8-sig", errors="replace")
        block = None
        for line in text.splitlines():
            k, _, v = line.partition("=")
            k = k.strip().upper()
            if k == "SOLIDMODELS.NUM":
                block = "solid"
                continue
            if k == "SUBDEVICES.NUM":
                block = "sub"
                continue
            if k.startswith("TRANSFORMMATRIX"):
                vals = parse16(v.strip())
                if not vals:
                    continue
                kind = classify(vals)
                if block == "sub":
                    dev_sub_total += 1
                    dev_sub_kind[kind] += 1
                elif block == "solid":
                    dev_solid_total += 1
                    dev_solid_kind[kind] += 1

    cov = cbm_with_tm / cbm_total * 100 if cbm_total else 0
    sub_nonid = sum(n for k, n in dev_sub_kind.items() if k != "IDENTITY")
    sub_pct = sub_nonid / dev_sub_total * 100 if dev_sub_total else 0
    print(f"\n=== {sid} ===")
    print(f"  CBM 矩阵覆盖: {cbm_with_tm}/{cbm_total} = {cov:.1f}%  分类: {dict(cbm_kind.most_common())}")
    if cbm_trans_mag:
        cbm_trans_mag.sort()
        n = len(cbm_trans_mag)
        print(f"  CBM 平移模长 min/med/max: {cbm_trans_mag[0]:.2f}/{cbm_trans_mag[n//2]:.2f}/{cbm_trans_mag[-1]:.2f}")
    print(f"  DEV SUBDEVICE 矩阵: {dict(dev_sub_kind.most_common())} 非单位 {sub_pct:.1f}%")
    print(f"  DEV SOLIDMODEL 矩阵: {dict(dev_solid_kind.most_common())}")
    return {
        "sid": sid, "cbmTotal": cbm_total, "cbmWithTm": cbm_with_tm,
        "coverage": round(cov, 1),
        "cbmKinds": dict(cbm_kind),
        "subNonIdentityPct": round(sub_pct, 1), "subKinds": dict(dev_sub_kind),
        "solidKinds": dict(dev_solid_kind),
    }


def main() -> None:
    rows = []
    for sid in SAMPLE_IDS:
        rows.append(scan(sid))
    with open(OUT / "cbm-dev-matrix-summary.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["sampleId", "metric", "value"])
        for r in rows:
            w.writerow([r["sid"], "cbmCoveragePct", r["coverage"]])
            for k, n in r["cbmKinds"].items():
                w.writerow([r["sid"], f"cbmKind:{k}", n])
            w.writerow([r["sid"], "devSubNonIdentityPct", r["subNonIdentityPct"]])
            for k, n in r["subKinds"].items():
                w.writerow([r["sid"], f"devSubKind:{k}", n])
            for k, n in r["solidKinds"].items():
                w.writerow([r["sid"], f"devSolidKind:{k}", n])
    print("\nCSV -> cbm-dev-matrix-summary.csv")


if __name__ == "__main__":
    main()
