# GIM 文件目录与粗分型

目标：确认解压后有哪些文件族。

> **2026-08-24 复核（10 样本）**：全部 10 个样本以 py7zr 解压成功（payload 均为 7z）。
> 扩展名统计、目录分布与文本/二进制粗判已全量重算，证据见 `_generated/file-inventory.csv` 与
> `_generated/text-binary-survey.csv`（`desktop/scripts/gim_survey/extract_inventory.py` 生成）。
> 本轮发现多项打破旧三样本基线的事实，见 §5。

## 1. 变电工程（4 个）

### 扩展名统计

| 扩展名 | demo-substation | substation02 | substation03 | substation04 |
| ------ | ----: | ----: | ----: | ----: |
| .cbm   | 8701 | 4737 | 423 | 686 |
| .fam   | 13056 | 3578 | 1899 | 962 |
| .dev   | 4179 | 1174 | 386 | 231 |
| .phm   | 4179 | **1174** | **3316** | 228 |
| .mod   | 4179 | **627** | 2570 | 703 |
| .stl   | 1803 | **0** | 556 | **1** |
| .ifc   | 12 | 17 | 8 | 19 |
| .sch/.std/.sld | 各1 | 0 | 0 | 各1 |
| .gl    | 0 | 0 | **45** | 0 |

### 目录分布

| 目录 | 扩展名 |
| ---- | ------ |
| CBM/DEV/PHM/MOD（全大写） | 各类型按上表分布；.fam 与 .cbm/.dev 同目录混放；.ifc 仅在 DEV；.sch/.std/.sld 在 CBM；.gl/.stl/.mod 在 MOD |

## 2. 线路工程（6 个）

### 扩展名统计

| 扩展名 | demo-line1 | line02 | line03 | line04 | line05 | line06 |
| ------ | ----: | ----: | ----: | ----: | ----: | ----: |
| .cbm   | 4998 | 9276 | 7949 | 499 | 5447 | 978 |
| .fam   | 5073 | 9005 | 6957 | 547 | 5967 | 1023 |
| .dev   | 1148 | 2135 | 1344 | 197 | 1747 | 268 |
| .phm   | 563 | 1071 | 1327 | 79 | 1129 | 114 |
| .mod   | 508 | 1033 | 865 | 31 | 1069 | 76 |
| .stl   | 82 | 120 | 91 | 41 | 121 | 49 |
| .ifc / .sch / .std / .sld | 无 | 无 | 无 | 无 | 无 | 无 |

### 目录分布

| 目录 | 扩展名 |
| ---- | ------ |
| Cbm/Dev/Phm/Mod（首字母大写） | 结构与旧线路基线一致；.fam 混放于 Cbm/Dev；.mod/.stl 在 Mod |

## 3. 跨样本规律（升级为候选通用规则）

| 维度 | 结论 | 样本支持度 |
| --- | --- | --- |
| 四目录结构 | 解压后恒为 CBM/DEV/PHM/MOD 四目录（大小写随工程类型） | 10/10 |
| 目录大小写 | 变电全大写、线路首字母大写 | 10/10（4+6） |
| IFC 归属 | .ifc 仅出现在变电 DEV 目录；线路工程无 IFC | 10/10 |
| 三件套归属 | .sch/.std/.sld 在 CBM 目录，且仅 JinQu/SDDP 两个变电工具产出 | 2/4 变电 |
| STL 归属 | .stl 在 MOD 目录；变电可有可无（变电站02为 0），线路必有 | 10/10 |

## 4. 文本 / 二进制粗判

- CBM/FAM/DEV/PHM 全部 text-like（10 样本一致）。
- MOD：变电新样本（Bentley/BIMBase/SDDP）全部为 XML；JinQu 的 demo-substation 也全部 text-like；
  线路全部 text-like。MOD 不是黑盒二进制的结论保持。
- STL：binary-like 为主，但 **line03 出现 3 个 ASCII STL**（header `solid AssimpScene`，
  不满足 `84 + 50×N` 长度公式），详见 §5。
- FAM 出现**空文件**：line03 772 个、substation02 659 个、substation03 43 个
  （0 字节）。旧基线"空 FAM 仅变电 CBM 目录少量出现"不再准确。

## 5. 打破旧基线的发现（本轮重点）

以下旧结论来自单变电 + 双线路样本，本轮证伪或需收窄：

| # | 旧结论 | 新事实 | 影响 |
| --- | --- | --- | --- |
| 1 | 变电 `.dev = .phm = .mod` 数量完全一致（demo-substation 均 4179） | 变电站02 dev=1174/phm=1174/mod=627；变电站03 dev=386/**phm=3316**/mod=2570；变电站04 dev=231/phm=228/mod=703 | "DEV:PHM:MOD 一一对应"是 JinQu 工具的导出习惯，不是格式规则。PHM 可多于 MOD（多对一复用）、可少于 DEV |
| 2 | 变电必有大量 STL（1803 个） | 变电站02 **0 个 STL**；变电站04仅 1 个 | STL 是可选几何载体，非变电必备 |
| 3 | MOD 只在 MOD 目录且扩展名只有 .mod/.stl | 变电站03出现 **45 个 .gl 文件**（MOD 目录），XML Device 格式但 primitive 为新类型 `GimGeCableConcentration`（含 D/Phase/Direction/ConnectGuid/ConnectionRules 属性），`Visible="true"` 小写 | 几何资源扩展名集合扩大到 {.mod, .stl, .gl}；primitive 家族未封闭 |
| 4 | STL 100% binary | line03 有 3 个 ASCII STL（`solid AssimpScene` header，非 SLW3D 工具产出） | STL loader 必须兼容 ASCII 分支 |
| 5 | SCH/STD/SLD 是变电标配（旧唯一变电样本有） | Bentley/BIMBase 变电样本无三件套 | 三件套与导出软件绑定，不能假设存在 |
| 6 | 空 FAM 少量存在 | 线路03 772 个空 FAM（占该样本 .fam 的 11%） | 属性解析必须容忍空文件；FAM 缺失≠引用损坏 |

## 6. 对解析器的影响

- 文件发现逻辑不能枚举固定扩展名白名单来收集几何资源；应按目录 + 引用值驱动（PHM SOLIDMODELn 的值决定目标）。
- `DEV=PHM=MOD` 数量关系不可用于校验或快速路径假设（现有代码若有此假设需复核）。
- STL 加载器需增加 ASCII STL 支持（当前 web/桌面实现是否支持待查）。
- .gl 文件当前 parser 不会加载；其 XML 结构与 .mod 同构，短期可在文件发现阶段把 `.gl` 视同 `.mod` 处理（渲染层按 primitive 兜底跳过未知类型）。

## 脚本

```bash
# 解压全部样本 + 生成清单/粗判 CSV
python desktop/scripts/gim_survey/extract_inventory.py
```

历史 PowerShell 版本保留在 `_generated/`，新样本建议优先使用上述 Python 脚本（自动处理 GIMPKGS/GIMPKGT 头部切割）。
