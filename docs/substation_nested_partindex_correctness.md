# 任务 A：嵌套 PARTINDEX 放置根与候选范围

2026-10-05—06。基线 HEAD `a0e05124b148c02755c01c4514f201f0e4611ba4`，开始时工作区干净。
本轮未创建 commit；源码与构建可恢复快照、样本完整 SHA 和运行环境见
[任务 B 的共同实验基线](substation_ifc_responsiveness.md)。两项修改单独记录；
`output/playwright/runtime-closeout/task-a.patch` 和 `task-a-new-tests.zip` 是任务 B 修改前的任务 A 快照。

## 真实 04 案例与修改前复现

完整语义链（以下均为 CBM 下的文件）：

```text
project.cbm
→ 01d860ec-8de9-413a-89f9-5356fa01fbfe.cbm (F1)
→ 4d79cdb6-3863-4977-b0fd-8bc6304759e0.cbm (F2)
→ d3491e15-b0cb-47bc-92a9-5fd4e33cf6fd.cbm (F3)
→ c93b6211-9266-4a4f-a0d9-dec587b4e02c.cbm (F4)
→ f71302ae-a963-4ccd-a7a7-9339fefd874c.cbm (PARTINDEX)
→ 9a92e50d-eded-440c-a0e1-fa9ccd4956a7.cbm (PARTINDEX)
→ 85401e77-4659-47df-847b-ec4d4e8a319d.cbm (PARTINDEX，点击对象)
```

对应 OBJECTMODELPOINTER / DEV 身份：

| 语义节点 | DEV 文件 |
|---|---|
| F4 `c93b6211…` | `6fc1b345-6405-454f-bc8f-71fefe5d235d-0056de35.dev` |
| PARTINDEX `f71302ae…` | `558a24f3-23ac-4057-928c-e9a6e063a574-0056d96f.dev` |
| PARTINDEX `9a92e50d…` | `8dd39b94-d6ce-4a81-8159-cbc633bed633-0056cd33.dev` |
| PARTINDEX `85401e77…` | `71587486-f6d7-4b4e-9a30-af9b4f8e472c-0056cae1.dev` |

原 alias 把语义父 PARTINDEX `9a92e50d…` 当作 rootOccurrence，候选为相对它的 `sub:0` 到
`sub:7`。实际加载入口是 F4 `c93b6211…`。桌面默认完整打开后的几何数为 532；点击该部件后
没有命中实际放置根，反而从错误语义 owner 加载额外 19 个 raw group，总数增到 551。
修改前 JSON、实际桌面日志和截图分别保留在 `task-a-before.json`、
`task-a-desktop-before.log`、`task-a-before.png`。

## 最小修改与身份边界

`gim/substationEvidence.ts` 延续现有派生 alias，新增 `partToSemanticParent`，将其与
`partToRoot` 分开。后者沿语义链继承真正的几何加载 seed；
`isSubstationGeometryRoot()` 与 `modAutoLoadService.isGeometryAutoLoadSeed()` 共用原有谓词。
DEV 虚拟节点只作为装配证据，不另建语义 seed。

顶层 PARTINDEX 在该 root 的真实 DEV 装配图中按 DEV identity join。嵌套 PARTINDEX
进一步限定在父 PARTINDEX 已关联的每个候选子树中。父候选为空时，子候选也为空；
父候选有多个时，保留每个子树中合法的匹配。没有全站模板匹配、列表序号配对或唯一候选猜测。

本例真实外层装配为 `sub:0`，中层父候选为 `sub:0/sub:0`、`sub:0/sub:1`，
点击对象有 16 条合法路径：`sub:0/sub:{0,1}/sub:{0..7}`。
该 DEV 自身仅为装配，实际渲染叶子为
`c6735970-a473-479d-b710-297d000727b1-0056c885.dev`，路径再接 `/sub:0`。
16 条路径全部属于 F4 `c93b6211…`，不是 16 个新的语义几何实例。

nodeInteractionService、按 root 合并加载任务、SelectionRequest 和 raw/GLB occurrence 查询
继续使用已有机制；本轮没有创建第二份 SceneGraph 或改变缓存格式。

## 独立不变量及测试

新增 `nestedPartIndexFixture.ts` 构造 F4 → PARTINDEX-A → PARTINDEX-B，
真实 DEV 图中的另一个无关分支也引用 B.dev，验证嵌套 B 不会扩大到该分支。
另覆盖多父候选、父链未关联、子 identity 不存在、真实 GLB 序列化恢复、raw 路径、
同 root 的共享在途加载、快速选择、重复点击和材质/副本边界。

真实样本严格测试对 cold 和 SQLite restore 后的树分别断言：

- 已关联 alias 的 root 属于实际几何 seed 集合。
- 每条候选路径确实存在于这个 root 的真实装配图。
- 嵌套候选在父候选的子树范围内。
- warm/cold 等价之外，04 上述具体 root 和 16 条路径符合独立装配事实。

原 23 项 SelectionRequest 竞争测试保留，新增嵌套共享加载案例后为 24 项。
严格入口支持 `GIM_REQUIRE_SUBSTATION04=1`，本轮四个样本均为必需，不能因缺 04 跳过。
最终严格门禁 4 项通过、零跳过，详见共同报告。
04 的歧义计数由历史 60 变为 108，这是改正 physical root 和候选范围后的真实计数；
没有以减少歧义作为验收目标。

## 桌面观察与未执行项

第一阶段 production release、Fragments 默认 OFF、未暂停 IFC，04 冷打开成功加载全部 19 个
IFC。点击上述嵌套对象后，高亮集合有 16 条真实叶子路径，全部 root 为 `c93b6211…`，
几何总数保持 532。UI 明确显示 16 装配候选；`task-a-after.png` 与
`task-a-desktop-after.log` 保存了截图和实际 root/assembly 集合。
这证明本例定位范围正确，不证明全站 primitive 已完整还原。

最终 production release 的真实 warm 桌面补测也执行了父部件 → 嵌套子部件快速选择和重复点击。
当后台 IFC 为 11 个时，最新 request 6/7 均为 `85401e77…`，属性“方形柱头”，
16 条高亮叶子仍全部属于 `c93b6211…`，assembly 为 `sub:0/sub:{0,1}/sub:{0..7}/sub:0`。
该 root 的 GLB 实例键在重复点击前后均只有同一个，`scopeCorrect` 与 `rootKeysUnchanged` 均 true。
之后默认后台完整加载 19 个 IFC，几何总数回到 532，选择仍是该嵌套部件。
证据为 `release-final/04-warm/interaction.json`、`nested-part.png`、`scene.json`。
截图显示树、属性、16 候选说明与真实红色高亮；不将可见截图夸大为全站还原证明。
此轮与严格回归并行，仅用作定位正确性观察，不作为任务 B 的独立速度对照。
raw/GLB 恢复、父范围、多候选/未关联、快速切换和重复点击的自动测试另行保留。

## 版本

alias 是从已有持久化树和真实 DEV 图计算的运行时派生结果，未持久化旧 alias。
不升级变电语义 v25、geometry v8-occurrence、Spatial snapshot v2、线路或 Fragments 版本，
不清除用户项目缓存。FAM schema 和 occurrence 格式保持原样。
