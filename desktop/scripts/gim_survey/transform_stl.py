#!/usr/bin/env python3
"""PHM/MOD 变换链 + STL 批量验证（skill Round 5 + Round 8.1/8.2）。

对每个解压样本：
- PHM：SOLIDMODELn 与 TRANSFORMMATRIXn 一一对应率；矩阵分类（IDENTITY / TRANSLATION_ONLY /
  ROTSCALE_ONLY / TRANSLATION+ROTSCALE / OTHER / INVALID）
- 变电 XML MOD：Entity.TransformMatrix 分类分布
- 线路 MOD：TransformMatrix 字段依赖检测
- STL：binary/ascii 检测、三角面数统计、PHM 引用覆盖率与复用分布

输出 docs/schema/_generated/<sid>/transform-stl.csv + stdout 汇总。
"""
from __future__ import annotations

import csv
import re
import struct
from collections import Counter, defaultdict
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


def classify_matrix(vals: list[float]) -> str:
    if len(vals) != 16:
        return "INVALID"
    is_id = all(abs(vals[i] - (1.0 if i in (0, 5, 10, 15) else 0.0)) < EPS for i in range(16))
    if is_id:
        return "IDENTITY"
    rot_scale = any(abs(vals[i]) > EPS for i in (0, 1, 2, 4, 5, 6, 8, 9, 10))
    trans = any(abs(vals[i]) > EPS for i in (12, 13, 14))
    if rot_scale and trans:
        return "TRANSLATION+ROTSCALE"
    if trans:
        return "TRANSLATION_ONLY"
    if rot_scale:
        return "ROTSCALE_ONLY"
    return "OTHER"


def parse_floats(s: str) -> list[float]:
    try:
        return [float(x) for x in s.split(",") if x.strip()]
    except ValueError:
        return []


def scan_sample(sid: str) -> dict:
    root = DEMO / sid
    out_rows: list[tuple] = []
    phm_matrix_kind: Counter = Counter()
    phm_pair_ok = Counter()
    mod_entity_matrix: Counter = Counter()
    line_mod_matrix_field = 0
    stl_format: Counter = Counter()
    stl_tri = []
    stl_refs: Counter = Counter()   # stl basename -> 引用次数

    # --- PHM ---
    phm_files = list(root.rglob("*.phm"))
    for p in phm_files:
        pairs = {}
        for line in p.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            k, _, v = line.partition("=")
            k = k.strip().upper()
            if k.startswith("SOLIDMODEL") and k != "SOLIDMODELS.NUM":
                idx = k[len("SOLIDMODEL"):]
                pairs.setdefault(idx, {})["target"] = v.strip().lower()
            elif k.startswith("TRANSFORMMATRIX"):
                idx = k[len("TRANSFORMMATRIX"):]
                pairs.setdefault(idx, {})["mat"] = v.strip()
        n_target = sum(1 for v in pairs.values() if "target" in v)
        n_mat = sum(1 for v in pairs.values() if "mat" in v)
        phm_pair_ok["match" if n_target == n_mat else "diff"] += 1
        for v in pairs.values():
            if "mat" in v:
                phm_matrix_kind[classify_matrix(parse_floats(v["mat"]))] += 1

    # --- STL ---
    stl_bases = set()
    for p in root.rglob("*.stl"):
        data = p.read_bytes()
        base = p.name.lower()
        stl_bases.add(base)
        if len(data) >= 84 and struct.unpack("<i", data[80:84])[0] * 50 + 84 == len(data):
            fmt = "binary"
            stl_tri.append(struct.unpack("<i", data[80:84])[0])
        else:
            fmt = "ascii" if data[:5].lower() == b"solid" else "unknown"
        stl_format[fmt] += 1
    for p in root.rglob("*.phm"):
        for m in re.finditer(r"(?im)^[^=]*\.stl\s*$", ""):
            pass
        for line in p.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            k, _, v = line.partition("=")
            vl = v.strip().lower()
            if vl.endswith(".stl"):
                stl_refs[vl.rsplit("/", 1)[-1]] += 1
    covered = sum(1 for b in stl_bases if b in stl_refs)
    reuse = Counter(stl_refs.values())

    # --- MOD ---
    xml_like = sid.startswith(("demo-substation", "sub-"))
    for p in root.rglob("*.mod"):
        text = p.read_text(encoding="utf-8-sig", errors="replace")
        if re.search(r"(?i)transformmatrix", text):
            line_mod_matrix_field += 1
        if xml_like and "<Entity" in text:
            for m in re.finditer(r'<TransformMatrix\s+Value="([^"]*)"', text):
                mod_entity_matrix[classify_matrix(parse_floats(m.group(1)))] += 1

    with open(OUT / sid / "transform-stl.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["item", "value", "count"])
        for k, n in phm_matrix_kind.most_common():
            w.writerow(["phmMatrixKind", k, n])
        for k, n in phm_pair_ok.items():
            w.writerow(["phmPairTargetVsMatrix", k, n])
        for k, n in mod_entity_matrix.most_common():
            w.writerow(["modEntityMatrixKind", k, n])
        w.writerow(["lineModWithMatrixField", "files", line_mod_matrix_field])
        for k, n in stl_format.items():
            w.writerow(["stlFormat", k, n])
        if stl_tri:
            w.writerow(["stlTriangles", "min", min(stl_tri)])
            w.writerow(["stlTriangles", "max", max(stl_tri)])
            w.writerow(["stlTriangles", "mean", round(sum(stl_tri) / len(stl_tri), 1)])
            w.writerow(["stlTriangles", "total", sum(stl_tri)])
        w.writerow(["stlCoverage", "coveredByPhm", covered])
        w.writerow(["stlCoverage", "total", len(stl_bases)])
        for reuse_n, files in sorted(reuse.items()):
            w.writerow(["stlReuseRefs", f"refs={reuse_n}", files])

    print(f"\n=== {sid} ===")
    print("  PHM 矩阵:", dict(phm_matrix_kind.most_common()),
          f"| 对应一致 {phm_pair_ok['match']}/{sum(phm_pair_ok.values())}")
    if mod_entity_matrix:
        print("  Entity 矩阵:", dict(mod_entity_matrix.most_common()))
    print(f"  线路MOD含矩阵字段文件: {line_mod_matrix_field}")
    print(f"  STL: {dict(stl_format)} 覆盖 {covered}/{len(stl_bases)} 复用{dict(sorted(reuse.items()))}")
    if stl_tri:
        print(f"  三角面 min/max/mean/total: {min(stl_tri)}/{max(stl_tri)}/"
              f"{round(sum(stl_tri)/len(stl_tri))}/{sum(stl_tri)}")
    return {}


if __name__ == "__main__":
    for sid in SAMPLE_IDS:
        scan_sample(sid)
