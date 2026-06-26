# M4 Sprint 1 总结

> 阶段：M4 Sprint 1（工程化收口 + MapLibre 技术验证）
> 时间：2026-06-26
> 前置：M3 线路 GIM 可视化 MVP + M3-Final 稳定化 + M4-D1 日志与诊断开端

---

## 1. 本轮目标

1. 增加缓存管理能力（M4-D2 最小可用版）
2. 增强诊断信息可读性（M4-D1 延伸）
3. 做 MapLibre 技术验证模块，但默认关闭（M4-A1）
4. 保持现有 Canvas 线路地图为默认主流程
5. 不破坏变电 IFC 流程

**边界**：本轮是 M4 Sprint 1，不是完整 M4。不实现 MapLibre 正式底图、PMTiles、坐标偏移、悬链线、MOD 解析、真实 3D 线路。

---

## 2. 已完成

### 2.1 缓存管理 UI（M4-D2）

**Rust 侧新增 3 个 Tauri command**（`src-tauri/src/db.rs`）：

| command | 说明 |
|---|---|
| `list_cached_projects` | 返回 `Vec<CachedProjectSummary>`（id/name/path/project_type/parser_version/size/modified_ms/updated_at_ms），按 last_opened_at DESC 排序 |
| `delete_project_cache` | 事务删除 13 张索引表 + gim_project 记录；best-effort 删除磁盘 `extracted/{id}/` 和 `fragments/{id}/` 目录 |
| `get_project_diagnostic` | 复用内部 `get_project_cache_diagnostic`，返回单个项目的完整诊断 |

注册在 `src-tauri/src/lib.rs` 的 `invoke_handler`。

**前端新增**：

- `src/desktop/database.ts`：新增 `CachedProjectSummary` 接口 + `listCachedProjects()` / `deleteProjectCache()` / `getProjectDiagnostic()` 包装
- `src/ui/cacheManagerView.ts`：缓存管理 modal（数据库路径 + 项目列表 + 复制诊断 JSON / 复制摘要 / 删除缓存按钮）
- `index.html` + `src/ui/dom.ts`：新增"缓存管理"按钮
- `src/app/bootstrap.ts`：绑定按钮点击 → `openCacheManager()`（Tauri 模式 guard）

**删除策略**：

- DB：事务删除 13 张表（gim_entry, cbm_node, ifc_model, file_dev_entry, fam_property, dev_property, line_cbm_node, line_cbm_child, line_cbm_ref, line_file_stat, line_fam_property, line_dev_property, fragment_cache）+ gim_project 记录
- 磁盘：best-effort 删除 `app_data_dir/extracted/{id}/` 和 `app_data_dir/fragments/{id}/`，失败仅警告不回滚
- 不影响其他项目（按 project_id 精确删除）

### 2.2 诊断信息增强（M4-D1 延伸）

**新增**：

- `src/services/diagnosticSummaryService.ts`：`summarizeDiagnostic(payload)` 将 `ProjectCacheDiagnostic` 转为人类可读的 Markdown 风格文本
  - 线路工程：工程类型 / 缓存状态 / parser_version / 线路节点 / FAM/DEV 源 / 缺失数 / 建议
  - 变电工程：工程类型 / 缓存状态 / parser_version / IFC entries / cached IFC / missing cache / 建议

**Ctrl+Shift+D 增强**（`src/app/bootstrap.ts`）：

- 仍复制完整 JSON 到剪贴板（dbPath + diagnostic + debug）
- 控制台额外输出 `[诊断摘要]` 可读摘要
- loading 提示仍简短

**诊断摘要示例（线路工程）**：

```text
工程类型：transmission_line
缓存状态：valid=true
parser_version：gim-parser-v5 / gim-parser-v5
线路节点：27829
线路子节点：5460
线路引用：21967
FAM 源：21967
DEV 源：4345
FAM 属性：219670
DEV 属性：43450
缺失 FAM：0
缺失 DEV：0
建议：缓存健康
```

**诊断摘要示例（变电工程）**：

```text
工程类型：substation
缓存状态：valid=true
parser_version：gim-parser-v5 / gim-parser-v5
IFC entries：12
cached IFC：12
missing cache：0
建议：缓存健康，可直接选择 IFC 加载
```

### 2.3 MapLibre 技术验证（M4-A1，默认关闭）

**依赖**：

- `npm install maplibre-gl`（~1.2 MB）
- 不引入 PMTiles、MBTiles、coordtransform

**Feature flag**（`src/config/features.ts`）：

```ts
export const ENABLE_MAPLIBRE_EXPERIMENT = false; // 默认必须为 false
```

**Probe 模块**（`src/ui/lineMapBaseLayer.ts`）：

```ts
export interface LineMapBaseLayerHandle {
  destroy(): void;
  getMap(): MapLibreMap | null;
}
export async function createMapLibreProbe(container: HTMLElement): Promise<LineMapBaseLayerHandle>;
```

- 使用本地空 style（`{ version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f8fafc' } }] }`）
- 不加载在线瓦片，不访问外网
- 等待 `load` 事件后 resolve（证明 WebGL 上下文可用）
- `destroy()` 调用 `map.remove()` + 清空挂载 div

**集成**（`src/ui/lineProjectView.ts`）：

- Canvas 地图渲染后，若 `ENABLE_MAPLIBRE_EXPERIMENT=true`，异步创建 probe
- probe 失败仅 `debugWarn`，不抛异常，不影响 Canvas 主流程
- `destroyLineMapView()` 同时销毁 Canvas handle 和 probe handle

**CSP 兼容性**：

当前 CSP 已兼容，无需修改：
- `worker-src 'self' blob:` → MapLibre blob worker 允许
- `style-src 'self' 'unsafe-inline'` → MapLibre 控件内联样式允许
- empty style 无网络请求，`connect-src` 无影响

详见 [地图底图评估 - M4-A1 技术验证结果](map-basemap-evaluation.md#13-m4-a1-技术验证结果)。

### 2.4 文档更新

- `docs/m4-roadmap.md`：M4-D1 标记"已启动/部分完成"，M4-D2 标记"最小可用版已完成"，M4-A1 标记"技术验证中"
- `docs/map-basemap-evaluation.md`：新增第 13 节"M4-A1 技术验证结果"
- `docs/m4-sprint1-summary.md`：本文档

---

## 3. 未完成（明确留给后续）

| 项 | 留给 | 原因 |
|---|---|---|
| MapLibre Canvas overlay 对接（`map.project()` 桥接） | M4-A2 | 本轮仅验证初始化/销毁，不改 Canvas 主流程 |
| PMTiles / MBTiles 离线瓦片 | M4-A2+ | 本轮禁止引入离线瓦片大包 |
| 坐标偏移（WGS84 ↔ GCJ-02） | M4-A2+ | 需要 `coordtransform`，本轮不引入 |
| Fragments 缓存灰度（ENABLE_FRAGMENTS_CACHE=true） | 后续 | 本轮禁止开启 Fragments 缓存 |
| 缓存迁移工具（PARSER_VERSION 变更时自动迁移） | 后续 | 当前策略是版本不匹配即重建，够用 |
| 日志文件持久化（app_data_dir/logs/） | 后续 | 当前 console + localStorage override 够用 |
| 悬链线渲染 | M4-B | 本轮禁止 |
| MOD 解析 | M4-C | 本轮禁止 |
| 真实 3D 线路 | 后续 | 本轮禁止 |

---

## 4. 如何验证

### 4.1 构建

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

### 4.2 线路主流程（demo-line.gim）

1. 打开 demo-line.gim → Canvas 地图正常渲染
2. 图层开关正常
3. 树↔地图联动正常
4. Ctrl+Shift+D → 剪贴板复制 JSON + console 输出可读摘要

### 4.3 变电主流程（demo-substation.gim）

1. 打开 demo-substation.gim → IFC 选择框正常
2. 选择 IFC → 几何显示正常
3. Fragments warning 不红屏（unhandledrejection 仍被 preventDefault）
4. Ctrl+Shift+D → 摘要显示 substation 缓存状态

### 4.4 缓存管理

1. 点击左侧栏"缓存管理"按钮 → modal 打开
2. 能看到 demo-line 和 demo-substation 缓存记录
3. 点击"复制诊断 JSON" → 剪贴板 + console 摘要
4. 点击"复制摘要" → 剪贴板纯文本摘要
5. 点击"删除缓存" → confirm 后删除 → 重新打开该 GIM 会重新解压和重建
6. 不误删其他项目

### 4.5 MapLibre probe

1. 默认 `ENABLE_MAPLIBRE_EXPERIMENT=false` → 打开 demo-line 行为完全不变
2. 手动改为 `true` → 打开 demo-line → Canvas 地图正常 + console 输出 `[MapLibre probe] 技术验证：probe 初始化成功`
3. 不访问外网（empty style 无网络请求）
4. 无 CSP 报错
5. 切换工程 / 清空场景 → probe 正常销毁

---

## 5. 修改文件列表

### Rust 侧

| 文件 | 变更 |
|---|---|
| `src-tauri/src/db.rs` | 新增 `CachedProjectSummary` struct + `list_cached_projects` / `delete_project_cache` / `get_project_diagnostic` 3 个 command |
| `src-tauri/src/lib.rs` | `invoke_handler` 注册 3 个新 command |

### 前端

| 文件 | 变更 |
|---|---|
| `src/config/features.ts` | 新增 `ENABLE_MAPLIBRE_EXPERIMENT = false` |
| `src/desktop/database.ts` | 新增 `CachedProjectSummary` 接口 + 3 个 invoke 包装 |
| `src/services/diagnosticSummaryService.ts` | **新建**：`summarizeDiagnostic(payload)` |
| `src/ui/cacheManagerView.ts` | **新建**：缓存管理 modal |
| `src/ui/lineMapBaseLayer.ts` | **新建**：MapLibre probe 模块 |
| `src/ui/lineProjectView.ts` | 新增 probe handle + 生命周期集成 |
| `src/ui/dom.ts` | 新增 `btnCacheManager` export |
| `src/app/bootstrap.ts` | 绑定缓存管理按钮 + Ctrl+Shift+D 增强摘要输出 |
| `index.html` | 新增"缓存管理"按钮 |

### 文档

| 文件 | 变更 |
|---|---|
| `docs/m4-roadmap.md` | 更新 M4-D1/D2/A1 状态标记 |
| `docs/map-basemap-evaluation.md` | 新增第 13 节 M4-A1 技术验证结果 |
| `docs/m4-sprint1-summary.md` | **新建**：本文档 |

### 依赖

| 包 | 版本 | 说明 |
|---|---|---|
| `maplibre-gl` | latest | MapLibre 技术验证（默认关闭，动态 import） |

---

## 6. 下一步建议

本轮完成后评审，下一步可进入：

1. **M4-D2 缓存管理增强**：Fragments 缓存灰度、缓存迁移工具、缓存大小统计
2. **M4-A2 Canvas overlay 接入**：在 probe 基础上加载 PMTiles source，Canvas overlay 改用 `map.project()`
3. **M4-B1 WIRE 参数预研**：解析 KVALUE / SPLIT / MATRIX0，为悬链线计算做准备

建议优先级：M4-D2 增强 < M4-A2 < M4-B1（视实际需求）。
