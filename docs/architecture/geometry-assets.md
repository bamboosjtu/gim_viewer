# 几何资产与表示索引

工程实体、几何编译和模型树是三个不同粒度。几何资产按来源 DEV 模板复用，工程实体只拥有业务身份和来源成员；两者通过表示索引关联，不生成“实体 GLB”。

## 流水线

```text
来源/装配索引
  ├─ 工程语义：EngineeringEntity（业务身份、成员、待归集合）
  └─ 几何编译：GeometryAsset（来源 DEV 模板、PHM/MOD/STL、placement）
             │
      EngineeringRepresentationIndex
             │
         模型树/选择/属性
```

- 模板身份使用规范化 DEV 路径；同一模板的多个 occurrence 只改变 placement，不复制几何。
- 表示索引由 `engineeringRepresentationService.ts` 构建：DEV 使用 `sourceId/rootOccurrence/assemblyPath/devPath`，IFC 使用 `sourceId/modelId/expressId`。
- 模型树不反向改变模板键；切换三视图、搜索和选择不能触发几何重编译。
- 单 occurrence 与多 occurrence 使用同一条 DEV 模板路径。

## 缓存层级

| 层级 | 编译 | 持久化 |
|---|---|---|
| L0 | 优先编译、优先显示全站最低成本表示 | 生成即持久化 |
| L1 | 进入有效视域后按需构建 | 选中/提升或淘汰后再次请求才选择性持久化 |
| L2 | 用户显式精化 | 默认不持久化，只保留会话内存 |

全站最终都要生成全部设备的 L0，只是先生成视野内的设备；视野外 L0 仍留在请求集合中后台补齐。L1 只在视野内按投影大小生成，L2 只在用户请求时计算。远景 L0 与中景 L1 都跳过小构件和小布尔开孔，L1 增加可见分段，L2 才精确 CSG。

很小的 DEV 由 Worker 队列合批调度，不拆模板键；大 DEV 按装配子树/MOD 任务拆分并行，再合并为单个 DEV 模板，最后按 occurrence placement 组装。重复来源模板共享缓存，不能按工程实体复制。

## 当前限制

- 原生 WebView2 的 L0/L1/L2 冷暖矩阵仍需在可链接环境复测。
- 实体与几何的表示关联已存在，但属性面板的完整“表示/模板”展示仍可继续完善。
