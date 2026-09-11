# GIM Viewer 产品路线图

> 目标：将 GIM Viewer 从“GIM 文件浏览器”逐步演进为一个 **local-first、plugin-based、source-neutral 的输变电工程空间数据工作台**。  
> 核心原则：**浏览是能力，判断才是产品；目标架构可以一次想清楚，但迁移必须分阶段完成。**

---

## 1. 产品定位

### 1.1 核心定位

GIM Viewer 不再仅以“打开和浏览 GIM 模型”为主要价值，而是：

> **以 GIM / IFC 工程模型作为工程对象与空间索引，关联外部业务数据，支持空间化管理、数据核验和异常发现。**

重点不是重复建设已有业务系统，而是利用：

- 工程对象
- 空间位置
- 拓扑关系
- 时间状态
- 多源数据关联

发现现有 Excel、业务系统列表页或纯模型浏览无法直观看出的异常。

### 1.2 产品边界

GIM Viewer Core 应保持：

- 中立
- 独立
- 可开源
- 本地优先
- 与企业内部系统解耦

企业内部数据接入采用闭源插件，例如：

- `dcp_plugin`
- 未来其他内部系统插件

### 1.3 架构原则

```text
┌──────────────────────────────────────┐
│           GIM Viewer Core            │
│                                      │
│ GIM / IFC / GIS / Rendering          │
│ Domain Model / Validation / Cache    │
│ Plugin Host / Line Runtime / ...     │
└──────────────────┬───────────────────┘
                   │ Plugin API
          ┌────────┴────────┐
          │                 │
┌─────────▼─────────┐ ┌─────▼────────────┐
│ Public Plugins    │ │ Enterprise Plugin │
│                   │ │                   │
│ CSV / Excel       │ │ DCP Plugin        │
│ GeoJSON / Mock    │ │ Other Internal    │
└───────────────────┘ └───────────────────┘
```

核心要求：

> **Core 不知道什么是 DCP。**

DCP 只负责：

```text
企业原始数据
    ↓
DCP Plugin / Adapter
    ↓
GIM Viewer 中立领域模型
```

---

# 2. 路线图总原则

## 2.1 不做“大爆炸式重构”

禁止采用：

```text
旧 GIM Viewer
    ↓
全部推翻
    ↓
Core + Plugin API
+ Line Runtime
+ Substation Runtime
+ Domain Model
+ 全部新功能
    ↓
再发布
```

采用渐进式迁移：

```text
稳定旧功能
    ↓
建立最小新架构
    ↓
用一个真实功能验证架构
    ↓
发布
    ↓
继续迁移
```

原则：

> **新功能必须走新架构；能正常工作的旧功能不为了“架构漂亮”而立即迁移。**

---

## 2.2 每个版本只承担一项主要用户能力

每个 Release 最多包含：

> **1 个主要用户能力 + 为它服务的必要架构调整**

避免：

- “顺便重构”
- “顺便把插件体系做完整”
- “顺便接站班会”
- “顺便把变电也一起改了”

---

## 2.3 架构工作必须有预算

建议每个发布周期：

- **≤ 30%：纯架构、重构、基础设施**
- **≥ 70%：用户可见功能、测试、Bug、文档和交付**

如果一个架构调整需要长时间投入，但用户侧没有任何可见变化，应重新判断其必要性。

---

# 3. 公共路线与企业路线分离

## 3.1 Public Roadmap

公开仓库：

```text
gim-viewer
├── core
├── plugin-api
├── line-runtime
├── substation-runtime
├── validation
└── plugins
    ├── csv
    ├── excel
    ├── geojson
    └── mock
```

主要沉淀个人长期技术资产：

- GIM / IFC 能力
- GIS 与坐标能力
- 工程对象模型
- Plugin API
- 对象匹配
- 数据核验
- 空间分析
- 进度表达
- Visualization
- Local-first 能力

---

## 3.2 Enterprise Roadmap

企业内部仓库建议物理隔离：

```text
gim-viewer-enterprise
└── plugins
    └── dcp
```

或：

```text
gim-viewer-plugin-dcp
```

闭源插件负责：

- DCP SDK 调用
- 鉴权
- 企业接口
- 内部字段映射
- 数据标准化

不应该负责：

- 通用进度分析
- 坐标核验
- 异常识别
- 通用 UI
- 通用业务规则

原则：

> **私有插件尽可能薄，公开 Core 尽可能聪明。**

---

# 4. 发布路线

---

## Release A：现状基线版

### 目标

> **冻结当前可工作的 GIM Viewer，建立下一轮演进的可靠起点。**

### 做

- 修复明显影响使用的 Bug
- 确认现有线路功能
- 确认现有变电功能
- 补充最低限度 README
- 盘点代码、功能和技术债
- 记录当前架构
- 保存一个稳定版本 / tag

### 不做

- 大规模 Core 重构
- Plugin API 完整设计
- DCP 接入
- 新管理模块
- 为未来可能需求设计复杂抽象

### 完成标准

- 当前主要已有功能可正常运行
- 有明确版本号
- 可以回退到该版本
- 有一份架构与技术债基线文档

---

# 5. Release B：最小插件骨架版

### 目标

> **第一次建立“Core 不关心数据来源”的边界。**

不要一开始设计完整插件生态。

只建立满足第一个真实功能的最小 Plugin API。

### 最小能力

例如：

```text
Plugin
├── metadata
├── lifecycle
├── capability
└── data provider
```

### 第一个公开插件

优先选择：

> **CSV / Excel 杆塔坐标插件**

原因：

- 不涉及企业数据
- 能公开
- 能验证外部数据接入
- 能验证对象映射
- 能验证坐标体系
- 能直接服务下一阶段“坐标核验”

### Walking Skeleton

```text
CSV / Excel
    ↓
Public Plugin
    ↓
Domain Model
    ↓
Tower Matcher
    ↓
Validation
    ↓
GIS / 3D
```

### 完成标准

- Core 不直接依赖具体数据源
- 至少一个公开插件可以加载
- 外部坐标可以转换为中立领域对象
- 插件失败不影响核心 Viewer 基本运行

---

# 6. Release C：第一个完整管理闭环——杆塔坐标核验

### 定位

这是 GIM Viewer 从：

> `Model Viewer`

转向：

> `Engineering Tool`

的关键版本。

### 用户问题

现有不同来源的杆塔坐标是否一致？

### 输入

- GIM 中的设计杆塔位置
- CSV / Excel / GeoJSON 等外部坐标

### 流程

```text
导入坐标
    ↓
识别塔号 / 对象 ID
    ↓
GIM 对象匹配
    ↓
坐标系转换
    ↓
计算空间偏差
    ↓
应用阈值规则
    ↓
异常高亮
    ↓
形成异常清单
    ↓
导出结果
```

### 用户最终获得的不是

> “我可以在地图上看到两个点。”

而应该是：

> “126 基杆塔中，119 基正常，5 基偏差超过阈值，2 基无法匹配。”

### 核心能力沉淀

公开 Core：

- SpatialObject
- CoordinateObservation
- ObjectMatcher
- CoordinateDeviationRule
- Finding
- Validation Engine
- GIS / 3D Highlight

### 完成标准

用户可以独立完成：

> **导入 → 匹配 → 核验 → 查看异常 → 导出结果**

---

# 7. Release D：DCP 施工进度插件

### 目标

> **验证企业业务数据通过闭源插件接入公开 Core 的完整链路。**

### 第一阶段只接

> **施工进度**

暂不同时加入：

- 站班会
- 大量项目管理字段
- 全部 DCP 功能
- 综合驾驶舱

### 数据链

```text
DCP SDK / API
    ↓
DCP Private Adapter
    ↓
ProgressRecord
    ↓
Object Matching
    ↓
Line Runtime
    ↓
Spatial Progress Visualization
```

### 典型能力

- 杆塔进度状态映射
- 区段进度
- 计划 / 实际对比
- 滞后杆塔定位
- 长时间无进展对象
- 进度空间断点识别

### 完成标准

在至少一条真实线路上，可以：

> 自动从 DCP 获取施工进度 → 关联到工程对象 → 在地图 / 三维中表达 → 找到异常。

---

# 8. Release E：进度异常分析

在 Release D 确认真实用户价值之后，再增强分析能力。

候选功能：

- 计划与实际偏差
- 工序异常
- 连续区段施工断点
- 长时间无进展
- 数据缺失
- 工程对象无法映射
- 计划状态与现场状态冲突

重点从：

> **展示进度**

升级到：

> **发现进度问题**

---

# 9. Release F：站班会等现场作业数据——待验证

站班会数据暂不作为确定路线。

必须先回答：

> **站班会数据与工程空间对象关联后，是否能形成现有系统无法直接提供的新判断？**

只有存在明确价值，例如：

```text
当天作业任务
    +
对应杆塔 / 区段
    +
施工班组
    +
风险点
    +
进度状态
    ↓
当天空间化施工态势
```

才进入产品。

如果只是：

> “点击杆塔查看站班会记录”

则优先级较低。

---

# 10. Line Runtime 与 Substation Runtime

当前继续采用：

```text
Core
├── Line Runtime
└── Substation Runtime
```

但不要把“完成 Runtime 重构”作为独立的大版本目标。

原则：

> **跟随真实功能自然拆分 Runtime，而不是暂停产品开发专门完成架构工程。**

---

## 10.1 Line Runtime 当前优先

线路方向已经更容易形成实际管理闭环，优先沉淀：

- GIMGraph
- GIS
- 杆塔拓扑
- STL 塔型
- 工程对象索引
- 坐标核验
- 施工进度
- 区段状态
- 空间异常

---

## 10.2 Substation Runtime 暂时控制范围

候选长期能力：

- IFC
- GLB
- 设备对象
- 建筑空间
- 设备状态
- 安装 / 运维数据
- 信息核验

但现阶段：

> **不要为了线路路线图完整而同步大规模改造变电。**

先解决变电真正阻碍使用的关键问题。

---

# 11. Domain Model 设计原则

Core 中不出现任何企业特有概念。

不要使用：

```text
DcpProject
DcpTower
DcpProgress
DcpMeeting
```

而应使用中立模型，例如：

```text
ProjectObject
SpatialObject
Tower
Equipment
WorkActivity
ProgressRecord
CoordinateObservation
Finding
```

DCP 内部字段必须在插件边界完成映射。

---

# 12. Validation Engine 是值得长期积累的核心能力

长期可以形成：

```text
Model Object
      +
External Observation
      ↓
Object Matching
      ↓
Validation Rule
      ↓
Finding
```

候选规则：

```text
TowerCoordinateDeviationRule
MissingObjectMappingRule
DuplicateObjectRule
ProgressDiscontinuityRule
ScheduleMismatchRule
MissingDataRule
```

其意义在于：

> **让 GIM Viewer 从“展示数据”升级成“判断数据”。**

---

# 13. 功能准入规则

任何新功能进入路线图前必须通过以下三个 Gate。

## Gate 1：架构门槛

> 这项架构工作是否至少服务一个当前正在开发的用户能力？

如果没有：

**不做。**

---

## Gate 2：产品门槛

必须回答：

> **它相比 Excel、DCP、CAD、GIS 或现有工作方式，明显改善了什么？**

如果无法回答：

**不做。**

---

## Gate 3：发布门槛

一个版本最多：

> **一个主要用户能力 + 必须的架构调整**

如果版本开始出现大量“顺便”事项：

**砍掉。**

---

# 14. 当前新功能优先级

## P0 杆塔坐标核验

原因：

- 空间价值非常明确
- 适合公开实现
- 可验证 Plugin API
- 用户结果清晰
- 技术闭环完整

---

## P1 DCP 施工进度空间化

原因：

- 具有真实管理价值
- 适合工程对象映射
- 可以验证企业插件体系
- 可能进一步形成异常分析

---

## P2 进度异常分析

在 P1 有真实使用后继续。

---

## P3 站班会数据

只有证明其空间关联产生新增管理价值后进入。

---

# 15. 当前明确不进入主线的内容

暂缓：

- 完整数字孪生平台
- 全过程工程管理平台
- 全量 DCP 数据复制
- 为了展示而加入 AI
- 完整可观测性基础设施
- 大规模统一变电架构改造
- 未经真实场景验证的插件类型
- 为架构美观进行的全仓库重构

---

# 16. 推荐半年路线

| 阶段 | 产品目标 | 架构目标 | 主要成果 |
|---|---|---|---|
| 1 | 稳定现状 | 完成盘点 | Baseline Release |
| 2 | 外部数据接入 | 最小 Plugin API | CSV / Excel Plugin |
| 3 | 坐标核验闭环 | Domain + Validation | Coordinate Validation |
| 4 | DCP 进度接入 | Private Adapter | Spatial Progress |
| 5 | 发现进度异常 | 完善通用分析 | Progress Findings |
| 6 | 用户反馈决定下一步 | 只补真实需要 | 站班会或其他 |

---

# 17. 发布节奏原则

发布不是等待“架构全部完成”。

正确逻辑：

```text
目标架构明确
      ↓
只迁移当前需要的一块
      ↓
完成一个用户闭环
      ↓
发布
      ↓
真实使用
      ↓
反馈
      ↓
下一次迁移
```

因此：

> **架构变动和候选功能越多，越应该缩小单个版本范围，而不是延长发布周期。**

---

# 18. 个人开发约束

因为 GIM Viewer 本质上是个人长期作品，而不是 KPI 项目，因此必须主动控制复杂度。

建议：

1. **任何时候只维护一个主动开发主线。**
2. **每个 Release 只解决一个核心问题。**
3. **新想法先进入 backlog，不立即实现。**
4. **架构必须被实际功能拉动。**
5. **用户反馈优先于理论完整性。**
6. **允许版本“完成”，不要永久重构。**
7. **公共 Core 与企业插件物理隔离。**
8. **企业数据默认不得进入公共仓库、日志、测试样例和遥测。**

---

# 19. 路线图的核心判断

未来判断某项功能是否属于 GIM Viewer，可以使用这个问题：

> **如果去掉工程模型、空间位置、对象关系和跨数据源关联，这项功能是否用 Excel / 现有系统就已经一样好用？**

如果答案是“是”：

> 大概率不属于 GIM Viewer。

如果空间、对象和模型能够明显帮助：

- 发现异常
- 判断一致性
- 理解状态
- 关联多源数据
- 快速定位问题

则属于 GIM Viewer 的核心方向。

---

# 20. 最终产品原则

## Product

> **浏览是能力，判断才是产品。**

## Architecture

> **企业系统只提供数据，不能定义 GIM Viewer。**

## Open Source

> **所有企业特有知识停在插件边界；所有具有普适价值的工程模型、匹配、核验、分析和可视化能力进入公开 Core。**

## Delivery

> **不要为了未来的完整架构，牺牲现在可发布的产品。**

## Priority

当前只优先完成两项新能力：

1. **杆塔坐标核验**
2. **DCP 施工进度空间化**

其余功能等真实用户反馈后再决定。
