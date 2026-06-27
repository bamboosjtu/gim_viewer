# GIM 引用完整性校验

## 1. 当前范围

本文记录当前两个 demo 的 GIM 文件引用完整性校验结果：

- `demo-line`
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

## 3. demo-line CBM 引用完整性

线路样本的 CBM 引用完整性统计：

| 指标     |  数量 |
| -------- | ----: |
| 引用总数 | 61376 |
| 成功引用 | 61376 |
| 缺失引用 |     0 |
| DEV 引用 | 21857 |
| FAM 引用 | 21967 |
| CBM 引用 | 17552 |
| IFC 引用 |     0 |
| 缺失 DEV |     0 |
| 缺失 FAM |     0 |
| 缺失 CBM |     0 |
| 缺失 IFC |     0 |

按引用目标类型分布：

| 目标类型 |  数量 |
| -------- | ----: |
| FAM      | 21967 |
| DEV      | 21857 |
| CBM      | 17552 |

当前判断：

- `demo-line` 中，CBM 层引用全部可解析到实际文件。
- `OBJECTMODELPOINTER=*.dev` 指向的 DEV 文件全部存在。
- `BASEFAMILY=*.fam` 指向的 FAM 文件全部存在。
- `SUBDEVICEn=*.cbm` 指向的子 CBM 文件全部存在。
- 线路样本中未发现 IFC 引用。

---

## 4. demo-substation CBM 引用完整性

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

当前只确认文件级引用完整性，不解析 MOD/STL 几何，不校验 IFCGUID 是否能在 IFC 文件内部命中。

其中：

- `CBM -> DEV` 当前已完成文件存在性校验。
- `CBM -> FAM` 当前已完成文件存在性校验。
- `CBM -> CBM` 当前已完成文件存在性校验。
- `CBM -> IFC` 当前已完成文件存在性校验。
- `IFCGUID` 目前只校验字段存在性，尚未校验 GUID 是否能在 IFC 文件内部命中。

---

## 8. 尚未完成的校验

| 校验项                      | 状态   |
| --------------------------- | ------ |
| CBM -> DEV/FAM/CBM/IFC      | 已完成 |
| DEV -> PHM                  | 已完成 |
| DEV -> DEV                  | 已完成 |
| PHM -> MOD/STL              | 已完成 |
| IFCGUID -> IFC 内部构件     | 待校验 |
| FAM 与 CBM/DEV 的字段一致性 | 待分析 |

当前不进入 MOD/STL 几何解析，不展开 IFC 构件属性分析。
