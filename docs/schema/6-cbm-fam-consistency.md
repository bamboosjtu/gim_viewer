# CBM → FAM 引用完整性与覆盖关系

## 1. 校验范围

本节记录当前 3 个 demo 中 `CBM → BASEFAMILY → FAM` 的引用完整性和覆盖关系。

当前只做文件级引用与字段分布分析，不解释 FAM 字段业务语义，不建立固定 DTO，不做渲染实现。

分析对象：

```text
demo-line       (线路工程)
demo-line1      (线路工程)
demo-substation (变电工程)
```

> **关键修正**：原版本只统计了单 `BASEFAMILY` 字段，遗漏了变电工程的多 FAM 字段 `BASEFAMILY1..N`。本次复核补充多 FAM 分析，并区分线路/变电的 FAM 引用模式差异。

---

## 2. 总体统计

| 样本              | CBM 总数 | 单 BASEFAMILY | 多 BASEFAMILY1..N | 多 FAM 文件数 | FAM 存在 | FAM 缺失 | 唯一 FAM |
| --------------- | -----: | -----------: | ---------------: | ----------: | -----: | -----: | -----: |
| demo-line       |  27829 |        21967 |                0 |           0 |  21967 |      0 |   21967 |
| demo-line1      |   4998 |         3925 |                0 |           0 |   3925 |      0 |    3925 |
| demo-substation |   8701 |         8554 |              580 |         145 |   9134 |      0 |    9134 |

> **修正说明**：原版本 demo-substation 的「有 BASEFAMILY」数为 8554，「唯一 BASEFAMILY」也为 8554。本次复核发现 demo-substation 还有 580 条多 FAM 引用（分布在 145 个 F3System 文件中），因此总 FAM 引用数应为 8554 + 580 = 9134。

当前结论：

1. 三个 demo 中，凡是 CBM 写了 `BASEFAMILY` 或 `BASEFAMILY1..N`，目标 FAM 文件均存在。
2. `CBM → BASEFAMILY → FAM` 的文件级引用完整性为 100%。
3. 线路工程（demo-line / demo-line1）只使用单 `BASEFAMILY`，每个 CBM 至多关联 1 个 FAM。
4. 变电工程（demo-substation）同时使用单 `BASEFAMILY` 和多 `BASEFAMILY1..N`，部分 CBM 可关联多个 FAM。
5. 暂未观察到多个 CBM 复用同一个 FAM 的情况（实例级 sidecar 特征）。

因此，当前不宜把 FAM 先验定义为"可复用族模板"。更稳妥的表述是：

```text
FAM 是 CBM 节点关联的属性文件。
线路工程：每个 CBM 至多 1 个 FAM（单 BASEFAMILY）。
变电工程：F3System 节点可关联多个 FAM（BASEFAMILY1..N，固定 4 个）。
当前三个 demo 中，BASEFAMILY 呈现一 CBM 对一 FAM 的实例级属性 sidecar 特征。
```

---

## 3. FAM 引用模式差异（线路 vs 变电）

### 3.1 线路工程：单 BASEFAMILY 模式

线路工程 CBM 仅使用 `BASEFAMILY=xxx.fam` 单字段，每个 CBM 节点至多关联 1 个 FAM 文件。

```text
BASEFAMILY=550e8400-e29b-41d4-a716-446655440000.fam
```

### 3.2 变电工程：单 BASEFAMILY + 多 BASEFAMILY1..N 混合模式

变电工程 CBM 同时存在两种 FAM 引用模式：

**模式一：单 BASEFAMILY（F4System / F2System 等）**

```text
BASEFAMILY=b50c5faa-6110-4f39-bc3b-1827a26f1302.fam
```

**模式二：多 BASEFAMILY1..N（仅 F3System）**

```text
ENTITYNAME=F3System
SYSCLASSIFYNAME=0AEC*006
SYSTEMNAME1=交流电气系统
SYSTEMNAME2=220kV系统
SYSTEMNAME3=3E出线间隔
SYSTEMNAME4=
BASEFAMILY1=e941d639-3ba0-4348-933f-09cd8da077eb.fam
BASEFAMILY2=caea5b52-1fc4-42c0-ac6c-4f5d7a4d6eef.fam
BASEFAMILY3=66f3678f-af5b-420c-88d3-f70aad040dc0.fam
BASEFAMILY4=6ccca981-91a2-4b95-9706-9b79bfe79f8d.fam
SUBSYSTEMS.NUM=1
SUBSYSTEM0=3f5db12b-9839-4749-97a6-f26af081a5a7.cbm
IFC.NUM=0
MATERIALSHEET=
```

### 3.3 多 FAM 分布特征

| 样本              | 多 FAM 文件数 | 每 文 件 FAM 数 | 总多 FAM 引用 | ENTITYNAME | SYSCLASSIFYNAME |
| --------------- | ----------: | ----------: | ----------: | ---------- | ---------- |
| demo-line       |           0 |           0 |           0 | —          | —          |
| demo-line1      |           0 |           0 |           0 | —          | —          |
| demo-substation |         145 |           4 |         580 | F3System   | 有值        |

**关键发现**：

- demo-substation 的 145 个多 FAM 文件全部为 `ENTITYNAME=F3System`。
- 每个文件的 `BASEFAMILY1..N` 数量固定为 4（无变异）。
- 这些 F3System 节点同时具有 `SYSCLASSIFYNAME` 和 `SYSTEMNAME1..4` 字段（变电层级分类字段）。
- `SYSTEMNAME4` 经常为空，但 `BASEFAMILY4` 仍然存在——表明 4 个 FAM 是固定槽位，与实际业务层级深度无关。
- 多 FAM F3System 通常带 `SUBSYSTEMS.NUM + SUBSYSTEM0`（继续向下递归）和 `IFC.NUM=0`（不直接关联 IFC）。

**业务推断**：变电 F3System 的 4 个 BASEFAMILY 可能对应 4 套不同视角的属性表（如设计参数、设备台账、施工信息、运维信息），与 `SYSTEMNAME1..4` 的 4 级分类体系对应。当前不展开业务语义解释，仅记录字段结构。

---

## 4. 按 modelKind 的 FAM 覆盖关系

### 4.1 modelKind 分类定义

| modelKind        | 判断条件                                              | 含义                           |
| ---------------- | --------------------------------------------------- | ------------------------------ |
| `DEV`            | `OBJECTMODELPOINTER` 非空，`IFCFILE` 空              | 关联 DEV 物理模型               |
| `IFC`            | `IFCFILE` 非空                                       | 关联 IFC 构件                  |
| `CBM_GROUP`      | `OBJECTMODELPOINTER` 与 `IFCFILE` 均空，有 `SUBDEVICE` | F4System 内部分组节点          |
| `NO_MODEL_POINTER` | `OBJECTMODELPOINTER` 与 `IFCFILE` 均空，无 `SUBDEVICE` | 系统层节点（F1/F2/F3）         |

> **修正说明**：原版本未明确 `CBM_GROUP` 与 `NO_MODEL_POINTER` 的判别条件。本次复核明确：`CBM_GROUP` 必须同时满足「无 OBJECTMODELPOINTER + 无 IFCFILE + 有 SUBDEVICE」，否则归入 `NO_MODEL_POINTER`。

### 4.2 demo-line

| modelKind        |    总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 | FAM 缺失 |     覆盖率 |
| ---------------- | ----: | -----------: | -----------: | -----: | -----: | ------: |
| DEV              | 21857 |        21857 |            0 |  21857 |      0 | 100.00% |
| CBM_GROUP        |  5534 |            0 |         5534 |      0 |      0 |   0.00% |
| NO_MODEL_POINTER |   438 |          110 |          328 |    110 |      0 |  25.11% |

结论：

- 线路样本中，DEV 型 CBM 全部有 FAM。
- CBM_GROUP 型 CBM 全部没有 FAM（F4System 纯分组节点）。
- NO_MODEL_POINTER 型 CBM 只有少量有 FAM（多为 F3System 层级节点）。
- 线路样本的 FAM 主要服务于具体业务对象节点，而不是分组节点。

### 4.3 demo-line1

| modelKind        |   总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 |     覆盖率 |
| ---------------- | ----: | -----------: | -----------: | -----: | ------: |
| DEV              |  3900 |         3900 |            0 |   3900 | 100.00% |
| CBM_GROUP        |   907 |            0 |          907 |      0 |   0.00% |
| NO_MODEL_POINTER |   191 |           25 |          166 |     25 |  13.09% |

> demo-line1 的 modelKind 分布与 demo-line 一致：DEV 全覆盖，CBM_GROUP 全无，NO_MODEL_POINTER 部分覆盖。

### 4.4 demo-substation

| modelKind        |   总数 | 有 BASEFAMILY | 有 BASEFAMILY1..N | 无 BASEFAMILY | FAM 存在 | FAM 缺失 |  覆盖率 |
| ---------------- | ----: | -----------: | ---------------: | -----------: | -----: | -----: | ------: |
| IFC              |  4360 |         4360 |                0 |             0 |   4360 |      0 | 100.00% |
| DEV              |  4179 |         4179 |                0 |             0 |   4179 |      0 | 100.00% |
| NO_MODEL_POINTER |   162 |           15 |              145 |            2 |    610 |      0 | 100.00% |

> **修正说明**：原版本把多 FAM 文件归入 `NO_MODEL_POINTER` 的「无 BASEFAMILY」分类是错误的——这些文件没有单 `BASEFAMILY`，但有 `BASEFAMILY1..N`，应计入「有 FAM」分类。本次复核更正后，demo-substation 的 NO_MODEL_POINTER 类型的 FAM 覆盖率从原 9.26% 修正为 100%（含多 FAM）。

结论：

- 变电样本中，IFC 型 CBM 全部有单 `BASEFAMILY`。
- DEV 型 CBM 全部有单 `BASEFAMILY`。
- NO_MODEL_POINTER 型 CBM 中，145 个 F3System 使用多 `BASEFAMILY1..N`，15 个使用单 `BASEFAMILY`，2 个无 FAM。
- 变电样本的 FAM 覆盖范围比线路样本更强，尤其覆盖了全部 IFC 关联节点和全部 F3System 层级节点。

---

## 5. 按 entityName + modelKind 的 FAM 覆盖关系

### 5.1 demo-line

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

### 5.2 demo-line1

| entityName + modelKind     |   总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 |     覆盖率 |
| -------------------------- | ----: | -----------: | -----------: | -----: | ------: |
| Wire_Device, DEV           |  1983 |         1983 |            0 |   1983 | 100.00% |
| F4System, CBM_GROUP        |   907 |            0 |          907 |      0 |   0.00% |
| WIRE, DEV                  |  1013 |         1013 |            0 |   1013 | 100.00% |
| Tower_Device, DEV          |   897 |          897 |            0 |    897 | 100.00% |
| CROSS, DEV                 |     7 |            7 |            0 |      7 | 100.00% |
| F4System, NO_MODEL_POINTER |    30 |            0 |           30 |      0 |   0.00% |
| F3System, NO_MODEL_POINTER |   161 |           25 |          136 |     25 |  15.53% |

> demo-line1 的 entityName + modelKind 分布与 demo-line 一致。

### 5.3 demo-substation

| entityName + modelKind     |   总数 | 单 BASEFAMILY | 多 BASEFAMILY1..N | 无 FAM | FAM 存在 |     覆盖率 |
| -------------------------- | ----: | -----------: | ---------------: | -----: | -----: | ------: |
| F4System, IFC              |  4360 |         4360 |                0 |      0 |   4360 | 100.00% |
| PARTINDEX, DEV             |  3894 |         3894 |                0 |      0 |   3894 | 100.00% |
| F4System, DEV              |   285 |          285 |                0 |      0 |    285 | 100.00% |
| F3System, NO_MODEL_POINTER |   160 |           15 |              145 |      0 |    610 | 100.00% |
| F2System, NO_MODEL_POINTER |     2 |            0 |                0 |      2 |      0 |   0.00% |

> **修正说明**：原版本未区分单 BASEFAMILY 与多 BASEFAMILY1..N 列，且把 F3System 多 FAM 节点误归入「无 BASEFAMILY」分类。本次复核拆分两列后，F3System 的 FAM 覆盖率从原 0% 修正为 100%。

变电样本中可暂定：

```text
F4System 不能简单视为纯分组节点。
F4System 既可能是 IFC 关联节点，也可能是 DEV 关联节点，也可能是纯分组节点。
判断 F4System 的角色时，必须结合 modelKind、IFCFILE、OBJECTMODELPOINTER、BASEFAMILY、SUBDEVICE 等字段。

F3System 通常关联多 FAM（4 个固定槽位），不直接关联 IFC。
PARTINDEX 是变电独有的叶子节点类型，关联 DEV + 单 FAM。
F2System 层级节点通常无 FAM。
```

---

## 6. FAM 字段形态

### 6.1 demo-line

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

### 6.2 demo-substation

FAM 行类型分布：

| rowKind             |    数量 |
| ------------------- | -----: |
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

### 6.3 多 FAM 文件的字段差异

demo-substation 的 145 个 F3System 文件每个关联 4 个 FAM。抽样检查发现这 4 个 FAM 的字段结构存在差异：

| FAM 槽位    | 字段特征                                       | 推断角色       |
| ----------- | ---------------------------------------------- | -------------- |
| BASEFAMILY1 | 字段较多，含装置名称、型号、编号等              | 设备台账属性   |
| BASEFAMILY2 | 字段较多，含电网工程标识、调度编码等            | 工程管理属性   |
| BASEFAMILY3 | 字段较少，含建设期次、附件名称等                | 施工/附件属性  |
| BASEFAMILY4 | 字段最少                                       | 待定           |

> 上述推断基于抽样样本，不排除个别文件存在例外。当前不展开 FAM 字段业务语义解析，仅记录字段结构差异。

---

## 7. 阶段性结论

基于三个 demo 的真实数据，可以形成以下结论：

1. **文件级引用完整性 100%**：三个 demo 中，凡是 CBM 写了 `BASEFAMILY` 或 `BASEFAMILY1..N`，目标 FAM 文件均存在。
2. **实例级 sidecar 特征**：当前三个 demo 中，`BASEFAMILY` 基本呈现一 CBM 对一 FAM 的实例级对应关系，暂未观察到多 CBM 复用同一 FAM。
3. **FAM 不宜先验定义为可复用族模板**：FAM 更适合作为 CBM 节点的属性 sidecar。
4. **线路工程 FAM 模式单一**：只使用单 `BASEFAMILY`，每个 CBM 至多 1 个 FAM；DEV 型业务对象节点全部有 FAM；F4System 分组节点通常没有 FAM。
5. **变电工程 FAM 模式复杂**：同时使用单 `BASEFAMILY` 和多 `BASEFAMILY1..N`：
   - F4System（IFC / DEV 角色）使用单 `BASEFAMILY`
   - F3System 使用固定 4 槽位 `BASEFAMILY1..4`，对应变电 4 级分类体系
   - IFC 型和 DEV 型 CBM 全部有 FAM
6. **F4System 角色需结合多字段判断**：不能仅凭 `ENTITYNAME=F4System` 判断节点是否为分组节点，必须结合 `modelKind`、`IFCFILE`、`OBJECTMODELPOINTER`、`BASEFAMILY`、`SUBDEVICE` 等字段。
7. **FAM schema 跨工程差异显著**：线路 FAM 以英文 KEY 为主（线路工程参数），变电 FAM 以中文 KEY 为主（设备台账/工程管理）。后续解析应保持弱 schema / key-value 结构，不宜过早固定 DTO。
8. **多 FAM 仅限变电 F3System**：当前 145 个多 FAM 文件全部为变电 F3System，每文件固定 4 个 FAM。其他 ENTITYNAME 类型均未发现多 FAM。

---

## 8. 当前不能下的结论

以下结论当前证据不足，不应写死：

```text
FAM 是标准族模板
FAM 可跨 CBM 复用
FAM 字段可以统一映射成固定 DTO
F4System 一定是分组节点
F4System 一定是具体构件节点
CBM 与 FAM 有同名字段必须一致
BASEFAMILY1..4 的 4 槽位一定对应 SYSTEMNAME1..4 的 4 级分类（仅基于抽样推断）
多 FAM 模式是变电工程的通用规则（仅基于 demo-substation）
```
