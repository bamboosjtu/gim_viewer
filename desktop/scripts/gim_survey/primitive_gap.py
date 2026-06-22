#!/usr/bin/env python3
"""P0-3：变电 XML primitive 字段级分析 + 渲染缺件量化（4 变电样本）。

对每个样本的全部 XML 几何文件（.mod/.gl）逐 Entity 采集：
- primitive 类型 + 全部属性名/值
- 按 primitive 统计：字段覆盖率、数值字段 min/max、负值/零值
- 缺件量化：当前渲染器支持集合 = {Cylinder,Cuboid,Sphere,TruncatedCone,Ring,CircularGasket,StretchedBody}
  统计不支持 Entity 占比，并按上游设备 SYMBOLNAME 聚合受影响设备

输出 docs/schema/_generated/<sid>/primitive-fields.csv + stdout 汇总。
"""
from __future__ import annotations

import csv
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEMO = ROOT / "demo"
OUT = ROOT / "docs" / "schema" / "_generated"

SUBSTATION_IDS = ["demo-substation", "substation02", "substation03", "substation04"]

SUPPORTED = {"Cylinder", "Cuboid", "Sphere", "TruncatedCone", "Ring", "CircularGasket", "StretchedBody"}

ENT_RE = re.compile(r'<Entity\b[^>]*Visible="([^"]*)"[^>]*>(.*?)</Entity>', re.S)
TAG_RE = re.compile(r'<([A-Z][A-Za-z0-9]*)\b([^>]*?)(/?)>')
ATTR_RE = re.compile(r'(\w+)\s*=\s*"([^"]*)"')
SKIP_TAGS = {"TransformMatrix", "Color", "Entity", "Entities", "Device"}


def scan(sid: str) -> None:
    root = DEMO / sid
    fields: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))  # prim -> attr -> [float|str]
    prim_count: Counter = Counter()
    supported_n = unsupported_n = 0
    unsupported_by_sym: Counter = Counter()
    total_by_sym: Counter = Counter()

    # 简化上游映射：MOD 文件 -> 引用它的 DEV SYMBOLNAME（经 PHM）
    phm2geom_sym: dict[str, str] = {}
    dev_sym: dict[str, str] = {}
    for p in root.rglob("*.dev"):
        sym = ""
        targets = []
        for line in p.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            k, _, v = line.partition("=")
            ku = k.strip().upper(); v = v.strip()
            if ku == "SYMBOLNAME":
                sym = v
            vl = v.lower()
            if vl.endswith((".phm", ".dev")):
                targets.append(vl.rsplit("/", 1)[-1])
        dev_sym[p.name.lower()] = sym
        for t in targets:
            if t.endswith(".phm"):
                phm2geom_sym.setdefault(t, sym)

    # PHM 自身的 SYMBOLNAME 不存在；改用 PHM<-DEV 反查
    dev2phm: dict[str, str] = {}
    for p in root.rglob("*.dev"):
        for line in p.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            k, _, v = line.partition("=")
            vl = v.strip().lower()
            if vl.endswith(".phm"):
                dev2phm.setdefault(vl.rsplit("/", 1)[-1], dev_sym.get(p.name.lower(), ""))

    # PHM -> 引用的几何文件名（预建映射，避免 O(n²)）
    geom2sym: dict[str, str] = {}
    for p in root.rglob("*.phm"):
        owner = dev2phm.get(p.name.lower(), "")
        if not owner:
            continue
        for line in p.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            k, _, v = line.partition("=")
            vl = v.strip().lower()
            if vl.endswith((".mod", ".gl")):
                geom2sym.setdefault(vl.rsplit("/", 1)[-1], owner)

    for p in list(root.rglob("*.mod")) + list(root.rglob("*.gl")):
        try:
            text = p.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        if "<Entity" not in text:
            continue
        # 通过预建映射反查设备符号
        target_name = p.name.lower()
        sym = geom2sym.get(target_name, "")

        for m in ENT_RE.finditer(text):
            body = m.group(2)
            pm = None
            attrs: dict[str, str] | None = None
            for tm in TAG_RE.finditer(body):
                name = tm.group(1)
                if name in SKIP_TAGS:
                    continue
                pm = name
                attrs = dict(ATTR_RE.findall(tm.group(2)))
                break
            if not pm:
                continue
            prim_count[pm] += 1
            total_by_sym[sym or "(未知)"] += 1
            if pm not in SUPPORTED:
                unsupported_n += 1
                unsupported_by_sym[sym or "(未知)"] += 1
            else:
                supported_n += 1
            f = fields[pm]
            for k, v in (attrs or {}).items():
                try:
                    f[k].append(float(v))
                except ValueError:
                    f[k].append(v)

    print(f"\n=== {sid} ===")
    total = supported_n + unsupported_n
    print(f"  Entity 总数={total}  可渲染={supported_n} ({supported_n/max(1,total)*100:.1f}%)  "
          f"缺件={unsupported_n} ({unsupported_n/max(1,total)*100:.1f}%)")
    print("  缺件按类型:", {k: n for k, n in prim_count.most_common() if k not in SUPPORTED})
    print("  缺件 top 设备符号:", unsupported_by_sym.most_common(6))
    # 新类型字段范围
    with open(OUT / sid / "primitive-fields.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["primitive", "attr", "kind", "min", "max", "negatives", "zeros", "count"])
        for pm, attrs in sorted(fields.items()):
            for a, vals in sorted(attrs.items()):
                nums = [v for v in vals if isinstance(v, float)]
                if nums:
                    w.writerow([pm, a, "num",
                                round(min(nums), 4), round(max(nums), 4),
                                sum(1 for x in nums if x < 0), sum(1 for x in nums if x == 0),
                                len(nums)])
                else:
                    w.writerow([pm, a, "str", "", "", "", "", len(vals)])
    print(f"  CSV -> {OUT/sid/'primitive-fields.csv'}")


if __name__ == "__main__":
    for sid in SUBSTATION_IDS:
        scan(sid)
