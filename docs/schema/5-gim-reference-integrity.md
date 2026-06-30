# GIM 引用完整性校验

## 1. 当前范围

本文记录当前3个 demo 的 GIM 文件引用完整性校验结果：

- `demo-line`、`demo-line1`
- `demo-substation`

当前阶段校验 CBM、DEV、PHM 三层的文件级引用目标是否存在，不递归展开完整模型树，不解析 PHM / MOD / STL 几何。

本轮 CBM 层校验字段包括：

| 字段                 | 引用目标 | 说明                  |
| -------------------- | -------- | --------------------- |
| `OBJECTMODELPOINTER` | `.dev`   | CBM 指向 DEV 物理模型 |
| `BASEFAMILY`         | `.fam`   | CBM 指向 FAM 属性文件 |
| `SUBDEVICEn`         | `.cbm`   | CBM 指向子 CBM 节点   |
| `IFCFILE`            | `.ifc`   | CBM 指向 IFC 文件     |

---

## 2. 校验方法

校验方法：

1. 扫描样本目录下所有文件，建立文件名索引。
2. 扫描所有 `.cbm` 文件。
3. 提取以下引用字段：
   - `OBJECTMODELPOINTER=*.dev`
   - `BASEFAMILY=*.fam`
   - `SUBDEVICEn=*.cbm`
   - `IFCFILE=*.ifc`

4. 使用大小写不敏感的文件名匹配，判断引用目标是否存在。
5. 输出引用明细 CSV 和汇总统计。

当前生成文件：

```text
docs/schema/_generated/demo-line-cbm-integrity.csv
docs/schema/_generated/demo-substation-cbm-integrity.csv
```

`_generated` 目录为临时分析输出，不进入版本管理。

---

## 3. 线路工程 CBM 引用完整性

线路样本的 CBM 引用完整性统计：

| 指标     |  line | line1 |
| -------- | ----: | ----: |
| 引用总数 | 61376 | 14877 |
| 成功引用 | 61376 | 14877 |
| 缺失引用 |     0 |     0 |
| DEV 引用 | 21857 |  3900 |
| FAM 引用 | 21967 |  3925 |
| CBM 引用 | 17552 |  7052 |
| IFC 引用 |     0 |     0 |
| 缺失 DEV |     0 |     0 |
| 缺失 FAM |     0 |     0 |
| 缺失 CBM |     0 |     0 |
| 缺失 IFC |     0 |     0 |

按引用目标类型分布：

| 目标类型 |  line | line1 |
| -------- | ----: | ----: |
| FAM      | 21967 |  3925 |
| DEV      | 21857 |  3900 |
| CBM      | 17552 |  7052 |

当前判断：

- `demo-line` 中，CBM 层引用全部可解析到实际文件。
- `OBJECTMODELPOINTER=*.dev` 指向的 DEV 文件全部存在。
- `BASEFAMILY=*.fam` 指向的 FAM 文件全部存在。
- `SUBDEVICEn=*.cbm` 指向的子 CBM 文件全部存在。
- 线路样本中未发现 IFC 引用。

---

## 4. 变电工程 CBM 引用完整性

变电样本的 CBM 引用完整性统计：

| 指标     |  数量 |
| -------- | ----: |
| 引用总数 | 20987 |
| 成功引用 | 20987 |
| 缺失引用 |     0 |
| DEV 引用 |  4179 |
| FAM 引用 |  8554 |
| CBM 引用 |  3894 |
| IFC 引用 |  4360 |
| 缺失 DEV |     0 |
| 缺失 FAM |     0 |
| 缺失 CBM |     0 |
| 缺失 IFC |     0 |

按引用目标类型分布：

| 目标类型 | 数量 |
| -------- | ---: |
| FAM      | 8554 |
| IFC      | 4360 |
| DEV      | 4179 |
| CBM      | 3894 |

当前判断：

- `demo-substation` 中，CBM 层引用全部可解析到实际文件。
- `OBJECTMODELPOINTER=*.dev` 指向的 DEV 文件全部存在。
- `BASEFAMILY=*.fam` 指向的 FAM 文件全部存在。
- `SUBDEVICEn=*.cbm` 指向的子 CBM 文件全部存在。
- `IFCFILE=*.ifc` 指向的 IFC 文件全部存在。

---

## 5. demo-line DEV / PHM 引用完整性

线路样本的 DEV / PHM 引用完整性统计：

| 指标                 |   数量 |
| -------------------- | -----: |
| 引用总数             | 143594 |
| 成功引用             | 143594 |
| 缺失引用             |      0 |
| DEV -> PHM           |   1836 |
| DEV -> DEV           | 138622 |
| DEV SUBDEVICE -> DEV |      0 |
| PHM -> MOD           |   2955 |
| PHM -> STL           |    181 |
| 异常引用             |      0 |
| 缺失 DEV             |      0 |
| 缺失 PHM             |      0 |
| 缺失 MOD             |      0 |
| 缺失 STL             |      0 |

按引用类型分布：

| 来源 | 目标 | 是否存在 |   数量 |
| ---- | ---- | -------- | -----: |
| DEV  | DEV  | True     | 138622 |
| PHM  | MOD  | True     |   2955 |
| DEV  | PHM  | True     |   1836 |
| PHM  | STL  | True     |    181 |

当前判断：

- `demo-line` 中，DEV / PHM 层引用全部可解析到实际文件。
- `DEV -> PHM` 引用目标全部存在。
- `DEV -> DEV` 引用目标全部存在。
- `PHM -> MOD` 引用目标全部存在。
- `PHM -> STL` 引用目标全部存在。
- 未发现缺失引用。
- 未发现超出当前预期的引用类型。

---

## 6. demo-substation DEV / PHM 引用完整性

变电样本的 DEV / PHM 引用完整性统计：

| 指标                 |  数量 |
| -------------------- | ----: |
| 引用总数             | 14011 |
| 成功引用             | 14011 |
| 缺失引用             |     0 |
| DEV -> PHM           |  4179 |
| DEV -> DEV           |     0 |
| DEV SUBDEVICE -> DEV |  3894 |
| PHM -> MOD           |  4135 |
| PHM -> STL           |  1803 |
| 异常引用             |     0 |
| 缺失 DEV             |     0 |
| 缺失 PHM             |     0 |
| 缺失 MOD             |     0 |
| 缺失 STL             |     0 |

按引用类型分布：

| 来源 | 目标 | 是否存在 | 数量 |
| ---- | ---- | -------- | ---: |
| DEV  | PHM  | True     | 4179 |
| PHM  | MOD  | True     | 4135 |
| DEV  | DEV  | True     | 3894 |
| PHM  | STL  | True     | 1803 |

说明：

- 上表中的 `DEV -> DEV` 在变电样本中来自 `SUBDEVICEn=*.dev`，不是 `SOLIDMODELn=*.dev`。
- `demo-substation` 中，DEV / PHM 层引用全部可解析到实际文件。
- `DEV -> PHM` 引用目标全部存在。
- `DEV SUBDEVICE -> DEV` 引用目标全部存在。
- `PHM -> MOD` 引用目标全部存在。
- `PHM -> STL` 引用目标全部存在。
- 未发现缺失引用。
- 未发现超出当前预期的引用类型。

---

## 7. 当前结论

当前两个 demo 的 CBM 层引用完整性均为 100%。

```text
demo-line:
CBM -> DEV
CBM -> FAM
CBM -> CBM

demo-substation:
CBM -> DEV
CBM -> FAM
CBM -> CBM
CBM -> IFC
```

DEV / PHM 层引用完整性也已完成校验：

```text
demo-line:
DEV -> PHM
DEV -> DEV
PHM -> MOD
PHM -> STL

demo-substation:
DEV -> PHM
DEV -> SUBDEVICE -> DEV
PHM -> MOD
PHM -> STL
```

当前两个 demo 中，CBM、DEV、PHM 三层的文件级引用目标均存在。

因此，当前文件级静态引用链可以暂定为：

```text
CBM
 ├─ OBJECTMODELPOINTER -> DEV
 │   ├─ SOLIDMODEL -> PHM
 │   │   └─ SOLIDMODEL -> MOD/STL
 │   └─ SOLIDMODEL/SUBDEVICE -> DEV
 ├─ BASEFAMILY -> FAM
 ├─ SUBDEVICE -> CBM
 └─ IFCFILE + IFCGUID -> IFC
```

当前只确认文件级引用完整性和 IFCGUID 文本命中情况，不解析 MOD/STL 几何，不展开 IFC 构件属性语义。

其中：

- `CBM -> DEV` 当前已完成文件存在性校验。
- `CBM -> FAM` 当前已完成文件存在性校验。
- `CBM -> CBM` 当前已完成文件存在性校验。
- `CBM -> IFC` 当前已完成文件存在性校验。

---

## 8. IFCGUID -> IFC 内部命中校验

### 8.1 校验范围

本节记录 `demo-substation` 中 CBM 的 `IFCFILE + IFCGUID` 是否能在对应 IFC 文件内部命中。

当前只做文本级命中校验，不解析 IFC 语义，不展开 IFC 构件属性。

校验对象：

| 字段          | 说明                                       |
| ------------- | ------------------------------------------ |
| `IFCFILE`     | CBM 指向的 IFC 文件名                      |
| `IFCGUID`     | CBM 中记录的 IFC GUID                      |
| 声明 IFC 文件 | `IFCFILE` 指向的 IFC 文件                  |
| 任意 IFC 文件 | 当前 demo-substation 中全部 12 个 IFC 文件 |

### 8.2 总体统计

| 指标                              | 数量 |
| --------------------------------- | ---: |
| IFC 引用总数                      | 4360 |
| 有 IFCFILE                        | 4360 |
| 有 IFCGUID                        | 4360 |
| IFC 文件存在                      | 4360 |
| IFC 文件缺失                      |    0 |
| 精确命中声明 IFC 文件             | 3252 |
| 精确未命中声明 IFC 文件           | 1108 |
| 大小写不敏感命中声明 IFC 文件     | 3296 |
| 大小写不敏感未命中声明 IFC 文件   | 1064 |
| 精确命中任意 IFC 文件             | 3252 |
| 任意 IFC 文件均未精确命中         | 1108 |
| 大小写不敏感命中任意 IFC 文件     | 3296 |
| 任意 IFC 文件均未大小写不敏感命中 | 1064 |
| 唯一 IFC 文件数                   |   12 |
| 唯一 IFCGUID 数                   | 3429 |

当前判断：

- `IFCFILE` 文件存在性为 100%。
- `IFCGUID` 精确命中声明 IFC 文件的比例为 `3252 / 4360 = 74.59%`。
- `IFCGUID` 大小写不敏感命中声明 IFC 文件的比例为 `3296 / 4360 = 75.60%`。
- 有 `44` 条记录属于精确未命中但大小写不敏感命中。
- 有 `1064` 条记录在当前 12 个 IFC 文件中均未命中。

### 8.3 按 IFC 文件统计

| IFC 文件                               | 总数 | 精确命中 | 大小写不敏感命中 | 精确未命中 | 精确命中率 |
| -------------------------------------- | ---: | -------: | ---------------: | ---------: | ---------: |
| 给排水消防及排油添加主变水喷淋0401.ifc | 1332 |      597 |              597 |        735 |     44.82% |
| 一次设备0402其他.ifc                   |  972 |      721 |              759 |        251 |     74.18% |
| 建筑部分0317.ifc                       |  960 |      864 |              870 |         96 |     90.00% |
| 基础0317.ifc                           |   95 |       75 |               75 |         20 |     78.95% |
| 结构0317.ifc                           |  260 |      258 |              258 |          2 |     99.23% |
| 动力照明0317.ifc                       |   48 |       46 |               46 |          2 |     95.83% |
| 电气二次0317其他.ifc                   |    6 |        6 |                6 |          0 |    100.00% |
| 暖通布置0317.ifc                       |   58 |       58 |               58 |          0 |    100.00% |
| 室内给排水0317.ifc                     |  353 |      353 |              353 |          0 |    100.00% |
| 接地0317其他.ifc                       |   57 |       57 |               57 |          0 |    100.00% |
| 总图0317.ifc                           |  145 |      144 |              144 |          1 |     99.31% |
| 警卫室建筑0317.ifc                     |   74 |       73 |               73 |          1 |     98.65% |

### 8.4 硬未命中分型

硬未命中指：

```text
caseInsensitiveInAnyIfc = False
```

即该 IFCGUID 在当前 demo-substation 的全部 12 个 IFC 文件中都没有命中。

硬未命中数量为 1064。

硬未命中 CBM 上下文分布：

| 字段                 | 结果              |
| -------------------- | ----------------- |
| `ENTITYNAME`         | 全部为 `F4System` |
| `OBJECTMODELPOINTER` | 全部为空          |
| `BASEFAMILY`         | 全部有值          |
| `SUBDEVICE`          | 全部无            |
| `SUBDEVICES.NUM`     | 全部为 0          |

硬未命中按 IFCGUID 聚合后高度集中：

| IFCGUID                  | 数量 |
| ------------------------ | ---: |
| `3Zu5Bv0LOHrPC10026FoUj` |  740 |
| `3Aw$FV5MbAufEo59pkoNlf` |  193 |

其中：

- `3Zu5Bv0LOHrPC10026FoUj` 主要出现在 给排水消防及排油添加主变水喷淋0401.ifc 对应的 CBM 记录中。
- `3Aw$FV5MbAufEo59pkoNlf` 主要出现在 一次设备0402其他.ifc 对应的 CBM 记录中。
- 使用大小写不敏感的 Select-String 复核后，这两个 GUID 均未在当前 12 个 IFC 文件中命中。

---

### 8.5 当前判断

当前 `IFCFILE + IFCGUID` 不能统一视为“可直接定位 IFC 构件”的强关联。

应分三类处理：

| 类型                  | 判断                                        |
| --------------------- | ------------------------------------------- |
| 精确命中              | 可作为强 IFC 构件关联                       |
| 大小写不敏感命中      | 可作为弱 IFC 构件关联，后续实现中需谨慎处理 |
| 任意 IFC 文件均未命中 | 不应直接用于 IFC 构件定位                   |

硬未命中的 IFCGUID 不宜直接判定为错误 GUID。根据当前 CBM 上下文，它们全部属于：

```text
ENTITYNAME = F4System
OBJECTMODELPOINTER = 空
BASEFAMILY = 有值
SUBDEVICE = 无
```

因此更稳妥的解释是：

```text
CBM 层存在一批 F4System 节点带 IFCFILE + IFCGUID，
但这些 IFCGUID 在当前 IFC 文本中不存在。
这些节点可能是系统、家族、分类、占位或导出残留关联，
暂时不能作为可定位 IFC 构件处理。
```

hard missing IFCGUID 主要由两个异常高频 GUID 驱动：

1. 3Zu5Bv0LOHrPC10026FoUj：740 条
2. 3Aw$FV5MbAufEo59pkoNlf：193 条

这两类合计 933 / 1064，占 hard missing 的 87.69%。

命中组与未命中组的 CBM 字段集合一致；
FAM 都是空 sidecar；
SYSCLASSIFYNAME 均为 &其他；
因此 hard missing 不是 FAM 字段问题，也不是 CBM 字段缺失问题。

```text
更稳妥的解释是：
部分 F4System + IFC 节点记录了 IFCFILE + IFCGUID，但这些 GUID 不存在于当前 IFC 文件文本中。
这些节点不能作为可直接定位的 IFC 构件处理，应作为弱关联 / 不可定位关联进入诊断告警。
```

当前结论只适用于当前 demo-substation，不应直接推广为全部 GIM 工程规则。

### 8.6 对浏览器实现的影响

当前 hard missing IFCGUID 不应直接判定为 GIM 错误或规范不合规。

从浏览器实现角度，应采用容错策略：

1. IFCFILE 存在且 IFCGUID 精确命中时，可作为强 IFC 构件关联。
2. IFCFILE 存在且 IFCGUID 仅大小写不敏感命中时，可作为弱 IFC 构件关联，并记录归一化警告。
3. IFCFILE 存在但 IFCGUID 在当前 IFC 文件中未命中时，不应阻断 GIM 加载；应保留 CBM 节点，并在诊断结果中提示该 IFCGUID 无法定位 IFC 构件。
4. IFCFILE 缺失时，也不应阻断整体加载；应保留 CBM 节点，并提示 IFC 文件缺失。

当前 demo-substation 中的 hard missing IFCGUID 主要由少数高频 GUID 驱动。其中两个 GUID 合计覆盖 933 / 1064 条 hard missing 记录，占 87.69%。

这说明 hard missing 更像“部分 F4System + IFC 节点记录了不可定位 IFCGUID”，而不是普通构件级 GUID 的随机缺失。

因此后续浏览器实现应把 IFCGUID 视为可选定位能力，而不是强制加载前提。

## 9. 尚未完成的校验

| 校验项                      | 状态                                 |
| --------------------------- | ------------------------------------ |
| CBM -> DEV/FAM/CBM/IFC      | 已完成                               |
| DEV -> PHM                  | 已完成                               |
| DEV -> DEV                  | 已完成                               |
| PHM -> MOD/STL              | 已完成                               |
| IFCGUID -> IFC 内部构件     | 已完成文本命中校验，存在硬未命中分型 |
| FAM 与 CBM/DEV 的字段一致性 | 待分析                               |

当前不进入 MOD/STL 几何解析，不展开 IFC 构件属性分析。
