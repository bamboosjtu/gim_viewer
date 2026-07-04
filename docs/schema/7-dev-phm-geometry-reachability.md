# Round 3：DEV / PHM / MOD / STL 几何可达性分析

目标：确认几何资源是否能从 CBM 实例一路走到 MOD/STL。

## 1. Round 3 定位

Round 3 的目标不是实现几何解析或渲染，而是在 Round 1 / Round 2 已确认文件级引用链和 IFC/FAM 基础关系后，继续验证：

```text
CBM -> DEV -> PHM -> MOD/STL
```

这条链路在当前两个 demo 中是否能形成稳定的、可遍历的文件级几何目标引用链。

当前分析对象：

```text
demo-line
demo-substation
```

当前分析范围：

```text
DEV 文件全集
DEV -> DEV / PHM 引用模式
DEV root / child 角色
DEV 图深度与环检测
CBM -> DEV 入口角色
PHM -> MOD/STL 引用模式
无几何 PHM
装配节点自身无几何但子设备有几何
orphan geometry 文件
CBM 几何目标可达性总分类
```

当前不做：

```text
不改 src
不改 SQLite schema
不新增 UI
不实现 MOD 解析
不实现 STL 解析
不应用 TRANSFORMMATRIX
不做 3D 渲染
不做悬链线
不改变当前 MVP 行为
```

Round 3 的核心判断是：

```text
当前两个 demo 中，DEV-linked CBM 均能沿 DEV / PHM 引用链到达至少一个 MOD 或 STL 几何目标。
但这只证明文件级几何目标可达，不代表 MOD/STL 已经完成语义解析或可渲染。
```

---

## 2. Round 3 总体计划

Round 3 按以下阶段推进：

| 阶段        | 目标                                  | 产出                            |
| --------- | ----------------------------------- | ----------------------------- |
| Round 3.1 | 统计 DEV / PHM / MOD / STL 文件全集       | 文件数量基线                        |
| Round 3.2 | 分析 DEV 引用 PHM / DEV / SUBDEVICE 的模式 | DEV 引用模式                      |
| Round 3.3 | 判定 DEV 内部 root / child 角色           | root DEV 与 child DEV 对照       |
| Round 3.4 | 对齐 CBM -> DEV 入口与 DEV 内部角色          | CBM 入口角色分析                    |
| Round 3.5 | 检查 DEV 图深度与环                        | 最大深度、环检测                      |
| Round 3.6 | 分析 PHM -> MOD/STL 引用模式              | PHM 几何目标引用统计                  |
| Round 3.7 | 分析无目标 PHM 与装配节点                     | assembly without own geometry |
| Round 3.8 | 分析 orphan geometry 文件               | unreferenced geometry 文件分类    |
| Round 3.9 | 汇总 CBM 几何可达性                        | DEV-linked CBM 的几何可达性总分类      |

当前已完成到 Round 3.9。

---

## 3. Round 3 分析思路

Round 3 采用“从文件全集到用户入口”的方式推进。

整体顺序是：

```text
DEV / PHM / MOD / STL 文件全集
  -> DEV 引用模式
  -> DEV root / child 角色
  -> CBM -> DEV 入口角色
  -> DEV 图深度与环检测
  -> PHM -> MOD/STL 引用模式
  -> 无几何 PHM 解释
  -> orphan geometry 文件解释
  -> CBM 几何目标可达性总分类
```

之所以采用这个顺序，是因为浏览器最终面对的是 CBM 节点，但几何目标在下游：

```text
CBM
  -> OBJECTMODELPOINTER -> DEV
     -> SOLIDMODEL -> PHM
        -> SOLIDMODEL -> MOD/STL
```

或者：

```text
CBM
  -> OBJECTMODELPOINTER -> DEV
     -> SOLIDMODEL / SUBDEVICE -> child DEV
        -> SOLIDMODEL -> PHM
           -> SOLIDMODEL -> MOD/STL
```

因此必须先确认 DEV 图是否可遍历，再判断 CBM 入口是否能到达几何目标。

---

## 4. Step 1：DEV / PHM / MOD / STL 文件全集

### 4.1 目的

确认 Round 3 的分析对象范围，建立 DEV / PHM / MOD / STL 文件数量基线。

### 4.2 命令

```powershell
cd D:\vibe-coding\gim_viewer

Get-ChildItem ".\demo\demo-line" -Recurse -File |
  Where-Object { $_.Extension -in ".dev", ".phm", ".mod", ".stl" } |
  Group-Object Extension |
  Sort-Object Name |
  Select-Object Name, Count |
  Format-Table -AutoSize

Get-ChildItem ".\demo\demo-substation" -Recurse -File |
  Where-Object { $_.Extension -in ".dev", ".phm", ".mod", ".stl" } |
  Group-Object Extension |
  Sort-Object Name |
  Select-Object Name, Count |
  Format-Table -AutoSize
```

### 4.3 当前结果

demo-line：

| 扩展名    |   数量 |
| ------ | ---: |
| `.dev` | 4518 |
| `.phm` | 1836 |
| `.mod` | 1807 |
| `.stl` |  181 |

demo-substation：

| 扩展名    |   数量 |
| ------ | ---: |
| `.dev` | 4179 |
| `.phm` | 4179 |
| `.mod` | 4179 |
| `.stl` | 1803 |

### 4.4 分析结论

demo-line 中 DEV 数量明显大于 PHM，说明线路样本中存在较多 DEV -> DEV 的组合 / 复用关系。

demo-substation 中 DEV / PHM / MOD 数量均为 4179，说明变电样本大概率存在较强的一对一链条：

```text
DEV -> PHM -> MOD
```

STL 是补充几何文件，不是每个 PHM 都有。

---

## 5. Step 2：DEV 引用模式

### 5.1 目的

确认 DEV 文件内部到底通过 `SOLIDMODEL` 指向 PHM，还是指向其他 DEV；同时确认是否存在 `SUBDEVICE` 引用。

### 5.2 命令

```powershell
cd D:\vibe-coding\gim_viewer

Show-DevReferenceMode ".\demo\demo-line\Dev"
Show-DevReferenceMode ".\demo\demo-substation\DEV"
```

进一步统计引用数量：

```powershell
Show-DevReferenceCount ".\demo\demo-line\Dev"
Show-DevReferenceCount ".\demo\demo-substation\DEV"
```

### 5.3 当前结果

demo-line：

|   数量 | 引用模式      |
| ---: | --------- |
| 2682 | `.dev, 0` |
| 1836 | `.phm, 0` |

含义：

```text
2682 个 DEV 的 SOLIDMODEL 指向 .dev
1836 个 DEV 的 SOLIDMODEL 指向 .phm
所有 DEV 都没有 SUBDEVICE
```

demo-line 按引用数量统计：

|   数量 | 引用模式           |
| ---: | -------------- |
| 1836 | `.phm, 1, 0`   |
|  408 | `.dev, 40, 0`  |
|  384 | `.dev, 109, 0` |
|  267 | `.dev, 5, 0`   |
|  244 | `.dev, 7, 0`   |
|  240 | `.dev, 107, 0` |
|  187 | `.dev, 9, 0`   |
|  123 | `.dev, 4, 0`   |
|  120 | `.dev, 75, 0`  |
|  116 | `.dev, 37, 0`  |
|  109 | `.dev, 13, 0`  |
|  107 | `.dev, 77, 0`  |
|   91 | `.dev, 71, 0`  |
|   74 | `.dev, 70, 0`  |
|   58 | `.dev, 42, 0`  |
|   26 | `.dev, 76, 0`  |
|   24 | `.dev, 143, 0` |
|   21 | `.dev, 104, 0` |
|   18 | `.dev, 87, 0`  |
|   16 | `.dev, 1, 0`   |
|   16 | `.dev, 8, 0`   |
|   12 | `.dev, 101, 0` |
|    7 | `.dev, 81, 0`  |
|    7 | `.dev, 83, 0`  |
|    3 | `.dev, 139, 0` |
|    3 | `.dev, 85, 0`  |
|    1 | `.dev, 189, 0` |

demo-substation：

|   数量 | 引用模式       |
| ---: | ---------- |
| 3921 | `.phm, 0`  |
|   54 | `.phm, 21` |
|   36 | `.phm, 1`  |
|   25 | `.phm, 12` |
|   18 | `.phm, 2`  |
|   16 | `.phm, 7`  |
|   15 | `.phm, 10` |
|   12 | `.phm, 9`  |
|    6 | `.phm, 75` |
|    6 | `.phm, 5`  |
|    6 | `.phm, 14` |
|    6 | `.phm, 8`  |

含义：

```text
demo-substation 全部 DEV 的 SOLIDMODEL 都指向 .phm。
其中 3921 个 DEV 没有 SUBDEVICE。
其余 258 个 DEV 有 SUBDEVICE。
SUBDEVICE -> DEV 引用总数为 3894。
```

### 5.4 分析结论

线路样本：

```text
DEV 递归主链是 SOLIDMODEL -> DEV。
组合 DEV 的扇出较大，最大单个 DEV 引用 189 个 child DEV。
```

变电样本：

```text
DEV 几何主链是 SOLIDMODEL -> PHM。
设备组合主链是 SUBDEVICE -> DEV。
最大单个 DEV 有 75 个 SUBDEVICE。
```

---

## 6. Step 3：DEV 内部 root / child 角色

### 6.1 目的

区分哪些 DEV 是被其他 DEV 引用的 child DEV，哪些 DEV 是 DEV 内部图中的 root candidate。

这里的 root candidate 只表示：

```text
没有被其他 DEV 通过 SOLIDMODEL 或 SUBDEVICE 引用的 DEV。
```

它还不是最终 GIM 对象根节点。最终对象入口还需要结合：

```text
CBM -> OBJECTMODELPOINTER -> DEV
```

### 6.2 命令

```powershell
cd D:\vibe-coding\gim_viewer

Show-DevRootChildStats ".\demo\demo-line\Dev"
Show-DevRootChildStats ".\demo\demo-substation\DEV"
```

### 6.3 当前结果

demo-line：

```text
totalDev                 : 4518
internalDevEdges         : 138622
missingDevEdges          : 0
childDevCount            : 173
rootDevCandidateCount    : 4345
maxParentsOrRefsPerChild : 26034
reusedChildDevCount      : 172
```

Top reused child DEV：

|  引用次数 | DEV                                        |
| ----: | ------------------------------------------ |
| 26034 | `70a17d5e-83ff-41ea-a931-be7146599692.dev` |
| 20800 | `3abcf9b3-0b5b-484d-9a5c-4d5b94864ebc.dev` |
| 14058 | `37e337cf-3b45-43db-a742-bdc20a76a0c0.dev` |
|  9792 | `8225a4b3-afb0-4ad3-b270-8463be184bcd.dev` |
|  8715 | `9e67c7f3-b43c-4cb9-afd0-71518db7fc5a.dev` |

demo-substation：

```text
totalDev                 : 4179
internalDevEdges         : 3894
missingDevEdges          : 0
childDevCount            : 3894
rootDevCandidateCount    : 285
maxParentsOrRefsPerChild : 1
reusedChildDevCount      : 0
```

### 6.4 分析结论

demo-line：

```text
少量 child DEV 被大量复用。
这更像“组件库 / 参数化构件 / 同质化部件复用”模式。
```

demo-substation：

```text
每个 child DEV 只被引用 1 次。
这更像“设备树 / 装配树 / 实例级层级”模式。
```

当前两个 demo 的结果与领域经验一致：

```text
线路工程构件同质化程度较高，适合族 / 模板 / 参数化复用。
变电工程设备异质性更强，更接近实例级设备树。
```

但该解释只作为领域经验辅助理解，不能直接扩大为 GIM 通用规范结论。

---

## 7. Step 4：CBM -> DEV 入口与 DEV 内部角色对齐

### 7.1 目的

验证 CBM 指向的 DEV 是 DEV 内部 root candidate，还是 child DEV。

重点回答：

```text
CBM 引用了多少个 DEV？
CBM 引用的 DEV 是否存在？
CBM 是直接引用 root DEV，还是也会直接引用 child DEV？
线路中高复用 child DEV 是否被 CBM 直接引用？
变电中 F4System / PARTINDEX 分别对应什么 DEV 角色？
```

### 7.2 命令

```powershell
cd D:\vibe-coding\gim_viewer

Show-CbmDevEntryVsInternalRole ".\demo\demo-line" "Cbm" "Dev"
Show-CbmDevEntryVsInternalRole ".\demo\demo-substation" "CBM" "DEV"
```

### 7.3 当前结果

demo-line：

```text
cbmDevEntries         : 21857
uniqueEntryDev        : 4345
missingEntryDev       : 0
entryRootDevCandidate : 21857
entryChildDev         : 0
```

按 entityName + internal role：

|    数量 | 类型                                 |
| ----: | ---------------------------------- |
| 11773 | `Wire_Device, ROOT_DEV_CANDIDATE`  |
|  5460 | `WIRE, ROOT_DEV_CANDIDATE`         |
|  4309 | `Tower_Device, ROOT_DEV_CANDIDATE` |
|   315 | `CROSS, ROOT_DEV_CANDIDATE`        |

demo-substation：

```text
cbmDevEntries         : 4179
uniqueEntryDev        : 4179
missingEntryDev       : 0
entryRootDevCandidate : 285
entryChildDev         : 3894
```

按 entityName + internal role：

|   数量 | 类型                             |
| ---: | ------------------------------ |
| 3894 | `PARTINDEX, CHILD_DEV`         |
|  285 | `F4System, ROOT_DEV_CANDIDATE` |

### 7.4 分析结论

demo-line：

```text
CBM 只引用顶层 DEV。
DEV 内部再通过 SOLIDMODEL -> DEV 引用少量高复用 child DEV。
```

线路组织方式可以表示为：

```text
CBM 实例
  -> root DEV
     -> reusable child DEV
        -> PHM
           -> MOD/STL
```

demo-substation：

```text
CBM 同时记录设备级 F4System 和部件级 PARTINDEX。
F4System DEV 通过 SUBDEVICE 引用 PARTINDEX DEV。
但 PARTINDEX DEV 本身也被 CBM 直接引用。
```

变电组织方式可以表示为：

```text
CBM F4System
  -> root DEV
     -> child DEV

CBM PARTINDEX
  -> same child DEV
```

---

## 8. Step 5：DEV 图深度与环检测

### 8.1 目的

验证 DEV 内部图是否存在更深层递归或引用环。

重点回答：

```text
是否存在 DEV -> DEV -> DEV 更深层级？
是否存在 DEV 引用环？
当前两个 demo 的 DEV 图最大深度是多少？
```

### 8.2 命令

```powershell
cd D:\vibe-coding\gim_viewer

Show-DevGraphDepth ".\demo\demo-line\Dev"
Show-DevGraphDepth ".\demo\demo-substation\DEV"
```

### 8.3 当前结果

demo-line：

```text
totalDev              : 4518
rootDevCandidateCount : 4345
maxDevToDevDepth      : 1
cycleCount            : 0
leafPathCount         : 140285
```

Depth distribution：

|    路径数 | depth |
| -----: | ----: |
|   1663 |     0 |
| 138622 |     1 |

demo-substation：

```text
totalDev              : 4179
rootDevCandidateCount : 285
maxDevToDevDepth      : 1
cycleCount            : 0
leafPathCount         : 3921
```

Depth distribution：

|  路径数 | depth |
| ---: | ----: |
|   27 |     0 |
| 3894 |     1 |

### 8.4 分析结论

当前两个 demo 的 DEV 内部引用图都是浅层图：

```text
最大 DEV-to-DEV 深度 = 1
没有发现 DEV 引用环
没有发现 DEV-to-DEV 缺失引用
```

demo-line：

```text
1663 个 root DEV 直接作为叶子 DEV，自身指向 PHM。
2682 个 root DEV 通过 SOLIDMODEL 引用 child DEV，child DEV 再指向 PHM。
```

demo-substation：

```text
27 个 root DEV 没有 SUBDEVICE，自身指向 PHM。
258 个 root DEV 通过 SUBDEVICE 引用 child DEV。
3894 个 child DEV 被 root DEV 引用，同时也被 CBM PARTINDEX 直接引用。
```

实现影响：

```text
MVP 阶段不需要先假设复杂无限递归。
但解析器仍应按递归写法实现，并加 visited 防环。
```

---

## 9. Step 6：PHM -> MOD/STL 引用模式

### 9.1 目的

确认 DEV 叶子最终是否都能落到 PHM，再由 PHM 指向 MOD/STL 几何目标。

### 9.2 命令

```powershell
cd D:\vibe-coding\gim_viewer

Show-PhmReferenceMode ".\demo\demo-line" "Phm" "Mod"
Show-PhmReferenceMode ".\demo\demo-substation" "PHM" "MOD"
```

### 9.3 当前结果

demo-line：

```text
totalPhm            : 1836
totalTargets        : 3136
totalMissingTargets : 0
```

按 targetExts + targetCount + missingTargetCount：

|   数量 | 模式           |
| ---: | ------------ |
| 1300 | `.mod, 2, 0` |
|  355 | `.mod, 1, 0` |
|  181 | `.stl, 1, 0` |

demo-substation：

```text
totalPhm            : 4179
totalTargets        : 5938
totalMissingTargets : 0
```

按 targetExts + targetCount + missingTargetCount：

|   数量 | 模式                |
| ---: | ----------------- |
| 4049 | `.mod, 1, 0`      |
|   30 | `.stl, 1, 0`      |
|   16 | `.mod,.stl, 2, 0` |
|   14 | `, 0, 0`          |

其余少量 PHM 同时引用多个 MOD/STL。

### 9.4 分析结论

demo-line：

```text
PHM 引用目标全部存在。
PHM 最终落到 MOD 或 STL。
没有发现 PHM -> MOD/STL 缺失引用。
```

demo-substation：

```text
PHM 引用目标全部存在。
但存在 14 个 PHM 没有 SOLIDMODEL 目标。
另有少量 PHM 引用大量 MOD/STL，可能对应复杂组合几何。
```

当前可以区分两种情况：

```text
PHM -> MOD/STL 缺失：
目标写了，但文件找不到。

无几何 PHM：
目标根本没写。
```

demo-substation 的 14 个 PHM 属于后者，不应直接作为 missing reference 处理。

---

## 10. Step 7：无目标 PHM 与装配节点分析

### 10.1 目的

解释 demo-substation 中 14 个没有 MOD/STL 目标的 PHM。

重点回答：

```text
这些 PHM 是否孤立？
是否被 DEV 引用？
引用这些 PHM 的 DEV 是否被 CBM 引用？
这些 DEV 是否有 SUBDEVICE？
子 DEV 是否能到达几何？
```

### 10.2 命令

检查无目标 PHM：

```powershell
cd D:\vibe-coding\gim_viewer

Show-PhmNoTargetFiles ".\demo\demo-substation\PHM"
```

反查无目标 PHM 的 DEV / CBM 使用情况：

```powershell
Show-NoTargetPhmUsage ".\demo\demo-substation" "PHM" "DEV" "CBM"
```

验证无几何 root DEV 的子设备几何是否完整：

```powershell
Show-NoGeometryRootDevChildren ".\demo\demo-substation"
```

### 10.3 当前结果

14 个无目标 PHM：

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

这些 PHM 的使用情况：

```text
14 个 PHM 都被 DEV 引用。
对应 DEV 全部被 1 个 CBM 引用。
CBM ENTITYNAME 全部是 F4System。
这些 DEV 都有 SUBDEVICE。
SUBDEVICE 数量为 7 或 9。
```

进一步检查子设备：

```text
missingChildDev = 0
childWithoutPhm = 0
childWithoutGeometry = 0
childMissingGeometryTarget = 0
```

### 10.4 分析结论

这 14 个无目标 PHM 不应归类为错误引用。

更准确的分类是：

```text
ASSEMBLY_NODE_WITHOUT_OWN_GEOMETRY
```

含义：

```text
F4System 根设备 / 装配节点自身没有几何；
几何存在于它的 SUBDEVICE 子 DEV 上。
```

浏览器策略：

```text
不报错
不尝试渲染该节点自身几何
保留其层级节点
递归渲染其子设备几何
在诊断中标记：装配节点自身无几何
```

---

## 11. Step 8：PHM 与几何文件 orphan / 复用分析

### 11.1 目的

检查是否存在：

```text
没有被 DEV 引用的 PHM
PHM 引用但不存在的 MOD/STL
存在于包内但没有被 PHM 引用的 MOD/STL
MOD/STL 被多个 PHM 复用
```

### 11.2 命令

```powershell
cd D:\vibe-coding\gim_viewer

Show-PhmAndGeometryUsage ".\demo\demo-line" "Dev" "Phm" "Mod"
Show-PhmAndGeometryUsage ".\demo\demo-substation" "DEV" "PHM" "MOD"
```

检查 demo-substation orphan geometry 文件：

```powershell
$phmRoot = ".\demo\demo-substation\PHM"
$modRoot = ".\demo\demo-substation\MOD"

# 统计未被任何 PHM.SOLIDMODEL 指向的 .mod / .stl 文件
```

检查 orphan MOD 内容与 hash：

```powershell
$orphans |
  Get-FileHash -Algorithm SHA256 |
  Group-Object Hash |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

$orphans |
  Sort-Object Name |
  Select-Object -First 5 |
  ForEach-Object {
    "---- $($_.Name) ----"
    Get-Content -LiteralPath $_.FullName -Raw
  }
```

检查空 MOD 是否被引用：

```powershell
$rows |
  Where-Object { $_.isEmptyDeviceXml -eq $true } |
  Group-Object isReferenced |
  Sort-Object Name |
  Select-Object Count, Name |
  Format-Table -AutoSize
```

### 11.3 当前结果

demo-line：

```text
totalPhm                  : 1836
phmReferenceCount         : 1836
uniqueReferencedPhm       : 1836
missingPhmReferences      : 0
orphanPhm                 : 0

totalGeometryFiles        : 1988
geometryReferenceCount    : 3136
uniqueReferencedGeometry  : 1988
missingGeometryReferences : 0
orphanGeometryFiles       : 0

maxGeometryReuse          : 70
reusedGeometryFiles       : 127
```

demo-line 几何引用扩展名：

|   数量 | 扩展名    |
| ---: | ------ |
| 2955 | `.mod` |
|  181 | `.stl` |

demo-substation：

```text
totalPhm                  : 4179
phmReferenceCount         : 4179
uniqueReferencedPhm       : 4179
missingPhmReferences      : 0
orphanPhm                 : 0

totalGeometryFiles        : 5982
geometryReferenceCount    : 5938
uniqueReferencedGeometry  : 5938
missingGeometryReferences : 0
orphanGeometryFiles       : 44

maxGeometryReuse          : 1
reusedGeometryFiles       : 0
```

demo-substation 几何引用扩展名：

|   数量 | 扩展名    |
| ---: | ------ |
| 4135 | `.mod` |
| 1803 | `.stl` |

demo-substation orphan geometry：

```text
数量：44
类型：全部 .mod
长度：全部 78 bytes
SHA256：全部一致
是否被 PHM 引用：全部未引用
```

orphan MOD 内容：

```xml
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities />
</Device>
```

空 MOD 引用状态：

| 数量 | isReferenced |
| -: | ------------ |
| 44 | False        |

### 11.4 分析结论

demo-line：

```text
PHM 全部被 DEV 引用。
MOD/STL 全部被 PHM 引用。
无 orphan PHM。
无 orphan MOD/STL。
无 missing PHM。
无 missing MOD/STL。
但 MOD 存在复用，最大复用 70 次，127 个几何文件被复用。
```

demo-substation：

```text
PHM 全部被 DEV 引用。
PHM 引用的 MOD/STL 全部存在。
无 orphan PHM。
无 missing PHM。
无 missing MOD/STL。
几何文件没有复用，maxGeometryReuse = 1。
但存在 44 个 orphan empty MOD。
```

44 个 orphan empty MOD 的分类：

```text
UNREFERENCED_EMPTY_MOD
```

浏览器策略：

```text
不参与主链解析
不参与渲染
不作为 missing reference
仅进入诊断报告
```

---

## 12. Step 9：CBM 几何可达性总分类

### 12.1 目的

从用户视角验证：

```text
CBM 通过 OBJECTMODELPOINTER 指向 DEV 后，最终是否能到达 MOD/STL 几何目标。
```

本步骤只覆盖 DEV-linked CBM，不覆盖 IFC-only CBM 或 no model pointer 节点。

### 12.2 命令

```powershell
cd D:\vibe-coding\gim_viewer

Show-CbmGeometryReachability ".\demo\demo-line" "Cbm" "Dev" "Phm" "Mod"
Show-CbmGeometryReachability ".\demo\demo-substation" "CBM" "DEV" "PHM" "MOD"
```

### 12.3 当前结果

demo-line：

By status：

|    数量 | status              |
| ----: | ------------------- |
| 19175 | OWN_GEOMETRY        |
|  2682 | CHILD_GEOMETRY_ONLY |

By entityName + status：

|    数量 | 类型                                  |
| ----: | ----------------------------------- |
| 11773 | `Wire_Device, OWN_GEOMETRY`         |
|  5460 | `WIRE, OWN_GEOMETRY`                |
|  2682 | `Tower_Device, CHILD_GEOMETRY_ONLY` |
|  1627 | `Tower_Device, OWN_GEOMETRY`        |
|   315 | `CROSS, OWN_GEOMETRY`               |

demo-substation：

By status：

|   数量 | status                 |
| ---: | ---------------------- |
| 3921 | OWN_GEOMETRY           |
|  244 | OWN_AND_CHILD_GEOMETRY |
|   14 | CHILD_GEOMETRY_ONLY    |

By entityName + status：

|   数量 | 类型                                 |
| ---: | ---------------------------------- |
| 3894 | `PARTINDEX, OWN_GEOMETRY`          |
|  244 | `F4System, OWN_AND_CHILD_GEOMETRY` |
|   27 | `F4System, OWN_GEOMETRY`           |
|   14 | `F4System, CHILD_GEOMETRY_ONLY`    |

### 12.4 分析结论

demo-line：

```text
CBM -> DEV 入口总数：21857
OWN_GEOMETRY：19175
CHILD_GEOMETRY_ONLY：2682
MISSING / NO_GEOMETRY / CYCLE：0
```

线路样本中，所有 DEV-linked CBM 最终都能到达几何。

其中 Tower_Device 有两种表达：

```text
1. DEV 自身直接指向 PHM 几何。
2. DEV 自身不直接有 PHM，而是通过 child DEV 到达几何。
```

demo-substation：

```text
CBM -> DEV 入口总数：4179
OWN_GEOMETRY：3921
OWN_AND_CHILD_GEOMETRY：244
CHILD_GEOMETRY_ONLY：14
MISSING / NO_GEOMETRY / CYCLE：0
```

变电样本中，所有 DEV-linked CBM 最终也都能到达几何。

其中：

```text
PARTINDEX 是部件级实例，全部有自身几何。

F4System 是设备 / 装配级节点，可能：
1. 自身有几何；
2. 自身和子设备都有几何；
3. 自身无几何，但子设备有几何。
```

---

## 13. Round 3 当前结论

当前两个 demo 的 DEV-linked CBM 几何可达性为 100%。

也就是说：

```text
CBM 只要通过 OBJECTMODELPOINTER 指向 DEV，
最终都能沿 DEV / PHM 引用链到达至少一个 MOD 或 STL 几何目标。
```

但边界必须明确：

```text
这只覆盖 DEV-linked CBM。
不覆盖 IFC-only CBM。
不覆盖 no model pointer 的分组节点。
不代表 MOD/STL 已经可解析。
不代表 MOD/STL 已经可渲染。
只代表文件级几何目标可达。
```

当前形成以下结论：

```text
1. demo-line 中，DEV 图通过 SOLIDMODEL -> DEV 形成一层浅递归。
2. demo-substation 中，DEV 图通过 SUBDEVICE -> DEV 形成一层浅递归。
3. 两个 demo 的最大 DEV-to-DEV 深度都是 1。
4. 两个 demo 均未发现 DEV 引用环。
5. 两个 demo 均未发现 DEV -> DEV 缺失引用。
6. 两个 demo 均未发现 DEV -> PHM 缺失引用。
7. 两个 demo 均未发现 PHM -> MOD/STL 缺失引用。
8. demo-line 无 orphan PHM，且无 orphan geometry。
9. demo-substation 无 orphan PHM，但存在 44 个 orphan empty MOD。
10. demo-substation 存在 14 个装配节点自身无几何，但子设备几何完整。
11. DEV-linked CBM 均能到达至少一个 MOD/STL 几何目标。
```

---

## 14. 浏览器实现影响

### 14.1 DEV-linked CBM 可以递归追踪几何目标

当前两个 demo 说明：

```text
OBJECTMODELPOINTER -> DEV
```

之后，浏览器可以通过 DEV / PHM 引用链找到 MOD/STL 文件级几何目标。

### 14.2 递归仍需 visited 防环

虽然当前两个 demo 中：

```text
maxDevToDevDepth = 1
cycleCount = 0
```

但实现不能假设全部 GIM 都只有一层 DEV-to-DEV。解析器仍应使用递归遍历，并加入 visited 集合防止环。

### 14.3 装配节点自身无几何时不应报错

demo-substation 中存在 14 个：

```text
ASSEMBLY_NODE_WITHOUT_OWN_GEOMETRY
```

处理策略：

```text
保留节点
不渲染自身几何
继续递归子 DEV
渲染子设备几何
诊断中提示“装配节点自身无几何”
```

### 14.4 orphan empty MOD 不参与主链渲染

demo-substation 中存在 44 个：

```text
UNREFERENCED_EMPTY_MOD
```

处理策略：

```text
不参与主链解析
不参与渲染
不作为 missing reference
进入诊断报告
```

### 14.5 线路与变电的建模差异应进入解析设计

demo-line 更偏向：

```text
高复用 child DEV
组件库 / 参数化构件 / 同质化部件复用
```

demo-substation 更偏向：

```text
实例化 DEV / PHM / MOD
设备树 / 装配树 / PARTINDEX 明细节点
```

浏览器实现中不宜只按一种模型组织方式写死逻辑。

### 14.6 当前仍不能进入的结论

当前不能得出：

```text
MOD 已经可解析
STL 已经可解析
PHM TRANSFORMMATRIX 已经可应用
DEV 图在所有 GIM 中都只有一层
所有工程都没有 DEV 环
所有 orphan MOD 都是空 XML
线路和变电的组织方式可推广为规范规则
```

当前只能确认：

```text
在当前两个 demo 中，
DEV-linked CBM 的文件级几何目标引用链可以闭合。
```

---

## 15. Round 3 后续建议

后续可以继续做：

```text
1. PHM TRANSFORMMATRIX 字段形态分析。
2. MOD 静态类型进一步分组。
3. STL 文件大小与引用类型分析。
4. IFC-only CBM 与 DEV-linked CBM 的并行渲染策略设计。
5. 多工程样本验证 DEV 图深度、环、orphan geometry 是否稳定。
```

但这些仍应保持 schema analysis 范围，不应直接进入几何渲染实现。
