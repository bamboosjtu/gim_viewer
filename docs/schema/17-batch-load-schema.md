# MOD/STL 批量加载与中间态缓存设计

> 本文档针对 GIM 变电工程中 MOD/STL 文件数量大（demo-substation 含 4135 个 .mod + 1803 个 .stl）、当前"逐文件串行解析 + 重建几何"管线慢的问题，调研现有批量加载方案，给出中间态缓存（文件 + SQLite）的设计建议。
>
> 关联文档：
> - [09-transform-chain-analysis.md](./09-transform-chain-analysis.md)：完整变换链分析（MOD 实例 placement 累乘）
> - [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md)：已知 bug 与改进方向
> - [10-substation-mod-grammar.md](./10-substation-mod-grammar.md)：MOD XML 语法
> - [gim_substation.md](../gim_substation.md)：GIM 工程结构

## 1. 问题背景

### 1.1 现状对比

| 维度 | IFC 加载 | MOD/STL 加载 |
| ---- | -------- | ------------ |
| 文件数（demo-substation） | 12 个 IFC | 4135 .mod + 1803 .stl |
| 解析方式 | web-ifc WASM 流式 STEP 解析 | DOMParser 同步 XML DOM 构建 |
| 几何构造 | Fragments 批量 GPU-ready | 每 primitive 一个 Mesh + Material |
| 持久缓存 | `.frag` 二进制（FlatBuffers）+ SQLite 索引 | 仅缓存原始 XML/STL 字节 |
| 缓存命中后 | 直接反序列化 .frag，跳过解析 | 重新解析 XML、重建 BufferGeometry |
| 单文件加载耗时 | ~50–200ms（含 WASM 启动） | ~5–50ms（DOMParser + Mesh 构造） |
| 总耗时（demo-substation） | <2 秒（含 .frag 缓存） | **数十秒到数分钟** |

### 1.2 性能瓶颈定位

参考 [_generated/transform-matrix-instance-analysis-demo-substation.json](./_generated/transform-matrix-instance-analysis-demo-substation.json) 的实例统计：

- **唯一 MOD/STL 文件**：5938 个
- **链路重建后实例**：9866 个（修复 [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md) 问题 1 后）
- **平均每 MOD 文件 primitive 数**：~5 个 Entity（来自 09 号文档 §5.1：46250 Entity / 4135 MOD ≈ 11.2）
- **预估总 Mesh 数**：9866 实例 × 11 Entity ≈ 108k Mesh

按 [modAutoLoadService.ts:39-46](../../src/services/modAutoLoadService.ts#L39-L46) 的常量与 [modAutoLoadService.ts:670-709](../../src/services/modAutoLoadService.ts#L670-L709) 的批循环：

```text
CONCURRENCY = 4         // 批大小
YIELD_MS    = 16        // 批间 yield
// 关键：内层 for (const geo of batch) with await loadModFile 是串行
//      没有 Promise.all，CONCURRENCY 实际退化为"批间不 yield"
```

按瓶颈贡献度排序：

1. **每 primitive 一个 Mesh + Material**（最大瓶颈）：~108k Mesh × ~100 三角面 ≈ 10.8M 三角面，但 ~108k draw call 才是真正杀手（60fps 预算 ~2k draw call）
2. **DOMParser 同步 XML 解析**：每 MOD 文件构建完整 DOM 树，~4n 次 querySelectorAll 树遍历（n = Entity 数）
3. **无持久化几何缓存**：每次打开重新解析 + 重建，与 IFC 的 `.frag` 路径形成鲜明对比
4. **假并发**：`CONCURRENCY=4` 实际是串行，未利用 `Promise.all`
5. **批间 yield 过粗**：4 文件全跑完才 yield，单批 200ms 阻塞主线程

### 1.3 设计目标

```text
1. 首次打开（缓存未命中）：将数千 MOD/STL 的解析+几何构造从分钟级降到秒级
2. 二次打开（缓存命中）：直接反序列化中间态，跳过解析与几何构造，秒级渲染
3. 主线程不阻塞：解析与几何构造移到 Worker，UI 响应延迟 < 50ms
4. GPU 资源受控：draw call 数从 ~108k 降到 ~1k 量级（合并/批渲染）
5. 缓存版本化：parser_version 失效后自动重建，与现有 IFC .frag 缓存机制一致
```

---

## 2. 调研：现有批量加载方案

### 2.1 Three.js 几何合并方案对比

| 方案 | 适用场景 | 三角面/draw call | 拾取 | 动态 | Three.js 版本 |
| ---- | -------- | --------------- | ---- | ---- | ------------- |
| 每 Mesh 独立 | 异构、需独立拾取 | N faces / N draw | 原生 raycast | 支持 | 任意 |
| `mergeGeometries` | 静态异构、无需独立拾取 | N faces / 1 draw | `face.materialIndex` | 重建 | r125+ |
| `InstancedMesh` | 同形状重复（如 N 个同型绝缘子） | N×M faces / 1 draw | `intersection.instanceId` | `setMatrixAt` | r118+ |
| `BatchedMesh` | 静态异构、需 per-instance 可见性/剔除 | N faces / multi-draw | per-instance | `addInstance`/`deleteGeometry` | **r163+** |

**对 GIM MOD 的适用性分析**：

| 场景 | 推荐方案 | 理由 |
| ---- | -------- | ---- |
| 同型设备多实例（如同型绝缘子 100 个） | `InstancedMesh` | 同形状 + 不同 placement，draw call 从 100 → 1 |
| 单 MOD 文件内多 primitive（Cylinder/Cuboid/Sphere 混合） | `mergeGeometries` 或 `BatchedMesh` | 静态异构，无需独立拾取 |
| 跨 MOD 文件同型 primitive 批量 | `InstancedMesh`（按 primitive 类型分组） | 6 种 primitive → 6 个 InstancedMesh，覆盖全部 100k+ Entity |
| 节点点击高亮 | `InstancedMesh` + `instanceId` 拾取 | 已支持 per-instance 高亮 |

### 2.2 缓存格式对比

| 格式 | 编码 | 解码耗时 | 压缩比 | 三方库依赖 | 跨平台 |
| ---- | ---- | -------- | ------ | ---------- | ------ |
| 原始 XML/STL 字节（现状） | 文本/二进制 | 慢（DOMParser） | 1× | 无 | 是 |
| `.frag`（FlatBuffers） | 二进制 | 快（零拷贝） | ~5× | `@thatopen/fragments` | 是 |
| `.glb`（uncompressed） | 二进制 | 中（GLTFLoader） | ~1.5× | `GLTFLoader` | 是 |
| `.glb` + Draco | 二进制 | 慢（WASM 解码） | ~10–20× | `DRACOLoader` + WASM | 是 |
| `.glb` + MESHOPT | 二进制 | 中快 | ~5× | `MESHOPTLoader` | 是 |
| 序列化 BufferGeometry | 二进制（自定义） | 极快（直接 Float32Array） | 1× | 无 | 是 |
| SQLite BLOB（< 100KB） | 二进制 | 中 | 1× | rusqlite | 是 |

**结论**：

- **桌面 Tauri 本地磁盘 IO 不是瓶颈**：Draco 解码成本 > 本地 SSD 读取成本，Draco 仅在网络场景才划算
- **`.frag` 与现有 IFC 缓存对齐**：本项目已用 `@thatopen/fragments`，复用同一格式可避免引入新依赖
- **小几何（< 100KB）SQLite BLOB 可接受**：但 GIM 单个 MOD 实例几何通常 1–50KB，跨实例合并后 50KB–2MB，处于 SQLite 官方建议的"文件存储"区间

### 2.3 Worker 化解析

**GIM 解析器纯函数特性**（来自代码调研）：

- `cbmParser.ts`、`famParser.ts`、`fileDevParser.ts`、`xmlModParser.ts` 均为纯 `Map<path, File> → 结构化数据` 变换，无 DOM、无 Three.js 依赖
- `BufferGeometry` 构造（`xmlModGeometry.ts`）也是纯数据对象，`BufferAttribute.array` 为 `TypedArray`，可通过 `postMessage` transferList 零拷贝传输
- `WebGLRenderer` 必须主线程，但**几何构造可全在 Worker**

**推荐分层**：

```text
Worker 1（XML/CBM/FAM/DEV 解析）→ 输出结构化 IR
  ↓ postMessage（transferList: ArrayBuffer）
Worker 2（几何构造）→ 输出 BufferGeometry + BufferAttribute
  ↓ postMessage（transferList: TypedArray.buffer）
主线程（渲染）→ 把 BufferGeometry 加到 Scene
```

### 2.4 SQLite 内部 vs 外部 BLOB

SQLite 官方文档（[sqlite.org/intern-v-extern-blob.html](https://www.sqlite.org/intern-v-extern-blob.html)）：

- **BLOB < 100KB**：SQLite 内部存储可接受，甚至更快（单事务 + 索引查询）
- **BLOB > 100KB**：SQLite 推荐文件存储 + DB 仅存路径
- **GIM 现状**：IFC 字节已走文件路径（`gim_entry.local_cache_path`）+ SQLite 索引，符合官方建议

### 2.5 现有 IFC `.frag` 缓存模式（参考标杆）

来自 [db.rs:848-941](../../src-tauri/src/db.rs#L848-L941) 与 [ifcEntryLoader.ts:171-254](../../src/viewer/ifcEntryLoader.ts#L171-L254)：

```text
首次加载：
  IFC 字节 → web-ifc WASM 解析 → Fragments 模型（内存）
  → 序列化为 .frag 字节 → 写入 app_data_dir/fragments/{projectId}/{entryPath}.frag
  → fragment_cache 表记录 (entry_path, fragments_version, frag_path)

二次加载（缓存命中）：
  读 .frag 字节 → ctx.fragments.core.load(fragBytes) → Fragments 模型（内存）
  跳过 web-ifc 解析与几何构造
```

**关键特征**：

- **版本化**：`fragments_version = "fragments-cache-v4"`，版本不匹配则重建
- **按 IFC 文件粒度**：一个 IFC 一个 .frag，独立读写、独立失效
- **零拷贝反序列化**：FlatBuffers 直接索引到字段，无需完整解码
- **跨平台**：FlatBuffers schema 公开（[engine_fragment flatbuffers/index.fbs](https://github.com/ThatOpen/engine_fragment/blob/main/packages/fragments/flatbuffers/index.fbs)），未来可在 Rust 侧序列化

---

## 3. 设计：MOD/STL 中间态缓存方案

### 3.1 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                     主线程（渲染）                            │
│   Scene ← Group ← BatchedMesh / InstancedMesh                │
└───────────────────────────────▲─────────────────────────────┘
                                │ postMessage（BufferGeometry）
┌───────────────────────────────┴─────────────────────────────┐
│                  Worker（几何构造）                          │
│   IR（结构化 primitive 列表） → InstancedMesh 数据            │
│   → 序列化为 ArrayBuffer                                      │
└───────────────────────────────▲─────────────────────────────┘
                                │ postMessage（transferList）
┌───────────────────────────────┴─────────────────────────────┐
│                  Worker（XML 解析）                          │
│   XML 字节 / CBM / DEV / PHM → 结构化 IR                     │
└───────────────────────────────▲─────────────────────────────┘
                                │ Tauri IPC（batchReadCachedFiles）
┌───────────────────────────────┴─────────────────────────────┐
│           Tauri Rust 后端（SQLite + 文件缓存）                │
│   gim_entry / cbm_node / dev_solid_model / phm_solid_model   │
│   geometry_cache（新表） / geometry_blob（文件）              │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 缓存分层

| 层级 | 存储介质 | 内容 | 粒度 | 失效键 |
| ---- | -------- | ---- | ---- | ------ |
| L1 内存 | `state.loadedInstancedMeshes` | 已加载的 InstancedMesh | 按 primitive 类型分组 | 项目切换 |
| L2 文件 | `app_data_dir/geometry/{projectId}/` | 序列化 BufferGeometry 字节 | 按 (modPath, primitive type) | `geometry_cache_version` |
| L3 SQLite | `geometry_cache` 表 | 元数据 + 小几何 BLOB（< 100KB） | 同 L2 | `geometry_cache_version` |
| L4 原始 | `gim_entry` + `extracted/` | 原始 MOD XML / STL 字节 | 按 entry_path | `parser_version` |

**L2 与 L3 选择规则**（遵循 SQLite 官方建议）：

```text
序列化后字节 < 100KB → SQLite BLOB（geometry_cache.blob）
序列化后字节 ≥ 100KB → 文件（geometry_cache.blob_path 指向 app_data_dir/geometry/{projectId}/xxx.bin）
```

### 3.3 缓存键设计

**键 = `(modPath, primitiveType, geometryHash)`**

- `modPath`：MOD 文件在 GIM 内的相对路径（如 `MOD/72c8865f-*.mod`）
- `primitiveType`：6 种之一（Cylinder/Cuboid/Sphere/TruncatedCone/Ring/CircularGasket）
- `geometryHash`：对 primitive 参数（半径、高度、分段数等）的 SHA256 前 8 字节

**为什么不用 `instanceKey`**：

- `instanceKey` 含 placement，但几何形状与 placement 无关
- 同 MOD 文件多实例共享同一份几何数据，仅 placement 矩阵不同
- placement 由 `InstancedMesh.setMatrixAt` 单独管理，不进入缓存键

### 3.4 序列化格式（自定义二进制）

```text
Magic       : 4 字节  'GMGC' (GIM Geometry Cache)
Version     : 2 字节  uint16 LE  当前 = 1
PrimitiveType : 1 字节  enum (0=Cylinder, 1=Cuboid, ...)
Reserved    : 1 字节  0
VertexCount : 4 字节  uint32 LE
IndexCount  : 4 字节  uint32 LE  (0 = non-indexed)
AttrCount   : 1 字节  属性数量（通常 = 2: position + normal）
Attr[0]:
  NameLen   : 1 字节
  Name      : NameLen 字节  "position"
  ItemSize  : 1 字节  3
  ByteLen   : 4 字节  uint32 LE  = VertexCount × ItemSize × 4
  Data      : ByteLen 字节  Float32Array
Attr[1]:
  Name      : "normal"
  ...
Index（若 IndexCount > 0）:
  ByteLen   : 4 字节  = IndexCount × 4
  Data      : Uint32Array
```

**优点**：

- 极简，无三方依赖
- 反序列化零拷贝：直接 `new Float32Array(buffer.slice(offset, offset + ByteLen))`
- 比 `.frag` 更轻（不含 properties/relations，仅几何）

### 3.5 SQLite 表结构

新增 `geometry_cache` 表（[db.rs](../../src-tauri/src/db.rs)）：

```sql
CREATE TABLE IF NOT EXISTS geometry_cache (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL,
  cache_key       TEXT    NOT NULL,          -- modPath + '#' + primitiveType + '#' + geometryHash
  mod_path        TEXT    NOT NULL,
  primitive_type  TEXT    NOT NULL,
  geometry_hash   TEXT    NOT NULL,
  vertex_count    INTEGER NOT NULL,
  index_count     INTEGER NOT NULL,
  byte_size       INTEGER NOT NULL,
  storage_mode    TEXT    NOT NULL,          -- 'inline' | 'file'
  inline_blob     BLOB,                      -- storage_mode='inline' 时使用
  blob_path       TEXT,                       -- storage_mode='file' 时使用
  cache_version   TEXT    NOT NULL,          -- 'geometry-cache-v1'
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES gim_project(id),
  UNIQUE (project_id, cache_key)
);
CREATE INDEX idx_geometry_cache_project ON geometry_cache(project_id);
CREATE INDEX idx_geometry_cache_mod ON geometry_cache(project_id, mod_path);
```

**新增 Tauri 命令**：

```text
get_geometry_cache_batch(project_id, cache_keys: Vec<String>)
  → 一次返回多个 (cache_key, storage_mode, inline_blob 或 blob_path)
  → 配合 batchReadCachedFiles 实现"几何缓存未命中 → 原始字节回退"两步查询

write_geometry_cache_batch(project_id, entries: Vec<GeometryCacheEntry>)
  → 单事务批量写入，原子化

invalidate_geometry_cache(project_id, new_version)
  → DELETE WHERE project_id=? AND cache_version != ?
```

### 3.6 加载流程（缓存命中优先）

```text
autoLoadModAndStlGeometry(state, scene)
  │
  ├─ Phase 1: 查询可达几何（已有，get_reachable_geometry）
  │   返回 Vec<ReachableGeometry>，含 (modPath, instanceKey, placementMatrix)
  │
  ├─ Phase 2: 几何缓存批量查询（新）
  │   cache_keys = unique(geometries.map(g => makeCacheKey(g.modPath, inferType(g))))
  │   cache_hits = await get_geometry_cache_batch(project_id, cache_keys)
  │   → 命中项直接反序列化 BufferGeometry
  │   → 未命中项进入 Phase 3
  │
  ├─ Phase 3: 未命中批量加载（Worker 化）
  │   miss_entries = batchReadCachedFiles(miss_mod_paths)
  │   parsed_ir = await parseModXmlInWorker(miss_entries)        // Worker 1
  │   geometry_data = await buildGeometryInWorker(parsed_ir)     // Worker 2
  │   → 同时写回 geometry_cache（L2/L3）供下次命中
  │
  ├─ Phase 4: InstancedMesh 装配（主线程）
  │   按 primitiveType 分组：
  │     cylinderMesh = new InstancedMesh(cylinderGeom, material, cylinderCount)
  │     cuboidMesh   = new InstancedMesh(cuboidGeom, material, cuboidCount)
  │     ...
  │   for each instance:
  │     cylinderMesh.setMatrixAt(idx, placementMatrix)
  │     cylinderMesh.setColorAt(idx, color)
  │   scene.add(cylinderMesh, cuboidMesh, ...)
  │
  └─ Phase 5: 完成
      state.loadedInstancedMeshes.set(primitiveType, mesh)
      总 draw call 从 ~108k 降到 6（按 6 种 primitive）
```

### 3.7 估算改进效果

| 指标 | 现状 | 改进后（缓存未命中） | 改进后（缓存命中） |
| ---- | ---- | ------------------- | ----------------- |
| 主线程阻塞 | 数十秒～数分钟 | < 1 秒（Worker 化） | < 200ms（直接反序列化） |
| Draw call 数 | ~108k | ~6 | ~6 |
| 三角面数 | ~10.8M | ~10.8M（不变） | ~10.8M（不变） |
| 内存占用 | ~500MB（含 DOM 残留） | ~300MB（无 DOM） | ~300MB |
| 解析次数 | 每次打开全量 | 首次全量，之后跳过 | 0 |
| 缓存大小 | 原始 XML ~150MB | 序列化几何 ~300MB | 序列化几何 ~300MB |

---

## 4. Worker 化解析管线设计

### 4.1 Worker 分层

```text
src/workers/
  ├─ xmlModParser.worker.ts     # MOD XML → IR
  ├─ geometryBuilder.worker.ts  # IR → BufferGeometry bytes
  └─ workerPool.ts              # 通用 Worker 池
```

### 4.2 xmlModParser.worker.ts

**输入**：`{ modPath: string, xmlBytes: ArrayBuffer }`（transferList: `[xmlBytes]`）

**输出**：`{ modPath: string, entities: ParsedEntity[] }`，其中：

```typescript
interface ParsedEntity {
  entityIndex: number;
  transformMatrix: number[16];   // 16 floats
  color: { r: number; g: number; b: number; a: number };
  primitive: {
    type: 'Cylinder' | 'Cuboid' | 'Sphere' | 'TruncatedCone' | 'Ring' | 'CircularGasket';
    params: number[];            // 半径、高度、分段等
  };
}
```

**优化点**：

- 用 `fast-xml-parser`（SAX 风格，无 DOM 分配）替代 `DOMParser`，~3–5× 速度提升
- 或保留 `DOMParser` 但在 Worker 中运行（DOM API 在 Worker 可用）
- primitive 参数直接抽取，不做 BufferGeometry 构造

### 4.3 geometryBuilder.worker.ts

**输入**：`{ entities: ParsedEntity[] }`

**输出**：`{ geometryBytes: ArrayBuffer, metadata: GeometryMetadata }`（transferList: `[geometryBytes]`），其中：

```typescript
interface GeometryMetadata {
  primitiveType: string;
  vertexCount: number;
  indexCount: number;
  geometryHash: string;          // 对 params 的 SHA256 前 8 字节
}
```

**逻辑**：

- 按 primitiveType 分组 entities
- 同 type + 同 params（hash 相同）共享一个 BufferGeometry
- 不同 params（如不同半径的 Cylinder）分别构造
- 输出按 [§3.4](#34-序列化格式自定义二进制) 格式序列化的字节流

### 4.4 Worker 池调度

参考 [Three.js WorkerPool](https://threejs.org/docs/?q=WorkerPool#WorkerPool)：

```typescript
// 伪代码
const pool = new WorkerPool({
  maxWorkers: navigator.hardwareConcurrency || 4,
  workerFactory: () => new Worker(new URL('./xmlModParser.worker.ts', import.meta.url), { type: 'module' }),
});

// 批量派发
const tasks = modPaths.map(path => ({
  type: 'parseModXml',
  payload: { modPath: path, xmlBytes: bytesForPath(path) },
  transferList: [bytesForPath(path)],
}));
const results = await pool.runBatch(tasks);
```

**关键**：

- 每个任务自带 `transferList`，零拷贝传输
- Worker 池自动负载均衡，避免单 Worker 队列积压
- 项目切换时 `pool.dispose()` 终止所有 Worker

---

## 5. 几何渲染优化：InstancedMesh 方案

### 5.1 分组策略

按 primitive 类型分组（demo-substation 6 种）：

```text
Group 1: Cylinder        (实例数 ~30k)
Group 2: Cuboid          (实例数 ~20k)
Group 3: Sphere          (实例数 ~5k)
Group 4: TruncatedCone   (实例数 ~3k)
Group 5: Ring            (实例数 ~2k)
Group 6: CircularGasket  (实例数 ~2k)
```

**总计 6 个 InstancedMesh，6 个 draw call**（vs. 现状 ~108k draw call）。

### 5.2 几何形状合并（同 type 不同 params）

**问题**：同是 Cylinder，但半径/高度不同，不能直接共享同一 BufferGeometry。

**方案 A**：按 params 聚类，相同 params 共享 geometry（最简单）

```text
Cylinder-params-hash-A (半径 50mm, 高 200mm) → InstancedMesh-A (count=5000)
Cylinder-params-hash-B (半径 80mm, 高 300mm) → InstancedMesh-B (count=2000)
...
```

**方案 B**：所有 Cylinder 共享单位 Cylinder，通过 per-instance matrix 缩放

```text
unitCylinder = CylinderGeometry(1, 1, 1, 16)
instancedMesh = new InstancedMesh(unitCylinder, material, count)
for each instance:
  scaleMatrix = compose(translation, rotation, scale(r, r, h))
  instancedMesh.setMatrixAt(i, scaleMatrix × placementMatrix)
```

**推荐方案 B**：几何形状归一化，draw call 数稳定为 6，与 params 多样性无关。

### 5.3 Per-instance 数据

```typescript
interface InstanceData {
  matrix: THREE.Matrix4;        // placement × scale（含 MOD Entity.TransformMatrix）
  color: THREE.Color;           // 来自 MOD XML <Color>
  modPath: string;              // 用于点击拾取后查询 CBM 节点
  entityId: number;             // MOD Entity ID
}
```

**InstancedMesh API**：

- `setMatrixAt(i, matrix)` —— 设置变换
- `setColorAt(i, color)` —— 设置颜色
- `instanceMatrix.needsUpdate = true` —— 提交 GPU
- `instanceColor.needsUpdate = true` —— 提交颜色

**自定义 per-instance 数据**（modPath/entityId）：使用 `InstancedBufferAttribute` 附加：

```typescript
const modPathAttr = new THREE.InstancedBufferAttribute(
  new Float32Array(count * 4),  // 编码为 vec4（hash → uint32）
  4,
);
instancedMesh.geometry.setAttribute('aModPathHash', modPathAttr);
```

### 5.4 拾取高亮

**当前**（[highlight.ts](../../src/viewer/highlight.ts)）：`raycaster.intersectObjects(scene.children)`，返回 mesh，从 mesh.userData 取 CBM 节点信息。

**改造后**：

```typescript
const intersects = raycaster.intersectObject(instancedMesh);
if (intersects.length > 0) {
  const instanceId = intersects[0].instanceId;
  const modPathHash = modPathAttr.getX(instanceId);
  const modPath = hashToModPath.get(modPathHash);
  highlightInstance(instancedMesh, instanceId);   // per-instance 高亮
  // 触发 CBM 节点选中、属性面板更新等
}
```

**高亮实现**：

- 备份原色：`const origColor = instancedMesh.instanceColor.getX(instanceId)`
- 临时改色：`instancedMesh.instanceColor.setRGB(1, 0.5, 0).setY(instanceId)`
- 还原：`instancedMesh.instanceColor.setX(instanceId, origColor)`

### 5.5 可见性控制

**MOD 文件级隐藏**（如隐藏某 CBM 节点对应的所有 Entity）：

```typescript
function setModVisible(modPath: string, visible: boolean) {
  const instanceIds = modPathToInstanceIds.get(modPath);
  for (const id of instanceIds) {
    instancedMesh.setVisibilityAt?.(id, visible);  // 注意：InstancedMesh 无此 API
    // 替代方案：缩放为 0
    const m = new THREE.Matrix4();
    instancedMesh.getMatrixAt(id, m);
    if (!visible) m.scale(new THREE.Vector3(0, 0, 0));
    instancedMesh.setMatrixAt(id, m);
  }
  instancedMesh.instanceMatrix.needsUpdate = true;
}
```

> 注：`InstancedMesh` 原生不支持 per-instance visibility，缩放为 0 是常用 workaround。若 Three.js ≥ r163，建议改用 `BatchedMesh`（原生 `setVisibleAt`）。

---

## 6. STL 批量加载

### 6.1 STL 特性

- 已是二进制，无需 XML 解析
- 单文件单一 Mesh，无 Entity 概念
- 当前 [stlLoader.ts](../../src/viewer/stlLoader.ts) 直接构造 `BufferGeometry`（非 indexed，per-face normal）
- demo-substation 1803 个 STL

### 6.2 批量优化方案

**缓存**：

- 序列化 `BufferGeometry.attributes.position` + `attributes.normal` 为字节
- 存入 `geometry_cache` 表，`cache_key = stlPath`

**渲染**：

- STL 形状各异，不适合 InstancedMesh
- 用 `mergeGeometries` 合并同项目所有 STL 为单个 BufferGeometry（带 groups 支持多 material）
- 或保持每 STL 一个 Mesh，但用 `BatchedMesh` 管理（r163+）

**估算**：

- 1803 个 STL × 平均 1000 三角面 ≈ 1.8M 三角面
- 合并后 1 个 draw call（mergeGeometries）vs 1803 draw call（现状）

### 6.3 Worker 化

STL 解析极简（80 字节头 + N×50 字节三角形），Worker 化收益有限：

- 主瓶颈在 BufferGeometry 构造（`new Float32Array(N × 9)`）
- 建议 Worker 仅做"字节 → 序列化 BufferGeometry 字节"，主线程直接反序列化

---

## 7. 实施路径

### 7.1 分阶段落地

| 阶段 | 目标 | 改动范围 | 预期收益 |
| ---- | ---- | -------- | -------- |
| **阶段 1**：假并发修复 | 把 `for (const geo of batch)` 改为 `Promise.all(batch.map(...))` | [modAutoLoadService.ts:670-709](../../src/services/modAutoLoadService.ts#L670-L709) ~20 行 | 4× 吞吐（无新依赖） |
| **阶段 2**：几何缓存表 | 新增 `geometry_cache` 表 + Tauri 命令 | [db.rs](../../src-tauri/src/db.rs) 新增 ~150 行；[desktop/database.ts](../../src/desktop/database.ts) 新增 ~50 行 | 二次打开 < 1 秒 |
| **阶段 3**：Worker 化解析 | 新增 `xmlModParser.worker.ts` + Worker 池 | 新文件 ~300 行；[modAutoLoadService.ts](../../src/services/modAutoLoadService.ts) 改造 ~100 行 | 主线程不阻塞 |
| **阶段 4**：InstancedMesh | 替换 per-Mesh 为 6 个 InstancedMesh | [xmlModGeometry.ts](../../src/viewer/xmlModGeometry.ts) 重写 ~400 行；[highlight.ts](../../src/viewer/highlight.ts) 改造 ~100 行 | draw call 从 108k → 6 |
| **阶段 5**：Material 共享 | Material cache keyed by (r,g,b,a) | [xmlModGeometry.ts:142](../../src/viewer/xmlModGeometry.ts#L142) ~30 行 | 内存占用 -50% |

### 7.2 阶段 1 详细 diff（最低成本，最高收益）

```diff
--- a/src/services/modAutoLoadService.ts
+++ b/src/services/modAutoLoadService.ts
@@ modAutoLoadService.ts:670-709
   for (let i = 0; i < modGeos.length; i += CONCURRENCY) {
     const batch = modGeos.slice(i, i + CONCURRENCY);
     showProgress({ ... currentPath: batch[0].modPath });
     if (!isTokenValid(state, token)) { ... return; }
-    for (const geo of batch) {
-      if (state.loadedXmlModGroups.has(geo.instanceKey)) { loadedMods++; continue; }
-      try {
-        const group = await loadModFile(geo, files);
-        if (group) {
-          if (!prepareModGroupForScene(...)) { skippedBadBBox++; continue; }
-          modRoot.add(group);
-          state.loadedXmlModGroups.set(geo.instanceKey, group);
-          loadedMods++;
-        }
-      } catch (err) { ... }
-    }
+    await Promise.all(batch.map(async (geo) => {
+      if (state.loadedXmlModGroups.has(geo.instanceKey)) { loadedMods++; return; }
+      try {
+        const group = await loadModFile(geo, files);
+        if (group) {
+          if (!prepareModGroupForScene(...)) { skippedBadBBox++; return; }
+          modRoot.add(group);
+          state.loadedXmlModGroups.set(geo.instanceKey, group);
+          loadedMods++;
+        }
+      } catch (err) { ... }
+    }));
     if (i + CONCURRENCY < modGeos.length) {
       await new Promise((r) => setTimeout(r, YIELD_MS));
     }
   }
```

**注意**：`state.loadedXmlModGroups.set` 与 `modRoot.add` 必须串行（Three.js 不是并发安全）。改造为：

```typescript
const groups = await Promise.all(batch.map(geo => loadModFile(geo, files)));
// 串行处理结果
for (let j = 0; j < batch.length; j++) {
  const group = groups[j];
  if (!group) continue;
  if (!prepareModGroupForScene(...)) { skippedBadBBox++; continue; }
  modRoot.add(group);
  state.loadedXmlModGroups.set(batch[j].instanceKey, group);
  loadedMods++;
}
```

### 7.3 缓存版本化策略

```text
PARSER_VERSION         = 'gim-parser-v5'         // 现有，GIM 解析层
FRAGMENTS_CACHE_VERSION = 'fragments-cache-v4'   // 现有，IFC .frag
GEOMETRY_CACHE_VERSION = 'geometry-cache-v1'     // 新增，MOD/STL 序列化几何

失效规则：
  - GIM 重解压（PARSER_VERSION 变）→ GEOMETRY_CACHE_VERSION 同步失效
  - MOD 解析逻辑变更（如 primitive 参数提取规则改）→ GEOMETRY_CACHE_VERSION 单独递增
  - InstancedMesh 装配逻辑变更 → 不影响缓存（装配是运行时）
```

---

## 8. 数据流示例

### 8.1 首次打开 demo-substation（缓存未命中）

```text
1. 用户选择 .gim 文件
   → Rust 计算 sha256 + file_size
   → validate_gim_cache 返回 cache_miss
   → 完整解压 → gim_entry 入库 → cbm_node/dev_solid_model/... 入库
   → 提取 IFC 文件到 extracted/{projectId}/

2. IFC 加载（现有）
   → web-ifc 解析 → Fragments 模型 → 写 .frag → fragment_cache 入库

3. MOD/STL 几何缓存构建（新）
   → get_reachable_geometry 返回 9866 个 ReachableGeometry
   → 缓存批量查询：9866 全部未命中
   → batchReadCachedFiles 读取 5938 个唯一 MOD/STL 字节（3 次 IPC）
   → Worker 池并行解析：xmlModParser.worker × N
     → 输出 ParsedEntity 列表
   → geometryBuilder.worker
     → 按 primitiveType 分组、序列化 BufferGeometry
     → 写回 geometry_cache（按 < 100KB / ≥ 100KB 分流 inline/file）
   → 主线程装配 InstancedMesh（6 个）
   → scene.add(instancedMeshes)
   → 用户看到完整变电站
```

### 8.2 二次打开 demo-substation（缓存命中）

```text
1. 用户选择同一 .gim 文件
   → Rust 计算 sha256 + file_size
   → validate_gim_cache 返回 cache_hit
   → get_gim_index 恢复全部索引到 AppState
   → 不解压、不读原始 GIM

2. IFC 加载（现有）
   → 读 .frag → ctx.fragments.core.load → Fragments 模型
   → 跳过 web-ifc 解析

3. MOD/STL 几何缓存读取（新）
   → get_reachable_geometry 返回 9866 个 ReachableGeometry
   → 缓存批量查询：9866 全部命中（geometry_cache 命中）
   → batchReadCachedFiles 读取序列化字节（按 blob_path，1 次 IPC）
   → 主线程反序列化 BufferGeometry（零拷贝 Float32Array）
   → 装配 InstancedMesh（6 个）
   → 用户看到完整变电站，全程 < 1 秒
```

### 8.3 项目切换

```text
1. state.geometryLoadToken++
   → 所有在途 Worker 任务检测到 token 不匹配，立即 return
   → Worker 池 dispose 所有 Worker

2. projectCleanupService
   → 遍历 state.modRootGroup，dispose 所有 InstancedMesh
   → modRootGroup/stlRootGroup 从 scene 移除
   → state.loadedInstancedMeshes.clear()

3. 新项目进入流程 8.1 或 8.2
```

---

## 9. 风险与权衡

### 9.1 主要风险

| 风险 | 影响 | 缓解 |
| ---- | ---- | ---- |
| InstancedMesh 拾取精度丢失 | 当前 per-Mesh raycast 精度高，改 InstancedMesh 后 per-instance raycast 仍可用但需测试 | 保留旧路径作为 fallback；按场景切换 |
| 同 type 不同 params 共享单位几何 | 缩放矩阵可能引入数值精度问题（极小/极大半径） | 对极端 params 单独建 InstancedMesh |
| Worker 通信开销 | 小文件（<1KB XML）的 Worker 派发成本可能高于解析本身 | 批量派发（一次 postMessage 多个文件） |
| 缓存膨胀 | 序列化几何 ~300MB（vs 原始 XML ~150MB） | 提供"清理缓存"按钮；按项目维度隔离 |
| Three.js 版本约束 | BatchedMesh 需 r163+；当前 `@thatopen/components ^3.4.x` 的 three 依赖需验证 | 若 < r163 退化为 InstancedMesh + mergeGeometries |
| MOD Entity.TransformMatrix 与 placement 的乘法顺序 | 与 [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md) 问题 3 关联 | 必须先修复 bug 3 再做阶段 4 |

### 9.2 不建议的方案

| 方案 | 原因 |
| ---- | ---- |
| IndexedDB 缓存几何 | 与现有 SQLite 体系重复；Tauri 桌面场景 SQLite + 文件已足够 |
| Draco 压缩 | 本地磁盘 IO 不是瓶颈，解码成本反而拖慢 |
| OffscreenCanvas 全渲染 Worker | UI 集成重（CBM 树/属性面板/Tauri IPC），postMessage marshalling 开销大 |
| SQLite BLOB 存全部几何字节 | 违反 SQLite 官方建议（>100KB 应存文件） |
| 移除 per-instance 颜色支持 | MOD XML 颜色是设备语义一部分，不能丢失 |

### 9.3 渐进式落地策略

**最低风险路径**（推荐）：

```text
阶段 1（1 天）：假并发修复
  → 立即获得 4× 吞吐，零依赖、零架构改动
  → 验证 batch.map + await Promise.all 的正确性

阶段 2（3 天）：几何缓存表 + 序列化
  → 二次打开进入秒级
  → 不改渲染层，per-Mesh 仍保留
  → 风险：序列化格式向前兼容性

阶段 3（5 天）：Worker 化解析
  → 主线程不阻塞
  → 不改渲染层
  → 风险：Worker 通信开销、Tauri IPC 在 Worker 可用性

阶段 4（7 天）：InstancedMesh 装配
  → draw call 从 108k → 6
  → 必须先修复 [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md) 问题 3
  → 风险：拾取改造、高亮改造、visible 控制改造

阶段 5（2 天）：Material 共享
  → 内存占用 -50%
  → 风险：低（仅改 Material 构造方式）
```

---

## 10. 验证清单

### 10.1 阶段 1 验证

- [ ] `Promise.all` 版本在 demo-substation 上加载时间 < 串行版本 / 4
- [ ] 主线程帧率在加载期间 ≥ 30fps（vs 现状 < 5fps）
- [ ] token 失效后无残留任务（已验证 `isTokenValid` 检查点）

### 10.2 阶段 2 验证

- [ ] 首次打开后 `geometry_cache` 表行数 ≈ 唯一 (modPath, primitiveType, paramsHash) 组合数
- [ ] 二次打开总耗时 < 1 秒（不含 IFC）
- [ ] `geometry_cache_version` 变更后表自动清空重建
- [ ] inline/file 分流阈值正确（100KB）

### 10.3 阶段 3 验证

- [ ] Worker 池在 8 核 CPU 上利用率达 70%+
- [ ] 主线程在 Worker 解析期间可响应 UI 事件（延迟 < 50ms）
- [ ] 项目切换时所有 Worker 在 100ms 内终止

### 10.4 阶段 4 验证

- [ ] draw call 数 = 6（按 6 种 primitive）
- [ ] 点击拾取返回正确的 instanceId
- [ ] 高亮单个 instance 不影响其他 instance
- [ ] 隐藏某 CBM 节点对应的所有 instance 后，画面正确更新
- [ ] MOD 几何位置与 IFC 几何对齐（无偏移）

### 10.5 阶段 5 验证

- [ ] Material 对象数 < 100（按颜色组合聚类）
- [ ] 不同颜色 primitive 仍正确显示

---

## 11. 参考

### 11.1 内部文档

- [09-transform-chain-analysis.md](./09-transform-chain-analysis.md)：完整变换链分析
- [10-substation-mod-grammar.md](./10-substation-mod-grammar.md)：MOD XML 语法
- [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md)：已知 bug
- [dev.md](./dev.md)、[phm.md](./phm.md)：DEV/PHM 文件格式

### 11.2 外部资料

- Three.js `BatchedMesh` 官方文档 — https://threejs.org/docs/?q=BatchedMesh#BatchedMesh
- Three.js `InstancedMesh` 官方文档 — https://threejs.org/docs/?q=InstancedMesh#InstancedMesh
- Three.js `mergeGeometries` 工具 — https://threejs.org/docs/?q=mergeGeometries#module-BufferGeometryUtils.mergeGeometries
- Three.js `WorkerPool` — https://threejs.org/docs/?q=WorkerPool#WorkerPool
- `@thatopen/fragments` npm — https://www.npmjs.com/package/@thatopen/fragments
- ThatOpen Fragments FlatBuffers schema — https://github.com/ThatOpen/engine_fragment/blob/main/packages/fragments/flatbuffers/index.fbs
- ThatOpen 文档门户 — https://docs.thatopen.com/intro
- SQLite 内部 vs 外部 BLOB — https://www.sqlite.org/intern-v-extern-blob.html
- MDN IndexedDB — https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API
- MDN OffscreenCanvas — https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
- Khronos `KHR_draco_mesh_compression` — https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_draco_mesh_compression/README.md
- Google Draco — https://google.github.io/draco/

### 11.3 关键代码位置

- [src/services/modAutoLoadService.ts](../../src/services/modAutoLoadService.ts)：现有加载编排
- [src/viewer/xmlModLoader.ts](../../src/viewer/xmlModLoader.ts)：MOD 文件 → Group
- [src/viewer/xmlModGeometry.ts](../../src/viewer/xmlModGeometry.ts)：primitive → BufferGeometry
- [src/viewer/stlLoader.ts](../../src/viewer/stlLoader.ts)：STL 解析
- [src/gim/geometry/xmlModParser.ts](../../src/gim/geometry/xmlModParser.ts)：DOMParser-based XML 解析
- [src/viewer/ifcEntryLoader.ts](../../src/viewer/ifcEntryLoader.ts)：IFC .frag 缓存参考
- [src-tauri/src/db.rs](../../src-tauri/src/db.rs)：SQLite 表结构与 Tauri 命令
- [src/app/state.ts](../../src/app/state.ts)：内存缓存字段
- [src/services/projectCleanupService.ts](../../src/services/projectCleanupService.ts)：项目切换资源释放
