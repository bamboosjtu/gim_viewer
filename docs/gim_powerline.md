# 线路 GIM 当前实现

> 线路 Runtime 面向 `GIMPKGT` 工程，负责 CBM 语义、FAM/DEV 属性、地图投影和来源追踪。
> 容器、会话、缓存共性见 [gim_common.md](gim_common.md)，字段和跨样本证据见
> [schema/README.md](schema/README.md)，性能问题见 [benchmark_powerline.md](benchmark_powerline.md)。

## 1. Runtime 边界

线路工程由 source magic 路由到 `Powerline Runtime`。它不加载 IFC，也不创建独立 3D
Viewer；线路的“模型”工作区是 2D 地图，杆塔形状仅在来源页提供局部 HNum 骨架预览。

```text
GIMPKGT
  → line cache validation
  → semantic pack / SQLite restore 或 cold parser input
  → Line Parser Worker（不可用时主线程兼容回退）
  → GimGraph + FAM/DEV attributes
  → navigation tree + map + property/source panel
```

当前能力：

| 能力 | 实现 |
|---|---|
| 容器识别与内容校验 | `gimExtractor.ts`、`gimSourceService.ts`、`projectType.ts` |
| CBM 图 | `lineCbmParser.ts` / `lineCbmParserCore.ts`，支持 F1–F4、塔、导线、跨越物 |
| 属性 | `lineFamParser.ts`、`lineDevParser.ts`，写入扁平 payload |
| 解析输入 | `lineParserInput.ts`，semantic pack、批量磁盘读和大 MOD 元数据过滤 |
| Worker | `lineParserWorker.ts`、`lineParserWorkerClient.ts`，共享文本/解析 cache |
| 地图数据 | `lineMapData.ts`，塔位、WIRE、CROSS、质量和 unresolved 统计 |
| 地图视图 | Canvas overlay + MapLibre OSM raster；OSM 失败回退 Canvas-only |
| 交互 | 树↔地图定位、搜索、图层开关、来源定位、属性分组 |
| 线路几何 | 四类文本 MOD 仅按需解析；不进入独立线路 3D 渲染 |

## 2. CBM、属性与引用链

线路 CBM 的引用键随层级变化：F1 使用 `SECTIONS`，F2 使用 `STRAINSECTIONS`，F3 使用
`GROUPS`，塔组使用 `TOWERS/STRINGS/BASES/SUBDEVICES`，WIRE 组使用
`BACKSTRING/FRONTSTRING`。叶子节点通过 `OBJECTMODELPOINTER` 指向 DEV、通过
`BASEFAMILY` 指向 FAM；`WIRETYPE`、`ISJUMPER`、`KVALUE`、`POINT*.BLHA` 等原始字段保留
在 `rawProps`，不在解析层提前猜测工程公式。

`GimGraph` 是线路 Runtime 的唯一语义输入，包含：

- `nodesByPath` 与有序 `children`，保留 CBM source path；
- `refs`，按 CBM/DEV/FAM/PHM/MOD/STL/WIRE/IFC 分类，并保留 `rawRefs`；
- `stats` 和 `filesByType`，用于文件摘要、缓存恢复和诊断；
- 线路属性 payload 的 `source_path`、`normalized_path`、`file_name_lower`、行序和原始行。

线路 FAM 支持 `展示名=英文键=值`、`展示名=展示名=值`、`=展示名=值` 和普通
`键=值`；值中的等号不会被错误截断。DEV 保留单行、原始行和无值属性。FAM/DEV
缺失只形成 `unmatchedRefs`，不阻断 graph 或地图渲染。

线路 MOD 按内容分为 HNum、Point/Line、Section-KV、普通 Key-Value 四类 Geometry IR。
它们是来源页的可读参数和局部预览输入，不是线路地图的完整三维模型。

## 3. 解析性能与共享输入

冷路径先读取 CBM/DEV/FAM/PHM 等语义小文件，线路 MOD 中超过
`LINE_PARSER_SMALL_MOD_MAX_BYTES` 的 native 几何文件只发送路径元数据；这样 Worker
仍能得到完整文件类型统计，但不会复制无关大几何字节。

`LineParserTextCache` 在同一 parser session 内缓存文本、KV/FAM/DEV 解析结果。graph 和
attributes 都使用同一实例，避免重复 `TextDecoder`、重复按文件解析和不同路径上的
结果漂移。Worker 与主线程 fallback 使用同一套 `lineCbmParserCore`、
`lineAttrParserCore` 和 cache contract。

缓存命中时，线路 graph、属性和文件统计从 SQLite/semantic pack 恢复；缓存完整性失败
则整体回到 cold rebuild，不提交 partial graph。`save_line_project_cache` 将 graph 与
FAM/DEV 属性放入一次事务，成功后才更新线路域版本。

## 4. 地图与交互投影

`extractLineMapData(graph, attrs)` 把语义图投影成渲染无关的 `LineMapData`：

| 投影对象 | 输入 |
|---|---|
| `TowerMarker` | 塔组 `BLHA`、塔号/塔型/呼高/转角属性 |
| `WireSegment` | WIRE 的 `POINT0/POINT1.BLHA`、`WIRETYPE`、`KVALUE`、`SPLIT` |
| `CrossMarker` | 跨越物节点的坐标、类型和名称 |
| unresolved | 无坐标、属性未命中或引用未定位的原因 |

BLHA 按“纬度、经度、高程、方位角”读取，地图坐标输出为 `[经度, 纬度]`。MapLibre
overlay 和 Canvas-only 使用同一个绘制/命中逻辑，只替换投影实现；因此底图不可用时
仍保留网格、比例尺、hover、click、tooltip 和树联动。

默认底图为 OSM online；连续 tile error 达到阈值后销毁 MapLibre probe，切换到
Canvas-only，并在内存 `basemapStatusService` 中留下状态。PMTiles 代码保留但默认关闭，
不把在线瓦片写入本地缓存。

悬链线当前是实验性 2D 示意：`same-point` 内部连接不画成跨塔曲线，绘制和 hit-test
共享采样；`KVALUE`、`MATRIX0` 的物理公式仍以 Schema 研究和技术债务为准。

## 5. 属性、来源和本地缓存

线路属性抽屉分为概览、参数、关系、来源四个投影：正文显示业务字段，GUID 和长路径
只作为来源按钮的内部定位键。来源按钮可以回到 CBM、FAM、DEV、PHM、MOD 或 STL 的
可读上下文；HNum 预览明确标注为局部骨架，不冒充完整塔型。

本地缓存的共性规则见 [gim_common.md](gim_common.md)。线路专属部分是：

- `powerline_cbm_node`：节点和 raw properties；
- `powerline_cbm_child`：有序父子边；
- `powerline_cbm_ref`：分类引用及归一化诊断键；
- `powerline_file_stat`：文件类型统计；
- `powerline_fam_property` / `powerline_dev_property`：扁平属性和 source path。

线路 cache key 使用 `gim_project` 的源 SHA、文件尺寸和
`gim-line-parser-v1`。线路不检查或缓存 IFC；变电域版本变化不会使线路 graph/属性
失效。工程切换时 parser Worker、MOD 来源 cache、地图句柄和 UI 状态一起清理。

## 6. 正确性边界与下一步

当前必须保持的 invariant：

- source magic 决定 Runtime；旧缓存的 `project_type` 不能改写路由；
- cold parser、Worker parser、semantic pack 和 SQLite restore 的 graph/属性业务形状一致；
- 路径大小写、目录大小写和 `/`/`\` 分隔符变化不改变引用命中；
- 地图塔位/导线坐标必须是有限值，source path 必须能回到 graph 节点；
- 工程切换后迟到 Worker、属性或地图回调不能提交到新工程。

后续路线：

1. 为 HNum/MOD 来源预览补齐 read、parse、SVG/Canvas render 的分段 profile，并评估有界
   预览 cache；不阻塞线路首屏。
2. 用独立进程拆分 warm JS heap、WebView/Worker/Tauri RSS 和释放后的增长，避免把 process
   tree RSS 与 JS heap 混为一谈。
3. 对 line03 继续拆 7z decode、entry write 和 parser input 阶段；先保留现有安全配额
   和 cache identity。
4. 完成 `KVALUE`、`MATRIX0`、斜档距和跨越物坐标语义核验，再决定实验弧垂是否继续默认开启。

独立线路 3D、IFC 加载和新的语义 Worker 不在当前线路 Runtime 范围内。
