# 方案 C：MOD → glTF 离线预序列化缓存

> **状态**：已实施（2026-07-11，C-1 ~ C-6 全部完成）
>
> 关联文档：
> - [17-batch-load-schema.md](./17-batch-load-schema.md)：批量加载方案对比（方案 A/B/C）
> - [09-transform-chain-analysis.md](./09-transform-chain-analysis.md)：变换矩阵链路（顶点烘焙）
> - [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md)：FIX-1~4 修复记录

## 1. 背景与动机

### 1.1 方案 B 后的现状

方案 B（mergeGeometries 静态合并）已实施，解决了 draw call 过多（~77000 → 几十）和崩溃问题。但加载仍较慢，根因是：

- **MOD 文件零散**：一个设备涉及很多 MOD 文件（demo-substation 含 4135 个 .mod + 1803 个 .stl）
- **逐个解析**：render 时需要逐个 MOD 解析 XML → 构建 BufferGeometry → mergeGeometries
- **无持久化几何缓存**：每次打开重新解析 + 重建，与 IFC 的 `.frag` 路径形成鲜明对比

### 1.2 为什么不用 Blender / IfcOpenShell / ASSIMP

| 方案 | 体积 | 复杂度 | 评价 |
| ---- | ---- | ---- | ---- |
| Blender headless | ~300MB | 高 | ❌ 体积对 Tauri portable exe 不可接受 |
| IfcOpenShell Python | ~50MB | 中高 | ⚠️ 无成熟 WASM 构建，需捆绑 Python |
| ASSIMP | ~10MB | 中 | ❌ 不支持自定义 MOD XML 格式导入 |
| **Three.js GLTFExporter** | **0** | **低** | ✅ 零新增依赖，复用现有转换链 |

### 1.3 核心洞察

项目已有完整的 MOD XML → BufferGeometry 转换链（`xmlModGeometry.ts` 的 14 类 primitive 转换），**无需任何外部工具**，只需用 Three.js 内置的 `GLTFExporter` 把 BufferGeometry 序列化为 .glb 文件缓存。

## 2. 方案设计

### 2.1 整体流程

```text
首次打开 GIM（缓存未命中）：
  1. 解压 GIM → CBM/DEV/PHM/MOD 文件
  2. 解析 CBM 树 + DEV/PHM 索引 → 入库 SQLite
  3. 【新增】对每个 MOD 文件：
     a. parseXmlMod → XmlModDocument
     b. collectBakedGeometriesByMaterial → 按 Material 分组的 BufferGeometry[]
     c. mergeGeometries → 单个 merged BufferGeometry
     d. GLTFExporter.parse → .glb 二进制
     e. 写入 app_data_dir/{projectId}/glb/{modPath}.glb
  4. 入库 gim_entry.local_cache_path = glb 文件路径

二次打开 GIM（缓存命中）：
  1. validate_gim_cache → 命中
  2. 读取 cbm_node / dev_solid_model / ... 索引
  3. 对每个几何实例：
     a. 从 gim_entry.local_cache_path 读取 .glb
     b. GLTFLoader.parse → THREE.Group
     c. applyPlacementTransformToSceneUnits（顶点烘焙）
     d. 加入 scene
  4. 跳过全部 XML 解析 + BufferGeometry 构建
```

### 2.2 缓存粒度

**按 MOD 文件粒度缓存**（非按设备粒度）：

- 每个 MOD 文件对应一个 .glb 文件
- 同一 MOD 文件被多个设备引用时，.glb 只缓存一次
- placement matrix 不烘焙到 .glb（运行时应用，与方案 B 一致）

**理由**：
- MOD 文件级缓存复用率最高（66.2% MOD 文件被多实例引用）
- placement 是运行时数据，不应固化到缓存
- 与现有 `gim_entry` 表结构一致

### 2.3 缓存路径

```text
{app_data_dir}/{project_sha256}/glb/{modPath_with_slashes}.glb

示例：
  C:\Users\xxx\AppData\com.gim.viewer\data\abc123\glb\MOD\9e155b47-972e-4563-9ff3-dec4390bd5c9.mod.glb
```

**路径遍历防护**：modPath 已在 `gimIndexer.ts` 中验证为 `MOD/{uuid}.mod` 格式，无 `..` 组件。

### 2.4 缓存版本化

```text
PARSER_VERSION          = 'gim-parser-v14'        // GIM 解析层（已有）
GEOMETRY_CACHE_VERSION  = 'geometry-cache-v1'     // 新增，MOD→glb 序列化格式
```

失效规则：
- GIM 重解压（PARSER_VERSION 变）→ glb 缓存全部失效重建
- MOD 解析逻辑变更（如 primitive 参数提取规则改）→ GEOMETRY_CACHE_VERSION 递增，glb 缓存失效
- placement 应用逻辑变更（如顶点烘焙修复）→ 不影响 glb 缓存（placement 不固化到缓存）

### 2.5 与现有架构的集成

```text
gimIndexPersistenceService.ts（首次入库）
  ↓ 新增：调用 GLTFExporter 序列化 MOD → .glb
  ↓ gim_entry.local_cache_path = glb 文件路径

gimIndexRestoreService.ts（缓存恢复）
  ↓ 不变：读取 cbm_node / dev_solid_model / ... 索引

modAutoLoadService.ts（自动加载）
  ↓ 修改：DB 直通路径从 get_reachable_geometry 改为读取 .glb
  ↓ 文件扫描路径从 loadXmlModFromFiles 改为 GLTFLoader.parse(.glb)

nodeInteractionService.ts（节点点击懒加载）
  ↓ 修改：loadModStlForNode 从 .glb 加载（缓存命中场景）
```

## 3. 实施计划

### 3.1 阶段拆分

| 阶段 | 目标 | 改动量 | 风险 |
| ---- | ---- | ---- | ---- |
| C-1 | GLTFExporter 序列化 MOD → .glb（首次入库时） | 中 | 低 |
| C-2 | GLTFLoader 加载 .glb（缓存命中时） | 中 | 低 |
| C-3 | DB 直通路径切换到 .glb | 中 | 中 |
| C-4 | 节点点击懒加载路径切换到 .glb | 低 | 低 |
| C-5 | GEOMETRY_CACHE_VERSION 失效机制 | 低 | 低 |
| C-6 | STL 同样序列化为 .glb | 低 | 低 |

### 3.2 C-1：GLTFExporter 序列化

**文件**：新增 `src/services/glbCacheService.ts`

```typescript
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { flattenDocumentToGroup } from '../viewer/xmlModLoader.js';
import { parseXmlMod } from '../gim/geometry/xmlModParser.js';

/**
 * 把单个 MOD 文件序列化为 .glb 二进制。
 *
 * 流程：parseXmlMod → collectBakedGeometriesByMaterial → mergeGeometries → GLTFExporter
 *
 * 注意：placement matrix 不烘焙到 .glb（运行时应用）
 *       Entity.TransformMatrix + mm→m 缩放已烘焙到顶点（与方案 B 一致）
 */
export async function serializeModToGlb(
  modPath: string,
  modText: string,
  outputPath: string,
): Promise<boolean> {
  const doc = parseXmlMod(modText, modPath);
  if (doc.isEmpty) return false;

  const group = flattenDocumentToGroup(doc);
  if (group.children.length === 0) return false;

  const exporter = new GLTFExporter();
  return new Promise((resolve) => {
    exporter.parse(
      group,
      (gltf) => {
        // 写入文件（Tauri 文件系统）
        // ...
        resolve(true);
      },
      (error) => {
        console.error(`[glbCache] 序列化失败: ${modPath}`, error);
        resolve(false);
      },
      { binary: true }, // 输出 .glb 二进制
    );
  });
}
```

**集成点**：`gimIndexPersistenceService.ts` 在 `saveGimIndex` 之前，遍历所有 MOD 文件调用 `serializeModToGlb`。

### 3.3 C-2：GLTFLoader 加载

**文件**：修改 `src/services/modAutoLoadService.ts`

```typescript
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const gltfLoader = new GLTFLoader();

async function loadGlbMod(
  glbPath: string,
  glbBytes: Uint8Array,
): Promise<THREE.Group | null> {
  return new Promise((resolve) => {
    gltfLoader.parse(
      glbBytes.buffer,
      '',
      (gltf) => resolve(gltf.scene),
      (error) => {
        console.error(`[glbCache] 加载失败: ${glbPath}`, error);
        resolve(null);
      },
    );
  });
}
```

### 3.4 C-3：DB 直通路径

修改 `modAutoLoadService.ts` 的 DB 直通路径：

```typescript
// 之前：get_reachable_geometry 返回 MOD 原始字节 → loadXmlModFromFiles
// 之后：get_reachable_geometry 返回 glb 缓存路径 → 读取 .glb → GLTFLoader.parse

const glbBytes = await readCachedGlb(projectId, modPath);
const group = await loadGlbMod(modPath, glbBytes);
applyPlacementTransformToSceneUnits(group, geo.placementTransformMatrix);
```

### 3.5 C-4：节点点击懒加载

修改 `nodeInteractionService.ts` 的 `loadModStlForNode`：

```typescript
// 缓存命中场景：从 .glb 加载（跳过 XML 解析）
const glbBytes = await readCachedGlb(projectId, modPath);
const group = await loadGlbMod(modPath, glbBytes);
```

### 3.6 C-5：GEOMETRY_CACHE_VERSION

**文件**：`src-tauri/src/db.rs`

```rust
pub const GEOMETRY_CACHE_VERSION: &str = "geometry-cache-v1";

// validate_gim_cache 增加 GEOMETRY_CACHE_VERSION 检查
// 版本不匹配 → 删除 {app_data_dir}/{projectId}/glb/ 目录 → 重新序列化
```

### 3.7 C-6：STL 序列化

STL 同样序列化为 .glb：

```typescript
const group = parseStlBinary(buffer, stlPath);
// group 顶点已烘焙 mm→m（stlLoader.ts: geometry.scale(0.001,...)）
// 直接 GLTFExporter 序列化
```

## 4. 预期效果

| 指标 | 方案 B 后 | 方案 C 后（首次） | 方案 C 后（二次） |
| ---- | ---- | ---- | ---- |
| 首次打开耗时 | 分钟级 | 略增（+序列化开销） | — |
| 二次打开耗时 | 分钟级（重新解析） | — | **秒级**（跳过解析） |
| draw call | 几十 | 几十 | 几十 |
| 磁盘占用 | ~原始 XML 字节 | +glb 文件（~与 XML 相当） | 同左 |
| 新增依赖 | 0 | 0（GLTFExporter/GLTFLoader 是 Three.js 内置） | 同左 |
| 体积增加 | 0 | 0 | 同左 |

## 5. 风险与权衡

### 5.1 首次打开耗时增加

首次打开需要序列化所有 MOD → .glb，预计增加 10-30% 耗时。

**缓解**：序列化可并行（Promise.all），且与 CBM/DEV/PHM 解析并行。

### 5.2 glb 文件体积

glb 二进制可能比 XML 文本大（三角网格展开后数据量增加）。

**缓解**：
- 可选 Draco 压缩（`gltf-pipeline` 离线压缩，体积减少 ~90%）
- 但 Draco 需额外 `DRACOLoader`，增加复杂度
- MVP 阶段不压缩，后续按需引入

### 5.3 placement 不固化到缓存

placement matrix 是运行时数据，不烘焙到 .glb。这意味着：
- .glb 中的几何是 MOD 局部坐标（已烘焙 Entity.TransformMatrix + mm→m）
- 运行时仍需 `applyPlacementTransformToSceneUnits`（顶点烘焙）

**优点**：同一 .glb 可被多个 placement 实例复用
**缺点**：运行时仍有顶点烘焙开销（但远小于 XML 解析 + BufferGeometry 构建）

### 5.4 Material 序列化

GLTFExporter 会序列化 MeshStandardMaterial 为 glTF material。加载时 GLTFLoader 会重建 Material。

**注意**：加载后的 Material 不再共享（每个 .glb 独立）。但这不影响性能——Material 数量本来就是几十个（按颜色聚类），不是 78000+。

## 6. 验证清单

- [ ] 首次打开 demo-substation，`{app_data_dir}/{projectId}/glb/` 下生成 4135 个 .glb
- [ ] `gim_entry.local_cache_path` 正确记录 .glb 路径
- [ ] 二次打开 demo-substation，跳过 XML 解析，秒级渲染
- [ ] MOD 位置与方案 B 一致（顶点烘焙修复保留）
- [ ] 节点点击懒加载正确加载 .glb
- [ ] 项目切换时 glb 缓存正确清理
- [ ] PARSER_VERSION 变更时 glb 缓存失效重建
- [ ] GEOMETRY_CACHE_VERSION 变更时 glb 缓存失效重建

## 7. 实施顺序

```text
1. C-1：glbCacheService.ts（GLTFExporter 序列化）+ gimIndexPersistenceService 集成
2. C-2：modAutoLoadService.ts 文件扫描路径切换到 .glb
3. C-3：modAutoLoadService.ts DB 直通路径切换到 .glb
4. C-4：nodeInteractionService.ts 节点点击路径切换到 .glb
5. C-5：db.rs GEOMETRY_CACHE_VERSION 失效机制
6. C-6：STL 同样序列化为 .glb
7. 验证 + 文档更新
```

## 8. 决策点

### 8.1 是否需要 Draco 压缩？

**MVP 决策**：不压缩。磁盘空间不是瓶颈，Draco 增加复杂度。

**后续**：如磁盘占用成问题，引入 `gltf-pipeline` 离线 Draco 压缩。

### 8.2 是否需要 Worker 化序列化？

**MVP 决策**：不 Worker 化。GLTFExporter 是同步的，但单 MOD 序列化耗时 < 10ms，主线程可接受。

**后续**：如首次打开耗时成问题，序列化移到 Worker。

### 8.3 是否替换方案 B 的运行时路径？

**MVP 决策**：保留方案 B 的运行时路径作为 fallback。缓存未命中时仍走 XML 解析 + mergeGeometries。

**后续**：如 .glb 缓存稳定，可移除运行时 XML 解析路径，简化代码。

## 9. 实施记录（2026-07-11）

C-1 ~ C-6 全部完成，TypeScript 编译 + Rust cargo check 通过。

### 9.1 实际落地的文件清单

| 阶段 | 文件 | 变更 |
| ---- | ---- | ---- |
| C-1 | `src/services/glbCacheService.ts` | 新建：`serializeModToGlb` / `serializeStlGroupToGlb` / `cacheGlbFiles` / `loadGlbMod` / `loadModWithGlbFallback` / `loadGlbStl` |
| C-1 | `src-tauri/src/db.rs` | 新增 `glb_cache_file_path` + 4 个 Tauri 命令（`write_glb_file` / `read_glb_file` / `glb_file_exists` / `batch_read_glb_files`） |
| C-1 | `src-tauri/src/lib.rs` | 注册新命令 |
| C-1 | `src/desktop/database.ts` | 新增 TS 包装（`writeGlbFile` / `readGlbFile` / `glbFileExists` / `batchReadGlbFiles`） |
| C-1 | `src/services/openGimService.ts` | 首次打开流程末尾调用 `cacheGlbFiles` |
| C-2 | `src/services/modAutoLoadService.ts` | 新增 `loadModFileWithGlb`；Phase 3（文件扫描路径）预读 GLB 后切换加载 |
| C-3 | `src/services/modAutoLoadService.ts` | Phase 1.5（DB 直通路径）批量读 GLB，未命中回退 XML |
| C-4 | `src/services/nodeInteractionService.ts` | `loadModStlForNode` 改为 GLB 优先 + XML 回退 |
| C-5 | `src-tauri/src/db.rs` | 新增 `GEOMETRY_CACHE_VERSION` 常量 + `check_geometry_cache_version` helper + `write_geometry_cache_version` 命令；`validate_gim_cache` 增加 `geometry_cache_version_match` 字段并参与 `valid` 判定 |
| C-5 | `src-tauri/src/lib.rs` | 注册 `write_geometry_cache_version` |
| C-5 | `src/desktop/database.ts` | 新增 `writeGeometryCacheVersion` TS 包装 + `GimCacheValidation` 接口新增两个字段 |
| C-5 | `src/services/glbCacheService.ts` | `cacheGlbFiles` 末尾写入版本标记文件 |
| C-6 | `src/services/glbCacheService.ts` | `cacheGlbFiles` 扩展 STL 序列化循环；新增 `loadGlbStl` |
| C-6 | `src/services/modAutoLoadService.ts` | 新增 `loadStlFileWithGlb`；Phase 1.5 + Phase 4（STL 加载）切换到 GLB 优先 |
| C-6 | `src/services/nodeInteractionService.ts` | STL 加载循环改为 GLB 优先 + `parseStlBinary` 回退 |

### 9.2 与原设计的偏差

1. **缓存路径**：原设计 `app_data_dir/{projectId}/glb/`，实际落地为 `app_data_dir/glbcache/{projectId}/`（与 `extracted/` / `fragments/` 同层独立目录）
2. **版本标记**：原设计未明确存储方式，实际采用 marker 文件 `glbcache/{projectId}/_version.txt`（避免修改 SQLite schema，符合"Do not modify SQLite schema"约束）
3. **GLB 优先策略**：所有加载路径（首次打开 / 缓存命中 / 节点点击）统一采用"GLB 优先 + XML/STL 回退"，保证缓存损坏时不阻断渲染
4. **STL 缓存粒度**：按 STL 文件粒度缓存（与 MOD 一致），同一 STL 被多实例引用时只序列化一次

### 9.3 验证状态

- ✅ TypeScript 编译通过（`npx tsc --noEmit`）
- ✅ Rust cargo check 通过
- ⏳ 实际运行验证（首次打开序列化、二次打开秒开、位置一致性、版本失效）待用户在 demo-substation 上手动验证

### 9.4 验证清单（运行时）

- [ ] 首次打开 demo-substation，`{app_data_dir}/glbcache/{projectId}/` 下生成 4135 个 .glb + 1803 个 .glb（STL）+ 1 个 `_version.txt`
- [ ] 二次打开 demo-substation，跳过 XML 解析，秒级渲染
- [ ] MOD/STL 位置与方案 B 一致（顶点烘焙修复保留）
- [ ] 节点点击懒加载正确加载 .glb
- [ ] 项目切换时 glb 缓存正确清理（`delete_project_cache`）
- [ ] `PARSER_VERSION` 变更时 glb 缓存失效重建（`delete_project_cache` 删除 glbcache 目录）
- [ ] `GEOMETRY_CACHE_VERSION` 变更时 glb 缓存失效重建（`validate_gim_cache` 返回 invalid → 触发 `delete_project_cache` + 重序列化）

## 10. 设计变更：MOD 粒度 → DEV 粒度（2026-07-11 v2）

### 10.1 问题

C-1~C-6 实施后，首次打开 demo-substation 生成了 4179 个 MOD .glb + 1803 个 STL .glb。
二次打开时仍需逐个加载 5982 个 .glb，**加载次数没有减少**，相比方案 B（XML 解析）无明显加速。

### 10.2 新设计：按 DEV 文件粒度缓存

**核心思路**：一个 DEV 引用的所有 MOD + STL 预编译合并成一个 .glb。

| 维度 | 旧设计（MOD 粒度） | 新设计（DEV 粒度） |
| ---- | ---- | ---- |
| 缓存 key | MOD 文件路径（`MOD/abc.mod`） | DEV 文件路径（`DEV/abc.dev`） |
| .glb 数量 | 4179 + 1803 = 5982 | ~数百（DEV 去重后） |
| 加载次数 | 5982 次 GLB 解析 | ~数百次 GLB 解析 |
| .glb 内容 | 单个 MOD 的几何 | DEV 递归展开的所有 MOD + STL 合并 |

### 10.3 placement 烘焙策略

**序列化时**（`serializeDevToGlb`）：
- `discoverGeometriesFromDevPath(devPath, files, IDENTITY_MATRIX)` 获取 DEV 内部几何
- `placementTransformMatrix` = DEV × PHM（不含 CBM）
- `applyPlacementTransformToSceneUnits(placementTransformMatrix)` 烘焙到顶点（含 mm→m）
- 所有 MOD + STL Group 合并到 `devGroup`
- 序列化 `devGroup` → .glb

**加载时**：
- 从 CBM seed 节点获取 devPath + CBM 累积矩阵
- 加载 `dev/{devPath}.glb`
- `applyPlacementTransformToSceneUnits(cbmTransformMatrix)` 应用 CBM 矩阵（含 mm→m）
- `applyProjectSourceToViewer` 应用项目级坐标转换

### 10.4 数学等价性证明

**原始方案 B**（一次应用 CBM × DEV × PHM）：
```
v_final = (CBM × DEV × PHM) × v   （平移 ×0.001）
```

**新方案**（两次应用）：
```
序列化时：v' = (DEV × PHM) × v   （平移 ×0.001）
加载时：  v'' = CBM × v'         （平移 ×0.001）
```

展开：
```
v'' = CBM × ((DEV × PHM) × v)
    = (CBM × DEV × PHM) × v
```

平移部分展开（设 R 为旋转，t 为平移）：
```
原始：t_combined = R_cbm × R_dev × t_phm + R_cbm × t_dev + t_cbm
      t_combined × 0.001

新方案：
  序列化：t_dev_phm = R_dev × t_phm + t_dev，×0.001
  加载：  t_cbm ×0.001
  合并：  R_cbm × (t_dev_phm × 0.001) + t_cbm × 0.001
        = R_cbm × (R_dev × t_phm + t_dev) × 0.001 + t_cbm × 0.001
        = (R_cbm × R_dev × t_phm + R_cbm × t_dev + t_cbm) × 0.001
        = t_combined × 0.001 ✓
```

两次 `applyPlacementTransformToSceneUnits`（各 ×0.001）与一次完整应用**完全等价**。

### 10.5 实施计划

| 阶段 | 内容 |
| ---- | ---- |
| D-1 | `modGeometryDiscovery.ts` 导出 `discoverGeometriesFromDevPath` |
| D-2 | `glbCacheService.ts` 新增 `serializeDevToGlb` + `loadDevGlb`；重写 `cacheGlbFiles` 接收 `devPaths` |
| D-3 | `openGimService.ts` 收集 CBM seed devPaths 传给 `cacheGlbFiles` |
| D-4 | `modAutoLoadService.ts` 重写 Phase 1.5/3：按 seed 加载 DEV.glb |
| D-5 | `nodeInteractionService.ts` 重写 `loadModStlForNode`：按 DEV 加载 |
| D-6 | 验证 + 文档更新 |
