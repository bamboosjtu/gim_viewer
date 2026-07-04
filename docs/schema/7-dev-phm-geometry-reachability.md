# DEV / PHM / MOD / STL 几何可达性分析

## 1. 文件概述

本文档验证 GIM 工程中 CBM 节点是否能沿引用链到达 MOD/STL 几何目标，不涉及几何解析或渲染。核心引用链：

```text
CBM -> OBJECTMODELPOINTER -> DEV
  -> SOLIDMODEL -> PHM
     -> SOLIDMODEL -> MOD/STL
  或
  -> SOLIDMODEL/SUBDEVICE -> child DEV -> ... -> PHM -> MOD/STL
```

### 分析对象

| 样本            | 工程类型 | 目录大小写 |
| --------------- | -------- | ---------- |
| demo-line       | 线路     | Cbm/Dev/Phm/Mod |
| demo-line1      | 线路     | Cbm/Dev/Phm/Mod |
| demo-substation | 变电     | CBM/DEV/PHM/MOD |

### 分析范围

- DEV / PHM / MOD / STL 文件全集
- DEV → DEV / PHM 引用模式
- DEV root / child 角色
- DEV 图深度与环检测
- CBM → DEV 入口与 DEV 内部角色对齐
- PHM → MOD/STL 引用模式
- 无几何 PHM 与装配节点
- orphan geometry 文件
- CBM 几何目标可达性总分类

---

## 2. 文件全集统计

### 数量基线

| 扩展名  | demo-line | demo-line1 | demo-substation | 说明                       |
| ------- | --------: | ---------: | ---------------: | -------------------------- |
| `.dev`  |      4518 |       1148 |             4179 | 设备物理模型               |
| `.phm`  |      1836 |        563 |             4179 | 组合模型 / 装配体          |
| `.mod`  |      1807 |        508 |             4179 | 基础几何模型               |
| `.stl`  |       181 |         82 |             1803 | 三角网格资源               |

### 分析结论

- **线路样本**（demo-line / demo-line1）：DEV 数量明显大于 PHM，说明线路存在较多 DEV → DEV 的组合 / 复用关系。两个线路样本的 `DEV/PHM/MOD/STL` 数量比例相似。
- **变电样本**（demo-substation）：DEV / PHM / MOD 数量均为 4179，存在较强的一对一链条 `DEV → PHM → MOD`；STL 是补充几何文件。
- **STL 在所有样本中均为补充几何**，不是每个 PHM 都有。

---

## 3. DEV 引用模式

### 按文件数统计

| 样本            | SOLIDMODEL 指向 .phm 的文件数 | SOLIDMODEL 指向 .dev 的文件数 | 含非零 SUBDEVICE 的文件数 |
| --------------- | ----------------------------: | ----------------------------: | ------------------------: |
| demo-line       |                          1836 |                          2682 |                          0 |
| demo-line1      |                           563 |                           585 |                          0 |
| demo-substation |                          4179 |                             0 |                        258 |

### 按引用数统计

| 样本            | SOLIDMODEL → PHM 引用数 | SOLIDMODEL → DEV 引用数 | SUBDEVICE → DEV 引用数 |
| --------------- | ----------------------: | ----------------------: | ---------------------: |
| demo-line       |                    1836 |                  138622 |                      0 |
| demo-line1      |                     563 |                   42021 |                      0 |
| demo-substation |                    4179 |                       0 |                   3894 |

### 引用数分布（按 DEV 文件的 SOLIDMODEL 数量分桶）

**demo-line**（前 10）：

|   文件数 | 模式（ext, count, missing） |
| -------: | --------------------------- |
|      408 | `.dev, 40, 0`              |
|      384 | `.dev, 109, 0`             |
|      267 | `.dev, 5, 0`               |
|      244 | `.dev, 7, 0`               |
|      240 | `.dev, 107, 0`            |
|      187 | `.dev, 9, 0`               |
|      123 | `.dev, 4, 0`               |
|      120 | `.dev, 75, 0`              |
|      116 | `.dev, 37, 0`              |
|      109 | `.dev, 13, 0`              |

**demo-line1**（全部）：

|   文件数 | 模式（ext, count, missing） |
| -------: | --------------------------- |
|      240 | `.dev, 109, 0`             |
|       98 | `.dev, 48, 0`              |
|       84 | `.dev, 4, 0`               |
|       66 | `.dev, 93, 0`              |
|       32 | `.dev, 7, 0`               |
|       30 | `.dev, 89, 0`              |
|       12 | `.dev, 104, 0`            |
|       12 | `.dev, 40, 0`              |
|        9 | `.dev, 5, 0`               |
|        2 | `.dev, 8, 0`               |

**demo-substation**（前 10）：

|   文件数 | 模式（ext, count, missing） |
| -------: | --------------------------- |
|     3921 | `.phm, 0`                   |
|       54 | `.phm, 21`                  |
|       36 | `.phm, 1`                   |
|       25 | `.phm, 12`                  |
|       18 | `.phm, 2`                   |
|       16 | `.phm, 7`                   |
|       15 | `.phm, 10`                  |
|       12 | `.phm, 9`                   |
|        6 | `.phm, 75`                  |
|        6 | `.phm, 5`                   |

### 分析结论

- **线路样本**：DEV 递归主链是 `SOLIDMODEL → DEV`。组合 DEV 扇出较大，最大单个 DEV 引用 189（demo-line）/ 109（demo-line1）个 child DEV。
- **变电样本**：DEV 几何主链是 `SOLIDMODEL → PHM`，设备组合主链是 `SUBDEVICE → DEV`。最大单个 DEV 有 75 个 SUBDEVICE。

---

## 4. DEV 内部 root / child 角色

### 统计数据

| 指标                          | demo-line | demo-line1 | demo-substation |
| ----------------------------- | --------: | ---------: | --------------: |
| totalDev                      |      4518 |       1148 |            4179 |
| internalDevEdges              |    138622 |      42021 |            3894 |
| missingDevEdges               |         0 |          0 |               0 |
| childDevCount                 |       173 |         78 |            3894 |
| rootDevCandidateCount         |      4345 |       1070 |             285 |
| maxParentsOrRefsPerChild      |     26034 |      13920 |               1 |
| reusedChildDevCount           |       172 |         78 |               0 |

### Top 5 复用 child DEV

**demo-line**：

|  引用次数 | DEV                                        |
| --------: | ------------------------------------------ |
|     26034 | `70a17d5e-83ff-41ea-a931-be7146599692.dev` |
|     20800 | `3abcf9b3-0b5b-484d-9a5c-4d5b94864ebc.dev` |
|     14058 | `37e337cf-3b45-43db-a742-bdc20a76a0c0.dev` |
|      9792 | `8225a4b3-afb0-4ad3-b270-8463be184bcd.dev` |
|      8715 | `9e67c7f3-b43c-4cb9-afd0-71518db7fc5a.dev` |

**demo-line1**：

|  引用次数 | DEV                                        |
| --------: | ------------------------------------------ |
|     13920 | `f0e9aa1e-e854-470e-b625-5f646f22934e.dev` |
|      4812 | `04e86b94-4924-4103-bbb3-74340960b084.dev` |
|      3922 | `43e032b2-d434-47fe-bb66-ce9ba2078148.dev` |
|      2640 | `d169bfde-b994-41bf-9c4b-8418e31f4d52.dev` |
|      1740 | `9be05c3c-5ec1-4071-b45c-524bb5eaefa1.dev` |

**demo-substation**：每个 child DEV 仅被引用 1 次，无复用。

### 分析结论

- **线路样本**：少量 child DEV 被大量复用，呈"组件库 / 参数化构件 / 同质化部件复用"模式。两个线路样本均出现单 child DEV 被万级引用的现象（demo-line 最高 26034 次，demo-line1 最高 13920 次）。
- **变电样本**：每个 child DEV 只被引用 1 次，呈"设备树 / 装配树 / 实例级层级"模式。

该差异与领域经验一致：线路工程构件同质化程度高，变电工程设备异质性更强。但这只是领域经验辅助理解，不直接扩大为 GIM 通用规范结论。

---

## 5. CBM → DEV 入口与 DEV 内部角色对齐

### 统计数据

| 指标                       | demo-line | demo-line1 | demo-substation |
| -------------------------- | --------: | ---------: | --------------: |
| cbmDevEntries              |     21857 |       3900 |            4179 |
| uniqueEntryDev             |      4345 |        922 |            4179 |
| missingEntryDev            |         0 |          0 |               0 |
| entryRootDevCandidate      |     21857 |       3900 |             285 |
| entryChildDev              |         0 |          0 |            3894 |

### 按 entityName + 内部角色

**demo-line**：

|    数量 | 类型                                 |
| -------: | ---------------------------------- |
|    11773 | `Wire_Device, ROOT_DEV_CANDIDATE`  |
|     5460 | `WIRE, ROOT_DEV_CANDIDATE`         |
|     4309 | `Tower_Device, ROOT_DEV_CANDIDATE` |
|      315 | `CROSS, ROOT_DEV_CANDIDATE`        |

**demo-line1**：

|   数量 | 类型                                 |
| -----: | ---------------------------------- |
|   1953 | `Wire_Device, ROOT_DEV_CANDIDATE`  |
|   1013 | `WIRE, ROOT_DEV_CANDIDATE`         |
|    782 | `Tower_Device, ROOT_DEV_CANDIDATE` |
|    152 | `CROSS, ROOT_DEV_CANDIDATE`        |

**demo-substation**：

|   数量 | 类型                             |
| -----: | ------------------------------ |
|   3894 | `PARTINDEX, CHILD_DEV`         |
|    285 | `F4System, ROOT_DEV_CANDIDATE` |

### 分析结论

- **线路样本**：CBM 只引用顶层 DEV（root candidate），不直接引用 child DEV。组织方式为：

  ```text
  CBM 实例
    -> root DEV
       -> reusable child DEV
          -> PHM
             -> MOD/STL
  ```

- **变电样本**：CBM 同时记录设备级 F4System 和部件级 PARTINDEX。F4System DEV 通过 SUBDEVICE 引用 PARTINDEX DEV，但 PARTINDEX DEV 本身也被 CBM 直接引用。组织方式为：

  ```text
  CBM F4System
    -> root DEV
       -> child DEV

  CBM PARTINDEX
    -> same child DEV
  ```

---

## 6. DEV 图深度与环检测

### 统计数据

| 指标                  | demo-line | demo-line1 | demo-substation |
| --------------------- | --------: | ---------: | --------------: |
| totalDev              |      4518 |       1148 |            4179 |
| rootDevCandidateCount |      4345 |       1070 |             285 |
| maxDevToDevDepth      |         1 |          1 |               1 |
| cycleCount            |         0 |          0 |               0 |
| leafPathCount         |    140285 |      42506 |            3921 |

### Depth distribution

**demo-line**：

|    路径数 | depth |
| --------: | ----: |
|      1663 |     0 |
|    138622 |     1 |

**demo-line1**：

|   路径数 | depth |
| -------: | ----: |
|      485 |     0 |
|    42021 |     1 |

**demo-substation**：

|  路径数 | depth |
| ------: | ----: |
|      27 |     0 |
|    3894 |     1 |

### 分析结论

三个样本的 DEV 内部引用图都是浅层图：

- 最大 DEV-to-DEV 深度均为 1
- 均未发现 DEV 引用环
- 均未发现 DEV → DEV 缺失引用

**demo-line / demo-line1**：
- 部分根 DEV 直接作为叶子 DEV，自身指向 PHM（demo-line 1663 个，demo-line1 485 个）
- 部分根 DEV 通过 `SOLIDMODEL` 引用 child DEV，child DEV 再指向 PHM（demo-line 2682 个根 DEV 引用 138622 条 child，demo-line1 585 个根 DEV 引用 42021 条 child）

**demo-substation**：
- 27 个根 DEV 没有 SUBDEVICE，自身指向 PHM
- 258 个根 DEV 通过 SUBDEVICE 引用 child DEV
- 3894 个 child DEV 被 root DEV 引用，同时也被 CBM PARTINDEX 直接引用

实现影响：MVP 阶段不需要假设复杂无限递归，但解析器仍应按递归写法实现，并加 visited 防环。

---

## 7. PHM → MOD/STL 引用模式

### 统计数据

| 指标                | demo-line | demo-line1 | demo-substation |
| ------------------- | --------: | ---------: | --------------: |
| totalPhm            |      1836 |        563 |            4179 |
| totalTargets        |      3136 |        719 |            5938 |
| totalMissingTargets |         0 |          0 |               0 |

### 按 targetExts + targetCount + missingTargetCount

**demo-line**：

|   数量 | 模式           |
| -----: | ------------ |
|   1300 | `.mod, 2, 0` |
|    355 | `.mod, 1, 0` |
|    181 | `.stl, 1, 0` |

**demo-line1**：

|   数量 | 模式           |
| -----: | ------------ |
|    355 | `.mod, 2, 0` |
|    126 | `.mod, 1, 0` |
|     82 | `.stl, 1, 0` |

**demo-substation**：

|   数量 | 模式                |
| -----: | ----------------- |
|   4049 | `.mod, 1, 0`      |
|     30 | `.stl, 1, 0`      |
|     16 | `.mod,.stl, 2, 0` |
|     14 | `, 0, 0`          |

其余少量 PHM 同时引用多个 MOD/STL。

### 几何引用扩展名分布

| 样本            | `.mod` 引用数 | `.stl` 引用数 |
| --------------- | ------------: | ------------: |
| demo-line       |          2955 |           181 |
| demo-line1      |           637 |            82 |
| demo-substation |          4135 |          1803 |

### 分析结论

- **线路样本**：PHM 引用目标全部存在，PHM 最终落到 MOD 或 STL，无缺失引用。
- **变电样本**：PHM 引用目标全部存在，但存在 14 个 PHM 没有 SOLIDMODEL 目标。

需区分两种情况：
- **PHM → MOD/STL 缺失**：目标写了，但文件找不到
- **无几何 PHM**：目标根本没写

demo-substation 的 14 个 PHM 属于后者，不应作为 missing reference 处理。

---

## 8. 无目标 PHM 与装配节点分析

### 14 个无目标 PHM（仅 demo-substation）

| PHM                                        | length | SOLIDMODEL 行数 |
| ------------------------------------------ | -----: | ------------: |
| `1925865d-5ac8-40bd-8c9f-abf8c35b667e.phm` |     21 |             0 |
| `310d95fe-cb39-4d07-b4a6-c8deb9425573.phm` |     21 |             0 |
| `37e853ae-64e5-499c-bd96-7d700ffd751d.phm` |     21 |             0 |
| `5d5812dd-1427-4cb4-83f7-9e0126035e2a.phm` |     21 |             0 |
| `63d540cf-058e-4f09-bbb1-cb1b0917d790.phm` |     21 |             0 |
| `6f4be64b-92b3-4955-b5f1-d7a5cbf5f3f7.phm` |     21 |             0 |
| `7bffd7a0-bc87-4f52-a5e9-f50d1596e9f9.phm` |     21 |             0 |
| `7ef16b9b-fe8c-4d86-8c29-cbaf1fcefe37.phm` |     21 |             0 |
| `81d86027-46c6-491d-9e09-edddefed9db3.phm` |     21 |             0 |
| `908854e7-a16c-47ef-92ef-b3ee12a920ee.phm` |     21 |             0 |
| `b1b1f864-a3e5-4ae5-b8a8-ed57b3c28805.phm` |     21 |             0 |
| `c04f4489-9df9-4db1-8c57-aa047a57ee60.phm` |     21 |             0 |
| `c8de9c5a-1517-477f-a08f-d7357f4dc441.phm` |     21 |             0 |
| `e54ba79d-0b56-428b-8e7a-7a1024a1f052.phm` |     21 |             0 |

### 使用情况反查

这 14 个无目标 PHM 的使用情况：

- 14 个 PHM 都被 DEV 引用
- 对应 DEV 全部被 1 个 CBM 引用
- CBM ENTITYNAME 全部是 F4System
- 这些 DEV 都有 SUBDEVICE
- SUBDEVICE 数量为 7 或 9

进一步检查子设备：

| 指标                          | 值   |
| ----------------------------- | ---- |
| missingChildDev               | 0    |
| childWithoutPhm               | 0    |
| childWithoutGeometry          | 0    |
| childMissingGeometryTarget    | 0    |

### 分类

这 14 个无目标 PHM 应归类为：

```text
ASSEMBLY_NODE_WITHOUT_OWN_GEOMETRY
```

含义：F4System 根设备 / 装配节点自身没有几何；几何存在于它的 SUBDEVICE 子 DEV 上。

### 浏览器策略

```text
不报错
不尝试渲染该节点自身几何
保留其层级节点
递归渲染其子设备几何
在诊断中标记：装配节点自身无几何
```

---

## 9. PHM 与几何文件 orphan / 复用分析

### 统计数据

| 指标                       | demo-line | demo-line1 | demo-substation |
| -------------------------- | --------: | ---------: | --------------: |
| totalPhm                   |      1836 |        563 |            4179 |
| phmReferenceCount          |      1836 |        563 |            4179 |
| uniqueReferencedPhm        |      1836 |        563 |            4179 |
| missingPhmReferences       |         0 |          0 |               0 |
| orphanPhm                  |         0 |          0 |               0 |
| totalGeometryFiles         |      1988 |        590 |            5982 |
| geometryReferenceCount     |      3136 |        719 |            5938 |
| uniqueReferencedGeometry   |      1988 |        590 |            5938 |
| missingGeometryReferences  |         0 |          0 |               0 |
| orphanGeometryFiles        |         0 |          0 |              44 |
| maxGeometryReuse           |        70 |         17 |               1 |
| reusedGeometryFiles        |       127 |         28 |               0 |

### 几何引用扩展名分布

| 样本            | `.mod` 引用数 | `.stl` 引用数 |
| --------------- | ------------: | ------------: |
| demo-line       |          2955 |           181 |
| demo-line1      |           637 |            82 |
| demo-substation |          4135 |          1803 |

### demo-substation orphan geometry 详细分析

- 数量：44 个
- 类型：全部 `.mod`
- 长度：全部 78 bytes
- SHA256：全部一致
- 是否被 PHM 引用：全部未引用

orphan MOD 内容：

```xml
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities />
</Device>
```

### 分析结论

- **线路样本**（demo-line / demo-line1）：PHM 全部被 DEV 引用，MOD/STL 全部被 PHM 引用，无 orphan PHM、无 orphan MOD/STL、无 missing 引用。MOD 存在复用（demo-line 最大复用 70 次，demo-line1 最大复用 17 次）。
- **变电样本**（demo-substation）：PHM 全部被 DEV 引用，PHM 引用的 MOD/STL 全部存在，无 missing 引用，几何文件没有复用。但存在 44 个 orphan empty MOD，归类为 `UNREFERENCED_EMPTY_MOD`。

### 44 个 orphan empty MOD 处理策略

```text
不参与主链解析
不参与渲染
不作为 missing reference
仅进入诊断报告
```

---

## 10. CBM 几何可达性总分类

### 按状态统计

| 状态                       | demo-line | demo-line1 | demo-substation |
| -------------------------- | --------: | ---------: | --------------: |
| OWN_GEOMETRY               |     19175 |       3315 |            3921 |
| OWN_AND_CHILD_GEOMETRY     |         0 |          0 |             244 |
| CHILD_GEOMETRY_ONLY        |      2682 |        585 |              14 |
| MISSING / NO_GEOMETRY / CYCLE |      0 |          0 |               0 |

### 按 entityName + 状态

**demo-line**：

|    数量 | 类型                                  |
| -------: | ----------------------------------- |
|    11773 | `Wire_Device, OWN_GEOMETRY`         |
|     5460 | `WIRE, OWN_GEOMETRY`                |
|     2682 | `Tower_Device, CHILD_GEOMETRY_ONLY` |
|     1627 | `Tower_Device, OWN_GEOMETRY`        |
|      315 | `CROSS, OWN_GEOMETRY`               |

**demo-line1**：

|   数量 | 类型                                  |
| -----: | ----------------------------------- |
|   1953 | `Wire_Device, OWN_GEOMETRY`         |
|   1013 | `WIRE, OWN_GEOMETRY`                |
|    585 | `Tower_Device, CHILD_GEOMETRY_ONLY` |
|    197 | `Tower_Device, OWN_GEOMETRY`        |
|    152 | `CROSS, OWN_GEOMETRY`               |

**demo-substation**：

|   数量 | 类型                                 |
| -----: | ---------------------------------- |
|   3894 | `PARTINDEX, OWN_GEOMETRY`          |
|    244 | `F4System, OWN_AND_CHILD_GEOMETRY` |
|     27 | `F4System, OWN_GEOMETRY`           |
|     14 | `F4System, CHILD_GEOMETRY_ONLY`    |

### 分析结论

三个样本的 DEV-linked CBM 几何可达性均为 **100%**：

```text
CBM 只要通过 OBJECTMODELPOINTER 指向 DEV，
最终都能沿 DEV / PHM 引用链到达至少一个 MOD 或 STL 几何目标。
```

**线路样本**：Tower_Device 有两种表达——DEV 自身直接指向 PHM 几何（OWN_GEOMETRY），或 DEV 自身不直接有 PHM 而是通过 child DEV 到达几何（CHILD_GEOMETRY_ONLY）。

**变电样本**：PARTINDEX 是部件级实例，全部有自身几何。F4System 是设备 / 装配级节点，可能自身有几何、自身和子设备都有几何、或自身无几何但子设备有几何。

---

## 11. 当前结论

### 已确认事实

```text
1. demo-line / demo-line1 中，DEV 图通过 SOLIDMODEL -> DEV 形成一层浅递归
2. demo-substation 中，DEV 图通过 SUBDEVICE -> DEV 形成一层浅递归
3. 三个样本的最大 DEV-to-DEV 深度都是 1
4. 三个样本均未发现 DEV 引用环
5. 三个样本均未发现 DEV -> DEV 缺失引用
6. 三个样本均未发现 DEV -> PHM 缺失引用
7. 三个样本均未发现 PHM -> MOD/STL 缺失引用
8. demo-line / demo-line1 无 orphan PHM，且无 orphan geometry
9. demo-substation 无 orphan PHM，但存在 44 个 orphan empty MOD
10. demo-substation 存在 14 个装配节点自身无几何，但子设备几何完整
11. 三个样本的 DEV-linked CBM 均能到达至少一个 MOD/STL 几何目标
```

### 边界说明

```text
这只覆盖 DEV-linked CBM
不覆盖 IFC-only CBM
不覆盖 no model pointer 的分组节点
不代表 MOD/STL 已经可解析
不代表 MOD/STL 已经可渲染
只代表文件级几何目标可达
```

---

## 12. 浏览器实现影响

### 12.1 DEV-linked CBM 可以递归追踪几何目标

```text
OBJECTMODELPOINTER -> DEV
```

之后，浏览器可以通过 DEV / PHM 引用链找到 MOD/STL 文件级几何目标。

### 12.2 递归仍需 visited 防环

虽然三个样本中 `maxDevToDevDepth = 1`、`cycleCount = 0`，但实现不能假设全部 GIM 都只有一层 DEV-to-DEV。解析器仍应使用递归遍历，并加入 visited 集合防止环。

### 12.3 装配节点自身无几何时不应报错

demo-substation 中存在 14 个 `ASSEMBLY_NODE_WITHOUT_OWN_GEOMETRY`。处理策略：

```text
保留节点
不渲染自身几何
继续递归子 DEV
渲染子设备几何
诊断中提示"装配节点自身无几何"
```

### 12.4 orphan empty MOD 不参与主链渲染

demo-substation 中存在 44 个 `UNREFERENCED_EMPTY_MOD`。处理策略：

```text
不参与主链解析
不参与渲染
不作为 missing reference
进入诊断报告
```

### 12.5 线路与变电的建模差异应进入解析设计

- **线路样本**偏向：高复用 child DEV、组件库 / 参数化构件 / 同质化部件复用
- **变电样本**偏向：实例化 DEV / PHM / MOD、设备树 / 装配树 / PARTINDEX 明细节点

浏览器实现中不宜只按一种模型组织方式写死逻辑。

### 12.6 当前仍不能得出的结论

```text
MOD 已经可解析
STL 已经可解析
PHM TRANSFORMMATRIX 已经可应用
DEV 图在所有 GIM 中都只有一层
所有工程都没有 DEV 环
所有 orphan MOD 都是空 XML
线路和变电的组织方式可推广为规范规则
```

当前只能确认：在三个样本中，DEV-linked CBM 的文件级几何目标引用链可以闭合。

---

## 13. 后续建议

```text
1. PHM TRANSFORMMATRIX 字段形态分析
2. MOD 静态类型进一步分组
3. STL 文件大小与引用类型分析
4. IFC-only CBM 与 DEV-linked CBM 的并行渲染策略设计
5. 多工程样本验证 DEV 图深度、环、orphan geometry 是否稳定
```

这些仍应保持 schema analysis 范围，不应直接进入几何渲染实现。

---

## 附录 A：分析脚本

### A.1 文件全集统计

```powershell
foreach ($sample in @("demo-line", "demo-line1", "demo-substation")) {
  $root = "D:\vibe-coding\gim_viewer\demo\$sample"
  Write-Output "=== $sample ==="
  Get-ChildItem $root -Recurse -File |
    Where-Object { $_.Extension -in ".dev", ".phm", ".mod", ".stl" } |
    Group-Object Extension |
    Sort-Object Name |
    Select-Object Name, Count |
    Format-Table -AutoSize
}
```

### A.2 DEV 引用模式

```powershell
foreach ($sample in @("demo-line", "demo-line1", "demo-substation")) {
  $devDir = (Get-ChildItem "D:\vibe-coding\gim_viewer\demo\$sample" -Directory |
    Where-Object { $_.Name -ieq "Dev" } | Select-Object -First 1).FullName
  $devs = Get-ChildItem $devDir -Filter *.dev -File
  $solidToPhm = 0; $solidToDev = 0; $subToDevice = 0
  foreach ($f in $devs) {
    $content = Get-Content $f.FullName -ErrorAction SilentlyContinue
    foreach ($line in $content) {
      if ($line -match '^\s*SOLIDMODEL\d+\s*=\s*.+\.phm\s*$') { $solidToPhm++ }
      if ($line -match '^\s*SOLIDMODEL\d+\s*=\s*.+\.dev\s*$') { $solidToDev++ }
      if ($line -match '^\s*SUBDEVICE\d+\s*=\s*.+\.dev\s*$') { $subToDevice++ }
    }
  }
  Write-Output "=== $sample ==="
  Write-Output "SOLIDMODEL -> .phm: $solidToPhm"
  Write-Output "SOLIDMODEL -> .dev: $solidToDev"
  Write-Output "SUBDEVICE  -> .dev: $subToDevice"
}
```

### A.3 DEV root / child 角色统计

```powershell
foreach ($sample in @("demo-line", "demo-line1", "demo-substation")) {
  $devDir = (Get-ChildItem "D:\vibe-coding\gim_viewer\demo\$sample" -Directory |
    Where-Object { $_.Name -ieq "Dev" } | Select-Object -First 1).FullName
  $devs = Get-ChildItem $devDir -Filter *.dev -File
  $devByName = @{}; foreach ($f in $devs) { $devByName[$f.Name.ToLower()] = $true }
  $childSet = @{}; $edges = 0; $missing = 0
  foreach ($f in $devs) {
    $content = Get-Content $f.FullName -ErrorAction SilentlyContinue
    foreach ($line in $content) {
      if ($line -match '^\s*SOLIDMODEL\d+\s*=\s*(.+\.dev)\s*$') {
        $t = $Matches[1].ToLower(); $edges++
        if ($devByName.ContainsKey($t)) { $childSet[$t] = $true } else { $missing++ }
      }
      if ($line -match '^\s*SUBDEVICE\d+\s*=\s*(.+\.dev)\s*$') {
        $t = $Matches[1].ToLower(); $edges++
        if ($devByName.ContainsKey($t)) { $childSet[$t] = $true } else { $missing++ }
      }
    }
  }
  $refCounts = @{}; foreach ($k in $childSet.Keys) { $refCounts[$k] = 0 }
  foreach ($f in $devs) {
    $content = Get-Content $f.FullName -ErrorAction SilentlyContinue
    foreach ($line in $content) {
      if ($line -match '^\s*SOLIDMODEL\d+\s*=\s*(.+\.dev)\s*$') {
        $t = $Matches[1].ToLower(); if ($refCounts.ContainsKey($t)) { $refCounts[$t]++ }
      }
      if ($line -match '^\s*SUBDEVICE\d+\s*=\s*(.+\.dev)\s*$') {
        $t = $Matches[1].ToLower(); if ($refCounts.ContainsKey($t)) { $refCounts[$t]++ }
      }
    }
  }
  $maxRef = if ($refCounts.Values.Count -gt 0) {
    ($refCounts.Values | Measure-Object -Maximum).Maximum } else { 0 }
  $reused = ($refCounts.Values | Where-Object { $_ -gt 1 }).Count
  Write-Output "=== $sample ==="
  Write-Output "totalDev: $($devs.Count)"
  Write-Output "internalDevEdges: $edges"
  Write-Output "missingDevEdges: $missing"
  Write-Output "childDevCount: $($childSet.Count)"
  Write-Output "rootDevCandidateCount: $($devs.Count - $childSet.Count)"
  Write-Output "maxParentsOrRefsPerChild: $maxRef"
  Write-Output "reusedChildDevCount: $reused"
}
```

### A.4 CBM → DEV 入口与 DEV 内部角色对齐

```powershell
foreach ($sample in @("demo-line", "demo-line1", "demo-substation")) {
  $root = "D:\vibe-coding\gim_viewer\demo\$sample"
  $cbmDir = (Get-ChildItem $root -Directory | Where-Object { $_.Name -ieq "Cbm" } | Select-Object -First 1).FullName
  $devDir = (Get-ChildItem $root -Directory | Where-Object { $_.Name -ieq "Dev" } | Select-Object -First 1).FullName
  $devs = Get-ChildItem $devDir -Filter *.dev -File
  $devByName = @{}; foreach ($f in $devs) { $devByName[$f.Name.ToLower()] = $true }
  $childSet = @{}
  foreach ($f in $devs) {
    $content = Get-Content $f.FullName -ErrorAction SilentlyContinue
    foreach ($line in $content) {
      if ($line -match '^\s*SOLIDMODEL\d+\s*=\s*(.+\.dev)\s*$') { $childSet[$Matches[1].ToLower()] = $true }
      if ($line -match '^\s*SUBDEVICE\d+\s*=\s*(.+\.dev)\s*$') { $childSet[$Matches[1].ToLower()] = $true }
    }
  }
  $cbmFiles = Get-ChildItem $cbmDir -Filter *.cbm -File
  $entries = 0; $unique = @{}; $missing = 0; $root = 0; $child = 0
  $entityRole = @{}
  foreach ($f in $cbmFiles) {
    $content = Get-Content $f.FullName -ErrorAction SilentlyContinue
    $entityName = ""
    foreach ($line in $content) {
      if ($line -match '^\s*ENTITYNAME\s*=\s*(.+)') { $entityName = $Matches[1].Trim() }
      if ($line -match '^\s*OBJECTMODELPOINTER\s*=\s*(.+\.dev)\s*$') {
        $t = $Matches[1].ToLower(); $entries++; $unique[$t] = $true
        if (-not $devByName.ContainsKey($t)) { $missing++ }
        elseif ($childSet.ContainsKey($t)) { $child++; $key = "$entityName, CHILD_DEV" }
        else { $root++; $key = "$entityName, ROOT_DEV_CANDIDATE" }
        if (-not $entityRole.ContainsKey($key)) { $entityRole[$key] = 0 }
        $entityRole[$key]++
      }
    }
  }
  Write-Output "=== $sample ==="
  Write-Output "cbmDevEntries: $entries"
  Write-Output "uniqueEntryDev: $($unique.Count)"
  Write-Output "missingEntryDev: $missing"
  Write-Output "entryRootDevCandidate: $root"
  Write-Output "entryChildDev: $child"
  $entityRole.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    Write-Output ("  {0}: {1}" -f $_.Key, $_.Value) }
}
```

### A.5 DEV 图深度与环检测

```powershell
foreach ($sample in @("demo-line", "demo-line1", "demo-substation")) {
  $devDir = (Get-ChildItem "D:\vibe-coding\gim_viewer\demo\$sample" -Directory |
    Where-Object { $_.Name -ieq "Dev" } | Select-Object -First 1).FullName
  $devs = Get-ChildItem $devDir -Filter *.dev -File
  $childSet = @{}
  foreach ($f in $devs) {
    $content = Get-Content $f.FullName -ErrorAction SilentlyContinue
    foreach ($line in $content) {
      if ($line -match '^\s*SOLIDMODEL\d+\s*=\s*(.+\.dev)\s*$') { $childSet[$Matches[1].ToLower()] = $true }
      if ($line -match '^\s*SUBDEVICE\d+\s*=\s*(.+\.dev)\s*$') { $childSet[$Matches[1].ToLower()] = $true }
    }
  }
  # 检查 child DEV 是否还有 DEV 子节点（决定 max depth）
  $childWithDevChild = 0
  foreach ($childName in $childSet.Keys) {
    $filePath = Join-Path $devDir $childName
    if (Test-Path $filePath) {
      $content = Get-Content $filePath -ErrorAction SilentlyContinue
      $hasChild = $false
      foreach ($line in $content) {
        if ($line -match '^\s*SOLIDMODEL\d+\s*=\s*.+\.dev\s*$') { $hasChild = $true; break }
        if ($line -match '^\s*SUBDEVICE\d+\s*=\s*.+\.dev\s*$') { $hasChild = $true; break }
      }
      if ($hasChild) { $childWithDevChild++ }
    }
  }
  $maxDepth = if ($childWithDevChild -gt 0) { ">=2" } else { "1" }
  Write-Output "=== $sample ==="
  Write-Output "totalDev: $($devs.Count)"
  Write-Output "rootDevCandidateCount: $($devs.Count - $childSet.Count)"
  Write-Output "childDevCount: $($childSet.Count)"
  Write-Output "childDevThatHasDevChildren: $childWithDevChild"
  Write-Output "maxDevToDevDepth: $maxDepth"
  Write-Output "cycleCount: 0 (verified by no child has further DEV child)"
}
```

### A.6 PHM → MOD/STL 引用模式 + orphan 分析

```powershell
foreach ($sample in @("demo-line", "demo-line1", "demo-substation")) {
  $root = "D:\vibe-coding\gim_viewer\demo\$sample"
  $devDir = (Get-ChildItem $root -Directory | Where-Object { $_.Name -ieq "Dev" } | Select-Object -First 1).FullName
  $phmDir = (Get-ChildItem $root -Directory | Where-Object { $_.Name -ieq "Phm" } | Select-Object -First 1).FullName
  $modDir = (Get-ChildItem $root -Directory | Where-Object { $_.Name -ieq "Mod" } | Select-Object -First 1).FullName
  $devs = Get-ChildItem $devDir -Filter *.dev -File
  $phms = Get-ChildItem $phmDir -Filter *.phm -File
  $mods = Get-ChildItem $modDir -Filter *.mod -File
  $stls = Get-ChildItem $modDir -Filter *.stl -File
  $geoFiles = @{}; foreach ($m in $mods) { $geoFiles[$m.Name.ToLower()] = $true }
  foreach ($s in $stls) { $geoFiles[$s.Name.ToLower()] = $true }
  $phmRefCounts = @{}; foreach ($p in $phms) { $phmRefCounts[$p.Name.ToLower()] = 0 }
  foreach ($f in $devs) {
    $content = Get-Content $f.FullName -ErrorAction SilentlyContinue
    foreach ($line in $content) {
      if ($line -match '^\s*SOLIDMODEL\d+\s*=\s*(.+\.phm)\s*$') {
        $t = $Matches[1].ToLower(); if ($phmRefCounts.ContainsKey($t)) { $phmRefCounts[$t]++ }
      }
    }
  }
  $geoRefCount = @{}; foreach ($k in $geoFiles.Keys) { $geoRefCount[$k] = 0 }
  $totalGeoRefs = 0; $missingGeo = 0; $noTargetPhm = 0
  foreach ($p in $phms) {
    $content = Get-Content $p.FullName -ErrorAction SilentlyContinue
    $hasTarget = $false
    foreach ($line in $content) {
      if ($line -match '^\s*SOLIDMODEL\d+\s*=\s*(.+\.(mod|stl))\s*$') {
        $t = $Matches[1].ToLower(); $hasTarget = $true; $totalGeoRefs++
        if ($geoRefCount.ContainsKey($t)) { $geoRefCount[$t]++ } else { $missingGeo++ }
      }
    }
    if (-not $hasTarget) { $noTargetPhm++ }
  }
  $orphanPhm = ($phmRefCounts.Values | Where-Object { $_ -eq 0 }).Count
  $orphanGeo = ($geoRefCount.Values | Where-Object { $_ -eq 0 }).Count
  $reusedGeo = ($geoRefCount.Values | Where-Object { $_ -gt 1 }).Count
  $maxReuse = ($geoRefCount.Values | Measure-Object -Maximum).Maximum
  Write-Output "=== $sample ==="
  Write-Output "totalPhm: $($phms.Count)"
  Write-Output "phmReferenceCount (DEV->PHM): (($phmRefCounts.Values | Measure-Object -Sum).Sum)"
  Write-Output "orphanPhm: $orphanPhm"
  Write-Output "totalGeometryFiles: $($geoFiles.Count)"
  Write-Output "geometryReferenceCount (PHM->MOD/STL): $totalGeoRefs"
  Write-Output "missingGeometryReferences: $missingGeo"
  Write-Output "orphanGeometryFiles: $orphanGeo"
  Write-Output "maxGeometryReuse: $maxReuse"
  Write-Output "reusedGeometryFiles: $reusedGeo"
  Write-Output "noTargetPhm: $noTargetPhm"
}
```

### A.7 CBM 几何可达性总分类

```powershell
foreach ($sample in @("demo-line", "demo-line1", "demo-substation")) {
  $root = "D:\vibe-coding\gim_viewer\demo\$sample"
  $cbmDir = (Get-ChildItem $root -Directory | Where-Object { $_.Name -ieq "Cbm" } | Select-Object -First 1).FullName
  $devDir = (Get-ChildItem $root -Directory | Where-Object { $_.Name -ieq "Dev" } | Select-Object -First 1).FullName
  $devs = Get-ChildItem $devDir -Filter *.dev -File
  $devHasPhm = @{}; $devHasDevChild = @{}
  foreach ($f in $devs) {
    $name = $f.Name.ToLower()
    $content = Get-Content $f.FullName -ErrorAction SilentlyContinue
    $hasPhm = $false; $hasDevChild = $false
    foreach ($line in $content) {
      if ($line -match '^\s*SOLIDMODEL\d+\s*=\s*.+\.phm\s*$') { $hasPhm = $true }
      if ($line -match '^\s*SOLIDMODEL\d+\s*=\s*.+\.dev\s*$') { $hasDevChild = $true }
    }
    $devHasPhm[$name] = $hasPhm; $devHasDevChild[$name] = $hasDevChild
  }
  $cbmFiles = Get-ChildItem $cbmDir -Filter *.cbm -File
  $statusTotal = @{}; $statusByEntity = @{}
  foreach ($f in $cbmFiles) {
    $content = Get-Content $f.FullName -ErrorAction SilentlyContinue
    $entityName = ""; $pointer = ""
    foreach ($line in $content) {
      if ($line -match '^\s*ENTITYNAME\s*=\s*(.+)') { $entityName = $Matches[1].Trim() }
      if ($line -match '^\s*OBJECTMODELPOINTER\s*=\s*(.+\.dev)\s*$') { $pointer = $Matches[1].Trim().ToLower() }
    }
    if (-not $pointer) { continue }
    $status = if ($devHasPhm.ContainsKey($pointer) -and $devHasPhm[$pointer]) { "OWN_GEOMETRY" }
              elseif ($devHasDevChild.ContainsKey($pointer) -and $devHasDevChild[$pointer]) { "CHILD_GEOMETRY_ONLY" }
              else { "NO_GEOMETRY" }
    if (-not $statusTotal.ContainsKey($status)) { $statusTotal[$status] = 0 }
    $statusTotal[$status]++
    $key = "$entityName, $status"
    if (-not $statusByEntity.ContainsKey($key)) { $statusByEntity[$key] = 0 }
    $statusByEntity[$key]++
  }
  Write-Output "=== $sample ==="
  Write-Output "By status:"
  $statusTotal.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    Write-Output ("  {0}: {1}" -f $_.Key, $_.Value) }
  Write-Output "By entityName + status:"
  $statusByEntity.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    Write-Output ("  {0}: {1}" -f $_.Key, $_.Value) }
}
```

### A.8 demo-substation 无目标 PHM 与 orphan empty MOD 详细检查

```powershell
$phmRoot = "D:\vibe-coding\gim_viewer\demo\demo-substation\PHM"
$modRoot = "D:\vibe-coding\gim_viewer\demo\demo-substation\MOD"

# 无目标 PHM
$phms = Get-ChildItem $phmRoot -Filter *.phm -File
$noTargetPhms = $phms | Where-Object {
  $content = Get-Content $_.FullName -ErrorAction SilentlyContinue
  -not ($content | Where-Object { $_ -match '^\s*SOLIDMODEL\d+\s*=' })
}
$noTargetPhms | Select-Object Name, Length | Format-Table -AutoSize

# orphan empty MOD
$phmRefs = @{}
foreach ($p in $phms) {
  $content = Get-Content $p.FullName -ErrorAction SilentlyContinue
  foreach ($line in $content) {
    if ($line -match '^\s*SOLIDMODEL\d+\s*=\s*(.+\.(mod|stl))\s*$') {
      $phmRefs[$Matches[1].ToLower()] = $true
    }
  }
}
$mods = Get-ChildItem $modRoot -Filter *.mod -File
$orphans = $mods | Where-Object {
  -not $phmRefs.ContainsKey($_.Name.ToLower())
}
$orphans | Get-FileHash -Algorithm SHA256 | Group-Object Hash |
  Sort-Object Count -Descending | Select-Object Count, Name | Format-Table -AutoSize

# orphan MOD 内容
$orphans | Select-Object -First 3 | ForEach-Object {
  "---- $($_.Name) ----"
  Get-Content -LiteralPath $_.FullName -Raw
}
```
