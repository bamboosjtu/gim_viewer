#!/usr/bin/env python3
"""STL / MOD 设备类型六维度聚合（Round 8.5 + 8.6），10 样本全量。

CBM(entityName) -> DEV(SYMBOLNAME/TYPE/DEVICETYPE) -> PHM -> STL/MOD(.mod/.gl) 完整链反查。
聚合维度：entityName / symbolName / type(或 devicetype) / 几何格式 / 数量。

输出 docs/schema/_generated/device-type-survey-<sid>.json + stdout 汇总。
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEMO = ROOT / "demo"
OUT = ROOT / "docs" / "schema" / "_generated"

SAMPLE_IDS = [
    "demo-substation", "substation02", "substation03", "substation04",
    "demo-line1", "line02", "line03", "line04", "line05", "line06",
]


def classify_mod_quick(text: str) -> str:
    s = text.lstrip()
    if not s:
        return "EMPTY"
    if s.startswith("<"):
        return "XML_WITH_ENTITIES" if "<Entity" in s else "EMPTY_DEVICE_XML"
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if not lines:
        return "EMPTY"
    kv = lambda x: "=" in x
    up0 = lines[0].upper()
    if up0.startswith("HNUM,"):
        return "TEXT_HNUM"
    heads = {l.split("=")[0].strip().upper() for l in lines[:50] if "=" in l}
    if "CODE" in heads and "POINTNUM" in heads:
        return "TEXT_POINT_LINE"
    if not kv(lines[0]) and sum(kv(l) for l in lines[1:]) >= max(1, len(lines) // 2):
        return "TEXT_SECTION_KV"
    if sum(kv(l) for l in lines) >= len(lines) * 0.8:
        return "TEXT_KEY_VALUE"
    return "UNKNOWN"


def scan(sid: str) -> dict:
    root = DEMO / sid

    def base(p: Path) -> str:
        return p.name.lower()

    # PHM -> geometry
    phm2geom: dict[str, set] = defaultdict(set)
    for p in root.rglob("*.phm"):
        for line in p.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            k, _, v = line.partition("=")
            vl = v.strip().lower()
            if vl.endswith((".stl", ".mod", ".gl")):
                phm2geom[base(p)].add(vl.rsplit("/", 1)[-1])
    # geometry kind
    geom_kind: dict[str, str] = {}
    geom_size: dict[str, int] = {}
    for p in list(root.rglob("*.mod")) + list(root.rglob("*.gl")) + list(root.rglob("*.stl")):
        b = base(p)
        geom_size[b] = p.stat().st_size
        ext = p.suffix.lower()
        if ext == ".stl":
            kind = "STL"
        elif ext == ".gl":
            kind = "GL"
        else:
            try:
                kind = classify_mod_quick(p.read_text(encoding="utf-8-sig", errors="replace"))
                if kind.startswith(("XML", "EMPTY")):
                    kind = f"MOD-{kind}"
                else:
                    kind = f"MOD-{kind}"
            except OSError:
                kind = "MOD-?"
        geom_kind[b] = kind
    # DEV
    dev2: dict[str, set] = defaultdict(set)
    dev_field: dict[str, tuple] = {}
    for p in root.rglob("*.dev"):
        sym = typ = dvt = cls = ''
        for line in p.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            k, _, v = line.partition("=")
            ku = k.strip().upper(); v = v.strip()
            if ku == "SYMBOLNAME": sym = v
            elif ku == "TYPE": typ = v
            elif ku == "DEVICETYPE": dvt = v
            elif ku == "SYSCLASSIFYNAME": cls = v
            vl = v.lower()
            if vl.endswith((".phm", ".dev")):
                dev2[base(p)].add(vl.rsplit("/", 1)[-1])
        dev_field[base(p)] = (sym, typ or dvt or cls, typ, dvt)
    # 递归：DEV 是否触达某几何集合（带 memo 的 DFS）
    memo_stl: dict[str, bool] = {}
    memo_geom: dict[str, set] = {}

    def reach(name: str, seen: frozenset) -> set:
        """返回该 DEV 触达的几何 basename 集合"""
        if name in memo_geom:
            return memo_geom[name]
        if name in seen:
            return set()
        out: set = set()
        for t in dev2.get(name, ()):
            if t.endswith(".phm"):
                out |= phm2geom.get(t, set())
            elif t.endswith(".dev"):
                out |= reach(t, seen | {name})
        memo_geom[name] = out
        return out

    # CBM 扫描
    result_rows = []
    for p in root.rglob("*.cbm"):
        ent = omp = ""
        for line in p.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            k, _, v = line.partition("=")
            ku = k.strip().upper(); v = v.strip()
            if ku == "ENTITYNAME": ent = v
            elif ku == "OBJECTMODELPOINTER": omp = v.lower()
        if not omp.endswith(".dev"):
            continue
        geoms = reach(omp.rsplit("/", 1)[-1], frozenset())
        sym, typ, _, _ = dev_field.get(omp.rsplit("/", 1)[-1], ("", "", "", ""))
        for g in geoms:
            result_rows.append({
                "entity": ent.upper(), "symbol": sym, "type": typ,
                "kind": geom_kind.get(g, "?"), "geom": g, "size": geom_size.get(g, 0),
            })

    def top(counter: Counter, n=5):
        return [{"value": k, "count": c} for k, c in counter.most_common(n)]

    by_kind = Counter(r["kind"] for r in result_rows)
    stl_syms = Counter(r["symbol"] for r in result_rows if r["kind"] == "STL")
    stl_types = Counter(r["type"] for r in result_rows if r["kind"] == "STL")
    mod_kinds = Counter(r["kind"] for r in result_rows if r["kind"].startswith("MOD"))
    mod_syms = Counter(r["symbol"] for r in result_rows if r["kind"].startswith("MOD"))
    ent_kind = defaultdict(Counter)
    for r in result_rows:
        ent_kind[r["entity"]][r["kind"]] += 1
    size_by_kind = defaultdict(list)
    for r in result_rows:
        size_by_kind[r["kind"]].append(r["size"])

    summary = {
        "sampleId": sid,
        "totalGeomInstances": len(result_rows),
        "byKind": dict(by_kind.most_common()),
        "stlTopSymbols": top(stl_syms),
        "stlTopTypes": top(stl_types),
        "modTopSymbols": top(mod_syms),
        "entityKindMatrix": {e: dict(c.most_common(4)) for e, c in sorted(ent_kind.items())},
        "sizeByKind": {k: {"min": min(v), "max": max(v), "mean": round(sum(v)/len(v))}
                       for k, v in size_by_kind.items() if v},
    }
    with open(OUT / f"device-type-survey-{sid}.json", "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=1)

    print(f"\n=== {sid} ===")
    print(f"  几何实例总数={len(result_rows)}  byKind={dict(by_kind.most_common())}")
    print(f"  STL top symbols: {[x['value'] for x in summary['stlTopSymbols']]}")
    print(f"  STL top types:   {[x['value'] for x in summary['stlTopTypes']]}")
    print(f"  MOD top symbols: {[x['value'] for x in summary['modTopSymbols']]}")
    for e, c in sorted(ent_kind.items()):
        print(f"    {e}: {dict(c.most_common(3))}")
    return summary


if __name__ == "__main__":
    for sid in SAMPLE_IDS:
        scan(sid)
