## Round 2-B1：CBM -> FAM 引用完整性与覆盖关系

### 1. 校验范围

本节记录当前两个 demo 中 `CBM -> BASEFAMILY -> FAM` 的引用完整性和覆盖关系。

当前只做文件级引用与字段分布分析，不解释 FAM 字段业务语义，不建立固定 DTO，不做渲染实现。

分析对象：

```text
demo-line
demo-substation
```

### 2. 总体统计

| 样本              | CBM 总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 | FAM 缺失 | 唯一 BASEFAMILY |
| --------------- | -----: | -----------: | -----------: | -----: | -----: | ------------: |
| demo-line       |  27829 |        21967 |         5862 |  21967 |      0 |         21967 |
| demo-substation |   8701 |         8554 |          147 |   8554 |      0 |          8554 |

当前结论：

1. 当前两个 demo 中，凡是 CBM 写了 `BASEFAMILY`，目标 FAM 文件均存在。
2. `CBM -> BASEFAMILY -> FAM` 的文件级引用完整性为 100%。
3. 当前两个 demo 中，`BASEFAMILY` 基本呈现一 CBM 对一 FAM 的实例级对应关系。
4. 暂未观察到多个 CBM 复用同一个 FAM 的情况。

因此，当前不宜把 FAM 先验定义为“可复用族模板”。更稳妥的表述是：

```text
FAM 是 CBM 节点关联的属性文件。
当前两个 demo 中，BASEFAMILY 呈现一 CBM 对一 FAM 的实例级属性 sidecar 特征。
```

### 3. 按 modelKind 的 FAM 覆盖关系

#### demo-line

| modelKind        |    总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 | FAM 缺失 |     覆盖率 |
| ---------------- | ----: | -----------: | -----------: | -----: | -----: | ------: |
| DEV              | 21857 |        21857 |            0 |  21857 |      0 | 100.00% |
| CBM_GROUP        |  5534 |            0 |         5534 |      0 |      0 |   0.00% |
| NO_MODEL_POINTER |   438 |          110 |          328 |    110 |      0 |  25.11% |

结论：

* 线路样本中，DEV 型 CBM 全部有 FAM。
* CBM_GROUP 型 CBM 全部没有 FAM。
* NO_MODEL_POINTER 型 CBM 只有少量有 FAM。
* 线路样本的 FAM 主要服务于具体业务对象节点，而不是分组节点。

#### demo-substation

| modelKind        |   总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 | FAM 缺失 |     覆盖率 |
| ---------------- | ---: | -----------: | -----------: | -----: | -----: | ------: |
| IFC              | 4360 |         4360 |            0 |   4360 |      0 | 100.00% |
| DEV              | 4179 |         4179 |            0 |   4179 |      0 | 100.00% |
| NO_MODEL_POINTER |  162 |           15 |          147 |     15 |      0 |   9.26% |

结论：

* 变电样本中，IFC 型 CBM 全部有 FAM。
* DEV 型 CBM 全部有 FAM。
* NO_MODEL_POINTER 型 CBM 大部分没有 FAM。
* 变电样本的 FAM 覆盖范围比线路样本更强，尤其覆盖了全部 IFC 关联节点。

### 4. 按 entityName + modelKind 的 FAM 覆盖关系

#### demo-line

| entityName + modelKind     |    总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 |     覆盖率 |
| -------------------------- | ----: | -----------: | -----------: | -----: | ------: |
| Wire_Device, DEV           | 11773 |        11773 |            0 |  11773 | 100.00% |
| F4System, CBM_GROUP        |  5534 |            0 |         5534 |      0 |   0.00% |
| WIRE, DEV                  |  5460 |         5460 |            0 |   5460 | 100.00% |
| Tower_Device, DEV          |  4309 |         4309 |            0 |   4309 | 100.00% |
| F4System, NO_MODEL_POINTER |   327 |            0 |          327 |      0 |   0.00% |
| CROSS, DEV                 |   315 |          315 |            0 |    315 | 100.00% |
| F3System, NO_MODEL_POINTER |   108 |          108 |            0 |    108 | 100.00% |

线路样本中可暂定：

```text
F1/F2/F3/F4System：系统 / 分组层
Wire_Device / WIRE / Tower_Device / CROSS：业务对象层
业务对象层通常有 DEV + FAM
F4System 分组层通常没有 FAM
```

#### demo-substation

| entityName + modelKind     |   总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 |     覆盖率 |
| -------------------------- | ---: | -----------: | -----------: | -----: | ------: |
| F4System, IFC              | 4360 |         4360 |            0 |   4360 | 100.00% |
| PARTINDEX, DEV             | 3894 |         3894 |            0 |   3894 | 100.00% |
| F4System, DEV              |  285 |          285 |            0 |    285 | 100.00% |
| F3System, NO_MODEL_POINTER |  145 |            0 |          145 |      0 |   0.00% |
| F2System, NO_MODEL_POINTER |   14 |           14 |            0 |     14 | 100.00% |

变电样本中可暂定：

```text
F4System 不能简单视为纯分组节点。
F4System 既可能是 IFC 关联节点，也可能是 DEV 关联节点。
判断 F4System 的角色时，必须结合 modelKind、IFCFILE、OBJECTMODELPOINTER、BASEFAMILY、SUBDEVICE 等字段。
```

### 5. FAM 字段形态

#### demo-line

FAM 行类型分布：

| rowKind             |     数量 |
| ------------------- | -----: |
| CN_KEY_VALUE        | 179123 |
| KEY_VALUE           |   3063 |
| CONTINUATION_OR_RAW |   1330 |

主要字段包括：

```text
MATERIALCODE
MANUFACTURER
BUNDLENUMBER
TYPE
SAFETYCOEFFICIENTMAXTENSION
EVERYDAYTENSION
MAXTENSION
PHASE
VOLTAGE
WIREPOINT
TOWERPOINT
INSULATORTYPE
TOWERNUMBER
LINEANGLE
RULINGSPAN
SPAN
```

线路 FAM 字段以英文 KEY 为主，偏线路工程参数，例如导线、杆塔、绝缘子串、基础、张力、应力、相序、电压等级等。

#### demo-substation

FAM 行类型分布：

| rowKind             |    数量 |
| ------------------- | ----: |
| CN_KEY_VALUE        | 40858 |
| CONTINUATION_OR_RAW |  6029 |
| KEY_VALUE           |     9 |

主要字段包括：

```text
额定电压
生产厂家
单位
电网工程标识系统编码
软件版本
装置名称
装置型号
装置编号
实物ID
工程中名称
附件名称
建设期次
三维设计模型编码
设备名称
电压等级
调度编码
```

变电 FAM 字段以中文 KEY 为主，偏设备台账、工程管理、设备参数和编码信息。

### 6. 阶段性结论

Round 2-B1 / B2 当前可以形成以下结论：

1. 当前两个 demo 中，`CBM -> BASEFAMILY -> FAM` 文件级引用完整性为 100%。
2. 凡是 CBM 写了 `BASEFAMILY`，目标 FAM 文件均存在。
3. 当前两个 demo 中，`BASEFAMILY` 基本呈现一 CBM 对一 FAM 的实例级对应关系，暂未观察到多 CBM 复用同一 FAM。
4. FAM 更适合作为 CBM 节点的属性 sidecar，而不是先验定义为可复用族模板。
5. 线路样本中，DEV 型业务对象节点全部有 FAM；F4System 分组节点通常没有 FAM。
6. 变电样本中，IFC 型和 DEV 型 CBM 全部有 FAM；F4System 既可能是 IFC 关联节点，也可能是 DEV 关联节点。
7. 不能仅凭 `ENTITYNAME=F4System` 判断节点是否为分组节点，必须结合 `modelKind`、`IFCFILE`、`OBJECTMODELPOINTER`、`BASEFAMILY`、`SUBDEVICE` 等字段。
8. 线路与变电 FAM 字段 schema 差异显著，后续解析应保持弱 schema / key-value 结构，不宜过早固定 DTO。

### 7. 当前不能下的结论

以下结论当前证据不足，不应写死：

```text
FAM 是标准族模板
FAM 可跨 CBM 复用
FAM 字段可以统一映射成固定 DTO
F4System 一定是分组节点
F4System 一定是具体构件节点
CBM 与 FAM 有同名字段必须一致
```
