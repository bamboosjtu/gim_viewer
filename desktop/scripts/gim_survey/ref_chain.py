#!/usr/bin/env python3
"""GIM 引用链与完整性批量分析（skill: gim-sample-verification / Round 2）。

对每个解压样本：
- 扫描全部 .cbm：ENTITYNAME 分布 + 按 VALUE 扩展名的全量引用采集（不做字段白名单过滤）
- 扫描全部 .dev / .phm：同类引用采集
- 完整性校验：目标文件是否存在（大小写不敏感 basename 匹配），分 hard-missing / soft-missing / hit
- project.cbm 顶层字段采集

输出：docs/schema/_generated/<sid>/refs-*.csv 与 docs/schema/_generated/ref-chain-summary.csv
"""
from __future__ import annotations

import csv
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

KNOWN_EXTS = {".cbm", ".dev", ".phm", ".fam", ".ifc", ".mod", ".stl", ".gl",
              ".sch", ".std", ".sld"}


def kv_lines(text: str):
    for line in text.splitlines():
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        yield k.strip(), v.strip()


class Index:
    """大小写不敏感的 basename 索引：lower(basename) -> set(实际路径)"""

    def __init__(self, root: Path):
        self.by_base: dict[str, set[str]] = defaultdict(set)
        for p in root.rglob("*"):
            if p.is_file():
                self.by_base[p.name.lower()].add(p.relative_to(root).as_posix())

    def lookup(self, value: str) -> str:
        """返回 hit / soft / missing（soft = 同名文件存在于其他目录）"""
        base = value.replace("\\", "/").rsplit("/", 1)[-1].lower()
        hits = self.by_base.get(base)
        if not hits:
            return "missing"
        for h in hits:
            if h.lower().endswith("/" + base) or h.lower() == base:
                pass
        # soft：basename 命中但目录路径与引用值路径不一致
        ref_dir = value.replace("\\", "/").rsplit("/", 1)[0].lower() if "/" in value else ""
        for h in hits:
            hd = h.rsplit("/", 1)[0].lower() if "/" in h else ""
            if not ref_dir or hd == ref_dir or hd.endswith("/" + ref_dir) or ref_dir.endswith("/" + hd):
                return "hit"
        return "soft"


def scan_sample(sid: str) -> dict:
    root = DEMO / sid
    idx = Index(root)
    out_dir = OUT / sid
    out_dir.mkdir(parents=True, exist_ok=True)

    entity_counter: Counter[str] = Counter()
    cbm_refs: list[tuple[str, str, str]] = []   # src, key, value
    dev_refs: list[tuple[str, str, str]] = []
    phm_refs: list[tuple[str, str, str]] = []
    project_fields: dict[str, str] = {}

    for sub in root.iterdir():
        if not sub.is_dir():
            continue
        kind = {"cbm": "cbm", "dev": "dev", "phm": "phm"}.get(sub.name.lower())
        if not kind:
            continue
        for p in sub.rglob(f"*.{kind}"):
            try:
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            rel = p.relative_to(root).as_posix()
            first_pass = {}
            for k, v in kv_lines(text):
                first_pass.setdefault(k.upper(), v)
                if v and v.rsplit(".", 1)[-1].lower() in {e[1:] for e in KNOWN_EXTS} \
                        and ("." in v) and v.lower().endswith(tuple(KNOWN_EXTS)):
                    if kind == "cbm":
                        cbm_refs.append((rel, k, v))
                    elif kind == "dev":
                        dev_refs.append((rel, k, v))
                    else:
                        phm_refs.append((rel, k, v))
            ent = first_pass.get("ENTITYNAME", "")
            if ent:
                entity_counter[ent] += 1
            if p.name.lower() == "project.cbm":
                project_fields = {k.upper(): v for k, v in first_pass.items()
                                  if k.upper() in {"BLHA", "TYPE", "SUBSYSTEM", "SCH"}}

    # 完整性
    integ: Counter[tuple[str, str, str]] = Counter()
    missing_rows = []
    for kind, refs in (("cbm", cbm_refs), ("dev", dev_refs), ("phm", phm_refs)):
        for src, key, val in refs:
            ext = "." + val.rsplit(".", 1)[-1].lower()
            st = idx.lookup(val)
            integ[(kind, ext, st)] += 1
            if st != "hit":
                missing_rows.append((kind, src, key, val, st))

    with open(out_dir / "refs-integrity.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["srcKind", "targetExt", "status", "count"])
        for (k, e, s), n in sorted(integ.items()):
            w.writerow([k, e, s, n])
    if missing_rows:
        with open(out_dir / "refs-missing.csv", "w", newline="", encoding="utf-8-sig") as fh:
            w = csv.writer(fh)
            w.writerow(["srcKind", "srcFile", "key", "value", "status"])
            w.writerows(missing_rows)

    with open(out_dir / "entityname-distribution.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["entityName", "count"])
        for e, n in entity_counter.most_common():
            w.writerow([e, n])

    print(f"\n=== {sid} ===")
    print("  ENTITYNAME:", dict(entity_counter.most_common(12)))
    print("  project.cbm:", project_fields)
    miss = sum(n for (_, _, s), n in integ.items() if s != "hit")
    total = sum(integ.values())
    print(f"  refs={total} missing={miss}")
    for (k, e, s), n in sorted(integ.items()):
        if s != "hit":
            print(f"    {k}->{e} {s}: {n}")
    return {"sid": sid, "integ": integ, "entities": entity_counter,
            "project": project_fields, "total": total, "missing": miss}


def main() -> None:
    results = []
    for sid in SAMPLE_IDS:
        results.append(scan_sample(sid))
    with open(OUT / "ref-chain-summary.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["sampleId", "srcKind", "targetExt", "status", "count"])
        for r in results:
            for (k, e, s), n in sorted(r["integ"].items()):
                w.writerow([r["sid"], k, e, s, n])
    print("\nCSV -> ref-chain-summary.csv + <sid>/refs-integrity.csv")


if __name__ == "__main__":
    main()
