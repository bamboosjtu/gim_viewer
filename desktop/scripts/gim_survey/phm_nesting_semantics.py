#!/usr/bin/env python3
"""P0-1：PHM→PHM 嵌套的矩阵组合语义分析（变电站03 / BIMBase）。

方法：
1. 构建 PHM 引用图，找出最深的完整链（DEV → PHM_1 → PHM_2 → ... → MOD）
2. 沿链提取每级 SOLIDMODELn 的 TRANSFORMMATRIXn 与 COLORn，验证一一对应
3. 矩阵性质检验：正交性（旋转部分 R·Rᵀ≈I）、行列式（det≈±1）、平移量级逐层分布
4. 组合假设数值验证：
   - H1（层级组合）：世界变换 = 根级矩阵 × 中间级矩阵 × 叶级矩阵
     检验手段：同一叶 PHM 被多个不同父 PHM 引用时，其各实例的世界平移应显著不同；
     而叶级自身矩阵的平移应为局部小量级。对比"逐层平移模长分布"判断哪一层携带世界坐标。
5. 统计嵌套 PHM 引用上 COLORn 的出现率

输出 stdout 分析报告。
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
SID = "substation03"
root = ROOT / "demo" / SID


def parse_phm(p: Path):
    kv: dict[str, str] = {}
    for line in p.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        k, _, v = line.partition("=")
        kv[k.strip().upper()] = v.strip()
    n = int(kv.get("SOLIDMODELS.NUM", "0") or 0)
    entries = []
    for i in range(n):
        tgt = kv.get(f"SOLIDMODEL{i}", "").lower()
        mat = kv.get(f"TRANSFORMMATRIX{i}", "")
        color = kv.get(f"COLOR{i}", "")
        if tgt:
            entries.append({
                "idx": i, "target": tgt.rsplit("/", 1)[-1],
                "mat": np.array([float(x) for x in mat.split(",") if x.strip()]) if mat else None,
                "hasColor": bool(color),
            })
    return entries


def mat_info(m: np.ndarray | None):
    if m is None:
        return None
    R = m[:3, :3]
    det = float(np.linalg.det(R))
    orth = float(np.abs(R @ R.T - np.eye(3)).max())
    t = m[12:15]
    return {"det": round(det, 4), "orthErr": round(orth, 6),
            "t": [round(float(x), 2) for x in t], "tNorm": round(float(np.linalg.norm(t)), 2)}


def to_mat4(arr) -> np.ndarray:
    """列主序 16 浮点 -> 4x4（M[r,c] = arr[c*4+r]，与 Three.js Matrix4.elements 一致）"""
    M = np.zeros((4, 4))
    for i in range(16):
        M[i % 4, i // 4] = arr[i]
    return M


phm_files = {p.name.lower(): p for p in root.rglob("*.phm")}
phm_data = {b: parse_phm(p) for b, p in phm_files.items()}

# 引用图与深度
children: dict[str, list] = defaultdict(list)
for b, entries in phm_data.items():
    for e in entries:
        children[b].append(e)

depth_cache: dict[str, int] = {}


def depth(b: str, seen: frozenset) -> int:
    if b in depth_cache:
        return depth_cache[b]
    if b in seen:
        return 0
    d = 0
    for e in children.get(b, []):
        if e["target"].endswith(".phm") and e["target"] in phm_data:
            d = max(d, 1 + depth(e["target"], seen | {b}))
    depth_cache[b] = d
    return d


depths = Counter(depth(b, frozenset()) for b in phm_data)
print(f"=== {SID}: PHM 嵌套深度分布 ===")
print(" ", dict(sorted(depths.items())))

# 找一条最深链
deepest = max(phm_data, key=lambda b: depth(b, frozenset()))
print(f"\n=== 最深链示例（起点 {deepest}, 深度 {depth(deepest, frozenset())}）===")
cur = deepest
level = 0
seen = set()
while cur in phm_data and cur not in seen:
    seen.add(cur)
    entries = phm_data[cur]
    print(f" L{level} {cur}  ({len(entries)} 个引用)")
    for e in entries[:4]:
        if e["mat"] is not None:
            info = mat_info(to_mat4(e["mat"]))
            kind = "IDENTITY" if abs(info["tNorm"]) < 1e-9 and abs(info["det"] - 1) < 1e-6 and info["orthErr"] < 1e-6 else (
                "TRANS_ONLY" if info["orthErr"] < 1e-6 and abs(info["det"] - 1) < 1e-6 else "GENERAL")
            print(f"   -> {e['target']:<44} kind={kind:<11} det={info['det']:>8} "
                  f"orthErr={info['orthErr']} t={info['t']} color={e['hasColor']}")
        else:
            print(f"   -> {e['target']:<44} 无矩阵")
    if len(entries) > 4:
        print(f"   ... 共 {len(entries)} 条")
    nxt = next((e["target"] for e in entries if e["target"].endswith(".phm")), None)
    if not nxt:
        break
    cur = nxt
    level += 1

# 逐层矩阵统计
print("\n=== 按嵌套层级的矩阵统计 ===")
layer_stats: dict[int, Counter] = defaultdict(Counter)
layer_tnorms: dict[int, list] = defaultdict(list)


def walk_level(b: str, lvl: int, seen: frozenset):
    if b in seen or b not in phm_data:
        return
    seen = seen | {b}
    for e in phm_data[b]:
        if e["mat"] is None:
            continue
        M = to_mat4(e["mat"])
        R = M[:3, :3]
        det = float(np.linalg.det(R))
        orth = float(np.abs(R @ R.T - np.eye(3)).max())
        tn = float(np.linalg.norm(M[12:15]))
        is_id = np.allclose(M, np.eye(4), atol=1e-6)
        kind = "IDENTITY" if is_id else ("RIGID" if orth < 1e-4 and abs(det - 1) < 1e-4 else "OTHER")
        layer_stats[lvl][kind] += 1
        layer_tnorms[lvl].append(tn)
        if e["target"].endswith(".phm"):
            walk_level(e["target"], lvl + 1, seen)


roots = [b for b in phm_data if depth(b, frozenset()) == depth(deepest, frozenset())]
for r in roots[:200]:
    walk_level(r, 0, frozenset())

for lvl in sorted(layer_stats):
    ts = layer_tnorms[lvl]
    ts.sort()
    kinds = dict(layer_stats[lvl].most_common())
    med = ts[len(ts)//2] if ts else 0
    print(f" L{lvl}: n={sum(layer_stats[lvl].values()):<6} kinds={kinds}  平移模长中位={med:.1f} max={max(ts) if ts else 0:.1f}")

# 多父叶节点验证：同一叶被不同父引用
print("\n=== 同一叶 PHM 的多父引用（组合假设佐证）===")
leaf_parents: dict[str, set] = defaultdict(set)
for b, entries in phm_data.items():
    for e in entries:
        if e["target"].endswith(".phm"):
            leaf_parents[e["target"]].add(b)
multi = {k: v for k, v in leaf_parents.items() if len(v) > 1}
multi_with_mod = {k: v for k, v in multi.items()
                  if any(t["target"].endswith((".mod", ".gl")) for t in phm_data.get(k, []))}
print(f"  被多父引用且自身含几何的 PHM 数={len(multi_with_mod)}")
for k in list(multi_with_mod)[:3]:
    print(f"  {k} <- {sorted(multi_with_mod[k])[:3]}")
