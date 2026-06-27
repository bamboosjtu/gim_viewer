# CBM 字段字典

## 1. 当前范围

本文基于当前两个 demo：

- `demo-line`
- `demo-substation`

目标是记录 CBM 文件中的字段角色、引用关系和线路 / 变电差异。

当前只做 schema analysis，不修改解析器，不调整数据库 schema，不递归展开完整设备树。

---

## 2. CBM 引用链总览

当前已观察到三类 CBM 下游引用：

```text
CBM -> DEV
CBM -> IFC
CBM -> CBM
```

字段对应关系：

| 字段                   | 目标          | 说明              |
| -------------------- | ----------- | --------------- |
| `OBJECTMODELPOINTER` | `.dev`      | 指向 DEV 物理模型     |
| `IFCFILE`            | `.ifc`      | 指向 IFC 文件       |
| `IFCGUID`            | IFC 构件 GUID | 指向 IFC 文件中的具体构件 |
| `SUBDEVICEn`         | `.cbm`      | 指向子 CBM 节点      |
| `BASEFAMILY`         | `.fam`      | 指向 CBM 属性文件     |

当前完整引用链候选为：

```text
CBM -> DEV -> PHM -> MOD/STL
CBM -> IFCFILE + IFCGUID
CBM -> SUBDEVICE -> CBM -> ...
```

---

## 3. demo-line CBM 全量统计

线路 CBM 共 27829 个。

| 指标                             |    数量 |
| ------------------------------ | ----: |
| CBM 总数                         | 27829 |
| 有 `BASEFAMILY`                 | 21967 |
| 有 `OBJECTMODELPOINTER`         | 21857 |
| `OBJECTMODELPOINTER` 指向 `.dev` | 21857 |
| 有 `IFCFILE`                    |     0 |
| 有 `IFCGUID`                    |     0 |
| 有 `SUBDEVICE`                  |  5534 |
| 有 `ENTITYNAME`                 | 27828 |
| 有 `GROUPTYPE`                  |  5861 |
| 有 `WIRETYPE`                   |  5460 |

当前判断：

* 线路 CBM 不使用 IFC 关联字段。
* 线路 CBM 通过 `OBJECTMODELPOINTER=*.dev` 指向 DEV。
* 线路 CBM 通过 `SUBDEVICEn=*.cbm` 建立 CBM 层级。
* `GROUPTYPE` 和 `WIRETYPE` 是线路特有的业务分组字段。

### 3.1 ENTITYNAME 分布

| ENTITYNAME     |    数量 | 判断           |
| -------------- | ----: | ------------ |
| `Wire_Device`  | 11773 | 导线设备节点       |
| `F4System`     |  5861 | F4 层级 / 分组节点 |
| `WIRE`         |  5460 | 导线实体节点       |
| `Tower_Device` |  4309 | 杆塔设备节点       |
| `CROSS`        |   315 | 跨越实体节点       |
| `F3System`     |   108 | F3 层级节点      |
| `F1System`     |     1 | F1 层级节点      |
| `F2System`     |     1 | F2 层级节点      |
| 空              |     1 | 待抽样确认        |

### 3.2 GROUPTYPE 分布

| GROUPTYPE |    数量 | 判断    |
| --------- | ----: | ----- |
| `WIRE`    |  5460 | 导线分组  |
| `TOWER`   |   327 | 杆塔分组  |
| `CROSS`   |    74 | 跨越分组  |
| 空         | 21968 | 非分组节点 |

### 3.3 WIRETYPE 分布

| WIRETYPE     |    数量 | 判断        |
| ------------ | ----: | --------- |
| `CONDUCTOR`  |  3834 | 导线        |
| `OPGW`       |   860 | OPGW 光缆   |
| `GROUNDWIRE` |   766 | 地线        |
| 空            | 22369 | 非 WIRE 节点 |

---

## 4. demo-substation CBM 全量统计

变电 CBM 共 8701 个。

| 指标                             |   数量 |
| ------------------------------ | ---: |
| CBM 总数                         | 8701 |
| 有 `BASEFAMILY`                 | 8554 |
| 有 `OBJECTMODELPOINTER`         | 4179 |
| `OBJECTMODELPOINTER` 指向 `.dev` | 4179 |
| 有 `IFCFILE`                    | 4360 |
| 有 `IFCGUID`                    | 4360 |
| 有 `SUBDEVICE`                  |  258 |
| 有 `ENTITYNAME`                 | 8699 |
| 有 `GROUPTYPE`                  |    0 |
| 有 `WIRETYPE`                   |    0 |

当前判断：

* 变电 CBM 同时存在 DEV 模型入口和 IFC 构件入口。
* `OBJECTMODELPOINTER=*.dev` 对应电气设备 / 物理模型入口。
* `IFCFILE + IFCGUID` 对应 IFC 模型中的构件关联。
* 变电 CBM 不使用线路中的 `GROUPTYPE` / `WIRETYPE`。
* 变电 CBM 也通过 `SUBDEVICEn=*.cbm` 建立 CBM 层级。

### 4.1 ENTITYNAME 分布

| ENTITYNAME  |   数量 | 判断              |
| ----------- | ---: | --------------- |
| `F4System`  | 4645 | F4 层级 / 设备或构件节点 |
| `PARTINDEX` | 3894 | 部件索引 / 构件索引节点候选 |
| `F3System`  |  145 | F3 层级节点         |
| `F2System`  |   14 | F2 层级节点         |
| `F1System`  |    1 | F1 层级节点         |
| 空           |    2 | 待抽样确认           |

---

## 5. 线路与变电 CBM 差异

| 维度       | demo-line                                         | demo-substation            |
| -------- | ------------------------------------------------- | -------------------------- |
| DEV 引用   | `OBJECTMODELPOINTER=*.dev`                        | `OBJECTMODELPOINTER=*.dev` |
| IFC 引用   | 无                                                 | `IFCFILE + IFCGUID`        |
| 子 CBM 引用 | `SUBDEVICEn=*.cbm`                                | `SUBDEVICEn=*.cbm`         |
| FAM 引用   | `BASEFAMILY=*.fam`                                | `BASEFAMILY=*.fam`         |
| 线路分组     | `GROUPTYPE`                                       | 无                          |
| 导线类型     | `WIRETYPE`                                        | 无                          |
| 主要实体     | `Wire_Device` / `WIRE` / `Tower_Device` / `CROSS` | `F4System` / `PARTINDEX`   |

---

## 6. 当前结论

当前可以确认：

```text
CBM -> DEV
CBM -> IFC
CBM -> CBM
```

更完整的 GIM 引用链为：

```text
CBM
 ├─ OBJECTMODELPOINTER -> DEV -> PHM -> MOD/STL
 ├─ IFCFILE + IFCGUID -> IFC
 └─ SUBDEVICE -> CBM -> ...
```

其中：

* `OBJECTMODELPOINTER` 是 CBM 指向 DEV 的主字段。
* `BASEFAMILY` 是 CBM 指向 FAM 属性文件的主字段。
* `SUBDEVICE` 是 CBM 内部层级递归字段。
* `IFCFILE / IFCGUID` 是变电 CBM 关联 IFC 的字段。
* `GROUPTYPE / WIRETYPE` 是线路 CBM 的业务分组字段。

当前阶段只记录字段角色和引用链，不递归展开完整模型，不解析 PHM/MOD/STL 几何。
