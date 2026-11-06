# -*- coding: utf-8 -*-
"""btv_class —— BTV 融合兼容层（2026-11-03 拆分后保留，旧名一律 re-export）

btv 算法已按轨道拆成两个文件：
  · **btv_dev.py** —— dev 轨道：只读 cbm 的 F1–F4、SYSTEMNAME、fam 族属性与标识编码，
    独立产出「工程 → 桶 → 分项(F3) → 逐台 F4」业务树；
  · **btv_ifc.py** —— ifc 轨道：IFC 文件角色、楼层、构件、GUID 挂接，
    并产出回填字典 {guid: (kind, cat)} 与电气散材白名单。

本文件不再承载实现，只做两件事：
  1. re-export 旧名（`KIND_TAG` / `bk_key` / `fen_sort_key` / `fen_name` /
     `dev_class` / `volt_of_text` / `IFC_ELEC_RX` …），保证 `gim_gui.py`、
     `bay_infer.py` 的 import 不变；
  2. `build_btv()` 保留旧签名与旧语义（dev 树 + IFC 名称回填 + 电气划桶 + 坐标归位）。

需要分轨结果时不要走这里，直接用：
    dev_tree = btv_dev.build_dev_btv(p)          # 纯 GIM 轨道
    hints, elec = btv_ifc.fill_hints(fuz)        # IFC → 回填字典
    ifc_tree = btv_ifc.build_ifc_tree(fuz)       # 纯 IFC 轨道
命令行分轨导出见 `btv_split.py`。

分类通道（不变）：名称词表 → 标识编码段位回填（仅未分类/占位）→ IFC Name 回填（融合时）。
"""
from btv_dev import (  # noqa: F401
    VOLT_RX, RATED2NOMINAL, volt_of_text, scn_mid, unit_bucket,
    RX_ZXD, RX_CLS, KIND_TAG, dev_class,
    BUCKET_OVERRIDE, f4_bucket,
    CODE_RULES, code_rule,
    RX_TRF_FEN, fen_name,
    build_dev_btv, dev_stats,
    bk_key, BAY_ORDER, bay_rank, fen_sort_key,
)
from btv_ifc import (  # noqa: F401
    IFC_ELEC_RX, fill_hints, build_ifc_tree, ifc_stats, hooked_items,
)


def build_btv(p, fuz=None, bayinf=None, idx=None, granularity='device'):
    """融合口径（兼容旧调用）：dev 树 + IFC 名称回填 + 电气划桶 + 坐标归位。

    `granularity='device'`（默认，2026-11-03 起）：叶子按 gim_element 口径的实例
    （设备/材料/构件），词域外与无模型指针的 F4 不上树；`'f4'` 退回旧 F4 粒度。
    `idx` 可传入已建好的 `dev_inst.DeviceIndex`，避免重复构建。

    fuz 为空 → 等价于纯 dev 轨道（`btv_dev.build_dev_btv(p)`）。
    分轨用法：
        dev_tree = btv_dev.build_dev_btv(p)                  # 只看 GIM
        hints, elec = btv_ifc.fill_hints(fuz)                # IFC → 回填字典
        ifc_tree = btv_ifc.build_ifc_tree(fuz)               # 只看 IFC
    """
    hints, elec = {}, set()
    if fuz is not None:
        hints, elec = fill_hints(fuz)
    return build_dev_btv(p, hints=hints, rehome=bayinf or {}, elec=elec,
                         idx=idx, granularity=granularity)
