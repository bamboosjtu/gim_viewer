# M4 路线图

> 线路 GIM 可视化 MVP 之后的改进路线。
> 按 A/B/C/D 四个方向组织，优先级从高到低。
>
> **M4 Sprint 1 已启动**（工程化收口 + MapLibre 技术验证），详见 [M4 Sprint 1 总结](m4-sprint1-summary.md)。

## M4-A 地图增强

> 目标：引入地图引擎，支持真实底图和精确投影。

### MapLibre 验证

- [~] 在 Tauri 环境验证 MapLibre GL JS 可用性（Canvas + WebGL） — **M4-A1 技术验证中**：probe 模块已创建，默认关闭
- [x] 验证 CSP 策略兼容性（`script-src 'self' 'wasm-unsafe-eval'`） — **M4-A1 已验证**：`worker-src 'self' blob:` + `style-src 'unsafe-inline'` 已兼容，无需改 CSP
- [ ] 验证离线模式 fallback（无网络时降级到 Canvas 2D） — 留给 M4-A2

**M4-A 状态：A1 + A2 第 1/2 轮已完成**

- ✅ 引入 `maplibre-gl` 依赖
- ✅ `ENABLE_MAPLIBRE_EXPERIMENT = false`（默认关闭）
- ✅ `src/ui/lineMapBaseLayer.ts` probe 模块（empty style，不加载瓦片）
- ✅ 集成到 `lineProjectView.ts`（Canvas 主流程不受影响）
- ✅ M4-A2 第 1 轮：Canvas overlay + 交互桥接（hover/click/联动）+ ScaleControl + fitBounds(duration:0)
- ✅ M4-A2 第 2 轮：cleanup patch + PMTiles 离线瓦片最小预研（`ENABLE_PMTILES_EXPERIMENT=false`）

详见 [地图底图评估 - 第 14-16 节](map-basemap-evaluation.md#14-m4-a2-lite底图容器与-canvas-overlay-桥接最小验证)

### 离线瓦片

- ✅ PMTiles protocol 注册（`pmtiles://` 协议，防重复 + 引用计数 cleanup）
- ✅ style 工厂（empty + pmtiles，失败回退）
- ⏳ 实际瓦片文件（需手动放入 `public/tiles/demo.pmtiles`）
- [ ] 确定瓦片覆盖范围 + source-layer 配置
- [ ] 瓦片版本管理 + 缓存失效

### Canvas overlay

- ✅ MapLibre 底图 + Canvas overlay 叠加渲染
- ✅ 塔位/导线在 overlay 层绘制，跟随地图缩放/平移
- ✅ 保留现有图层开关逻辑
- ✅ pointer 事件桥接（hover/click/leave）

### 坐标偏移

- [ ] BLHA 坐标系识别（WGS-84 / GCJ-02 / BD-09）
- [ ] 坐标转换工具（如需要）
- [ ] 地图标注坐标与底图对齐验证

### 评估文档

详见 [地图底图评估](map-basemap-evaluation.md)

---

## M4-B 几何增强

> 目标：悬链线渲染 + 导线样式细分 + 塔位符号优化。

### WIRE 参数

- [ ] 解析 KVALUE（张力）、SPLIT（分裂数）参数
- [ ] 解析 POINT0/1.MATRIX0（悬挂点变换矩阵）
- [ ] 计算导线弧垂（基于张力 + 档距 + 温度）

### 悬链线

- [ ] 实现悬链线方程（`y = a * cosh(x/a)`）
- [ ] Canvas 绘制悬链线曲线（替代折线）
- [ ] 支持分裂导线（子导线间距绘制）

### 样式区分

- [ ] 按电压等级着色（500kV / 220kV / 110kV）
- [ ] 按回路数区分线型（单回 / 双回）
- [ ] OPGW 光缆特殊样式（含光缆标识）

### 塔位符号

- [ ] 基于 DEVICETYPE 细分塔型符号（直线塔/耐张塔/转角塔/终端塔）
- [ ] 转角度数标注
- [ ] 呼高标注

### 断面图（可选）

- [ ] 线路纵断面图（高程 vs 档距）
- [ ] 标注弧垂安全裕度

---

## M4-C MOD 解析

> 目标：解析 .mod 几何文件，增强塔位/设备几何展示。

### HNum / CODE

- [ ] 解析 .mod 文件中的 HNum（部件编号）/ CODE（部件代码）
- [ ] 塔位 → MOD 部件树映射
- [ ] 属性面板展示部件清单

### CROSS 补全

- [ ] 从 WIRE 节点的 STRING<i>.GPOINT 推导 CROSS 坐标
- [ ] 跨越物类型识别（电力线/通信线/道路/河流）
- [ ] 跨越角度计算

### 属性增强

- [ ] FAM 完整属性展示（设计参数 / 材料 / 荷载）
- [ ] DEV 设备信息增强（型号 / 厂家 / 参数）
- [ ] 属性搜索 + 筛选

---

## M4-D 工程化

> 目标：日志、缓存、打包、发布等工程化改进。

### 日志等级

- [x] 引入日志等级（DEBUG / INFO / WARN / ERROR） — **M3-Final 已完成**：`src/config/debug.ts` + `src/utils/logger.ts`
- [x] 运行时日志等级切换（环境变量 / 设置面板） — **M4-D1 已完成**：localStorage `GIM_DEBUG` / `GIM_DEBUG_CATEGORIES` override
- [x] 诊断快照（Ctrl+Shift+D） — **M4-D1 已完成**：复制 JSON + 控制台输出可读摘要
- [ ] 日志文件持久化（app_data_dir/logs/） — 留给后续

**M4-D1 状态：已启动 / 部分完成**

- ✅ debug override（localStorage `GIM_DEBUG=1` / `GIM_DEBUG_CATEGORIES=ifc,fragments`）
- ✅ diagnostic snapshot（Ctrl+Shift+D 复制 JSON + debug 配置）
- ✅ diagnostic summary（`summarizeDiagnostic()` 输出可读摘要到 console）

详见 [日志与诊断文档](logging-and-diagnostics.md)

### 缓存工具

- [x] 缓存管理 UI（查看 / 清除 / 导出） — **M4-D2 已完成（最小可用版）**：`src/ui/cacheManagerView.ts` modal
- [ ] Fragments 缓存启用验证（ENABLE_FRAGMENTS_CACHE=true 灰度）
- [ ] 缓存迁移工具（PARSER_VERSION 变更时自动迁移）

**M4-D2 状态：最小可用版已完成**

- ✅ Rust commands：`list_cached_projects` / `delete_project_cache` / `get_project_diagnostic`
- ✅ 前端 UI：`src/ui/cacheManagerView.ts`（数据库路径 + 项目列表 + 复制诊断 + 删除缓存）
- ✅ 入口：左侧栏"缓存管理"按钮
- ⏳ Fragments 缓存灰度 / 缓存迁移工具留给后续

### 打包发布

- [ ] portable exe 自动签名
- [ ] 版本号管理 + 更新检查
- [ ] 安装包（NSIS / MSI）

### 性能优化

- [ ] 大型线路工程 FAM/DEV 解析并行化
- [ ] SQLite 批量插入优化（事务大小调优）
- [ ] Canvas 渲染优化（脏区域重绘 / 离屏 Canvas）

### 其他

- [ ] 按塔位编号/设备名称搜索定位
- [ ] 地图截图 / 属性表格导出
- [ ] 多工程对比视图（可选）
