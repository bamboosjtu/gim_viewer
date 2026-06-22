#!/usr/bin/env python3
"""GIM 几何层批量分析：MOD 静态分型 + CBM 可达性（Round 3 + Round 4）。

对每个解压样本：
1. MOD 分型（EMPTY / EMPTY_DEVICE_XML / XML_WITH_ENTITIES / TEXT_POINT_LINE /
   TEXT_SECTION_KV_RECORD / TEXT_KEY_VALUE / TEXT_HNUM_COMMA_RECORD / UNKNOWN_TEXT）
   —— .gl 文件单独按 glKind 统计，同时纳入可达性。
2. 变电 XML primitive 类型分布 + Visible 大小写形态。
3. 从全部 CBM 的 OBJECTMODELPOINTER 出发遍历 DEV(SOLIDMODELn/SUBDEVICEn) ->
   PHM(SOLIDMODELn，递归防环) -> MOD/STL/GL，统计几何资源可达率与孤儿。
4. entityName -> 几何 kind 上游映射。

输出：docs/schema/_generated/<sid>/mod-kind.csv、primitive-survey.csv、
      reachability.csv、entityname-geometry.csv 与汇总 mod-survey-summary.csv
"""
from __future__ import annotations

import csv
import re
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

GEOM_EXTS = {"mod", "stl", "gl"}


def classify_mod(path: Path) -> tuple[str, Counter]:
    """返回 (kind, primitive计数)。"""
    data = path.read_bytes()
    if not data:
        return "EMPTY", Counter()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return "UNKNOWN_TEXT", Counter()
    stripped = text.lstrip()
    if stripped.startswith("<"):
        prims: Counter = Counter()
        vis: Counter = Counter()
        for m in re.finditer(r'<Entity\b[^>]*Visible="([^"]*)"', text):
            vis[m.group(1)] += 1
            seg = text[m.end(): text.find("</Entity>", m.end())]
            for t in re.finditer(r"<([A-Za-z][A-Za-z0-9]*)\b", seg):
                name = t.group(1)
                if name in ("TransformMatrix", "Color", "Entity", "Entities", "Device"):
                    continue
                prims[name] += 1
                break  # 每个 Entity 只取第一个非矩阵/颜色子元素作为 primitive
        kind = "XML_WITH_ENTITIES" if sum(prims.values()) else "EMPTY_DEVICE_XML"
        # Visible 形态统计并入 primitive counter 的特殊键
        for v, n in vis.items():
            prims[f"#visible={v}"] += n
        return kind, prims
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return "EMPTY", Counter()
    kv = lambda s: "=" in s
    if re.match(r"(?i)^hnum\s*,", lines[0]):
        return "TEXT_HNUM_COMMA_RECORD", Counter()
    has_code = any(l.upper().startswith("CODE=") for l in lines[:50])
    if has_code and any(l.upper().startswith("POINTNUM=") for l in lines[:50]):
        return "TEXT_POINT_LINE", Counter()
    if not kv(lines[0]) and sum(kv(l) for l in lines[1:]) >= max(1, len(lines) // 2):
        return "TEXT_SECTION_KV_RECORD", Counter()
    if sum(kv(l) for l in lines) >= len(lines) * 0.8:
        return "TEXT_KEY_VALUE", Counter()
    return "UNKNOWN_TEXT", Counter()


def scan_sample(sid: str) -> None:
    root = DEMO / sid
    out_dir = OUT / sid
    out_dir.mkdir(parents=True, exist_ok=True)

    def norm(p: Path) -> str:
        return p.relative_to(root).as_posix().lower()

    # ---- 文件索引与解析缓存 ----
    geom_kind: dict[str, str] = {}          # rel(lower) -> kind
    primitives: Counter = Counter()         # 全样本 primitive 聚合
    for p in root.rglob("*"):
        if p.is_file() and p.suffix.lower().lstrip(".") in GEOM_EXTS:
            ext = p.suffix.lower().lstrip(".")
            if ext == "stl":
                kind = "STL_BINARY" if b"\x00" in p.read_bytes()[:4096] else "STL_ASCII"
            else:
                kind, prims = classify_mod(p)
                primitives.update(prims)
            geom_kind[norm(p)] = f"{kind}" if ext == "mod" else f"{ext.upper()}:{kind}"

    dev_refs: dict[str, list[str]] = defaultdict(list)     # dev basename -> targets(basename)
    phm_refs: dict[str, list[tuple[str, str]]] = defaultdict(list)  # phm basename -> [(target,type)]
    cbm_entries: dict[str, str] = {}                        # cbm rel -> OBJECTMODELPOINTER target(basename)
    cbm_entity_geom: dict[str, set] = defaultdict(set)      # entityName -> geometry kind 集合
    entity_of_cbm: dict[str, str] = {}
    base2dev: dict[str, str] = {}
    base2phm: dict[str, str] = {}

    for p in root.rglob("*.dev"):
        rel = norm(p)
        base2dev[p.name.lower()] = rel
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            k, _, v = line.partition("=")
            v = v.strip()
            vl = v.lower()
            if vl.endswith(".phm") or vl.endswith(".dev"):
                dev_refs[rel].append(vl.rsplit("/", 1)[-1])
    for p in root.rglob("*.phm"):
        rel = norm(p)
        base2phm[p.name.lower()] = rel
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            k, _, v = line.partition("=")
            v = v.strip()
            vl = v.lower()
            ext = vl.rsplit(".", 1)[-1]
            if ext in GEOM_EXTS:
                phm_refs[rel].append((vl.rsplit("/", 1)[-1], ext))
            elif vl.endswith(".phm"):
                phm_refs[rel].append((vl.rsplit("/", 1)[-1], "phm"))
    for p in root.rglob("*.cbm"):
        rel = norm(p)
        ent = ""
        omp = ""
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            k, _, v = line.partition("=")
            ku = k.strip().upper()
            if ku == "ENTITYNAME":
                ent = v.strip()
            elif ku == "OBJECTMODELPOINTER":
                omp = v.strip().lower()
        entity_of_cbm[rel] = ent
        if omp.endswith(".dev"):
            cbm_entries[rel] = omp

    # ---- 可达性遍历 ----
    geom_total = Counter(ext for rel, ext_k in ((r, k.split(":")[0]) for r, k in geom_kind.items())
                         for ext in [ext_k])
    # 更直接：按扩展名统计
    geom_total = Counter(rel.rsplit(".", 1)[-1] for rel in geom_kind)

    visited_dev: set[str] = set()
    reached_phm: set[str] = set()
    reached_geom: dict[str, str] = {}
    geom_by_base = {rel.rsplit("/", 1)[-1]: rel for rel in geom_kind}
    phm_depth_max = 0
    cycles = 0

    def walk_dev(dev_base: str, seen: frozenset) -> None:
        nonlocal cycles
        dev_rel = base2dev.get(dev_base)
        if dev_rel is None or dev_rel in seen:
            if dev_rel is None:
                reach_counter[("dev-missing", "x")] if False else None
            return
        if dev_rel in seen:
            cycles += 1
            return
        if dev_rel in visited_dev:
            return
        visited_dev.add(dev_rel)
        for tgt in dev_refs.get(dev_rel, []):
            if tgt.endswith(".phm"):
                walk_phm(tgt, seen | {dev_rel}, 0)
            elif tgt.endswith(".dev"):
                walk_dev(tgt, seen | {dev_rel})

    def walk_phm(phm_base: str, seen: frozenset, depth: int) -> None:
        nonlocal phm_depth_max
        phm_rel = base2phm.get(phm_base)
        if phm_rel is None:
            return
        if phm_rel in seen:
            cycles += 1
            return
        phm_depth_max = max(phm_depth_max, depth)
        if phm_rel in reached_phm:
            return
        reached_phm.add(phm_rel)
        for tgt, typ in phm_refs.get(phm_rel, []):
            if typ == "phm":
                walk_phm(tgt, seen | {phm_rel}, depth + 1)
            else:
                full = geom_by_base.get(tgt, tgt)
                reached_geom.setdefault(full, geom_kind.get(full, "MISSING"))

    for omp in cbm_entries.values():
        walk_dev(omp, frozenset())

    reach_counter: Counter = Counter()
    for ext, n in geom_total.items():
        reach_counter[(ext, "total")] += n
    reached_by_ext = Counter(k.rsplit(".", 1)[-1] for k in reached_geom)
    for ext, n in reached_by_ext.items():
        reach_counter[(ext, "reached")] += n

    # entityName -> geometry kind 映射：重新走一遍但记录 entityName
    # （简化实现：对每个 cbm 单独走，代价可接受）
    ent_geom: dict[str, Counter] = defaultdict(Counter)

    def walk_dev2(dev_base: str, ent: str, seen: frozenset) -> None:
        dev_rel = base2dev.get(dev_base)
        if dev_rel is None or dev_rel in seen:
            return
        for tgt in dev_refs.get(dev_rel, []):
            if tgt.endswith(".phm"):
                walk_phm2(tgt, ent, seen | {dev_rel}, 0)
            elif tgt.endswith(".dev"):
                walk_dev2(tgt, ent, seen | {dev_rel})

    def walk_phm2(phm_base: str, ent: str, seen: frozenset, depth: int) -> None:
        phm_rel = base2phm.get(phm_base)
        if phm_rel is None or phm_rel in seen:
            return
        for tgt, typ in phm_refs.get(phm_rel, []):
            if typ == "phm":
                walk_phm2(tgt, ent, seen | {phm_rel}, depth + 1)
            else:
                full = geom_by_base.get(tgt, tgt)
                gk = geom_kind.get(full, "MISSING")
                ent_geom[ent][gk] += 1

    for rel, omp in cbm_entries.items():
        ent = entity_of_cbm.get(rel, "")
        walk_dev2(omp, ent, frozenset())

    # ---- 输出 ----
    with open(out_dir / "mod-kind.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["extOrKind", "count"])
        for k, n in sorted(geom_total.items()):
            w.writerow([k, n])
        kinds = Counter(geom_kind.values())
        for k, n in sorted(kinds.items()):
            w.writerow([f"KIND:{k}", n])

    with open(out_dir / "reachability.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["ext", "status", "count"])
        for (ext, st), n in sorted(reach_counter.items()):
            w.writerow([ext, st, n])
        w.writerow(["PHM", "reached", len(reached_phm)])
        w.writerow(["PHM", "total", sum(1 for _ in root.rglob("*.phm"))])
        w.writerow(["DEV", "visited", len(visited_dev)])
        w.writerow(["CYCLE", "detected", cycles])
        w.writerow(["PHM_DEPTH", "max", phm_depth_max])

    with open(out_dir / "entityname-geometry.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["entityName(normalized)", "geometryKind", "reachCount"])
        agg: dict[str, Counter] = defaultdict(Counter)
        for ent, cnt in ent_geom.items():
            for k, n in cnt.items():
                agg[ent.upper()][k] += n
        for ent, cnt in sorted(agg.items()):
            for k, n in sorted(cnt.items()):
                w.writerow([ent, k, n])

    prim_rows = Counter({k: n for k, n in primitives.items() if not k.startswith("#")})
    with open(out_dir / "primitive-survey.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["item", "count"])
        for k, n in prim_rows.most_common():
            w.writerow([f"PRIMITIVE:{k}", n])
        for k, n in sorted(primitives.items()):
            if k.startswith("#"):
                w.writerow([k, n])

    print(f"\n=== {sid} ===")
    print("  geom totals:", dict(sorted(geom_total.items())))
    print("  kinds:", dict(Counter(geom_kind.values()).most_common()))
    print("  reach:", {f'{e}/{s}': n for (e, s), n in sorted(reach_counter.items())})
    print(f"  phmDepth={phm_depth_max} cycles={cycles} devs={len(visited_dev)}")
    if prim_rows:
        print("  primitives:", dict(prim_rows.most_common(20)))
        print("  visible:", {k: n for k, n in primitives.items() if k.startswith("#")})


def main() -> None:
    for sid in SAMPLE_IDS:
        scan_sample(sid)


if __name__ == "__main__":
    main()
