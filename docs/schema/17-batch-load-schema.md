# MOD/STL 批量加载与中间态缓存设计

> 本文档针对 GIM 变电工程中 MOD/STL 文件数量大（demo-substation 含 4135 个 .mod + 1803 个 .stl）、当前"逐文件串行解析 + 重建几何"管线慢的问题，调研现有批量加载方案，给出中间态缓存（文件 + SQLite）的设计建议。
>
> 关联文档：
> - [09-transform-chain-analysis.md](./09-transform-chain-analysis.md)：完整变换链分析（MOD 实例 placement 累乘）
> - [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md)：已知 bug 与改进方向
> - [20-substation-partindex-alias-correction.md](./20-substation-partindex-alias-correction.md)：PARTINDEX 别名与物理实例基线更正
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

参考 [20-substation-partindex-alias-correction.md](./20-substation-partindex-alias-correction.md) 的修正后实例统计：

- **唯一 MOD/STL 文件**：5938 个
- **物理几何引用**：5938 个（4135 MOD + 1803 STL；PARTINDEX 不作为第二个实例）
- **平均每 MOD 文件 primitive 数**：~5 个 Entity（来自 09 号文档 §5.1：46250 Entity / 4135 MOD ≈ 11.2）
- **方案 A 基线预估 Mesh 数**：5938 引用 × 11 Entity ≈ 65k Mesh

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

## 7. 实施路径（原版，已被 §15 取代）

> **注**：本节为初版实施路径，已被 [§15 综合实施路径（更新版）](#15-综合实施路径更新版) 取代。保留作为历史参考。

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
PARSER_VERSION          = 'gim-parser-v14'        // 现有，GIM 解析层（v1→v14 详见下方演进历史）
FRAGMENTS_CACHE_VERSION = 'fragments-cache-v4'   // 现有，IFC .frag
GEOMETRY_CACHE_VERSION  = 'geometry-cache-v1'    // 待实施，MOD/STL 序列化几何（方案 C）

失效规则：
  - GIM 重解压（PARSER_VERSION 变）→ GEOMETRY_CACHE_VERSION 同步失效
  - MOD 解析逻辑变更（如 primitive 参数提取规则改）→ GEOMETRY_CACHE_VERSION 单独递增
  - InstancedMesh 装配逻辑变更 → 不影响缓存（装配是运行时）
```

#### PARSER_VERSION 演进历史

| 版本 | 变更内容 |
| ---- | -------- |
| v5 | 初始版本 |
| v6 | CBM 层级树结构优化 |
| v7 | 几何引用链递归 DEV SUBDEVICE，并保存 SUBDEVICE 变换矩阵 |
| v8 | 几何查询使用 CBM 父链累计 TRANSFORMMATRIX，并按实例级 placement 去重 |
| v9 | F1System 根节点用 GIM 头部工程名；F4System/PARTINDEX 用 DEV SYMBOLNAME；过滤 IFC "&其他"占位符 |
| v10 | F1System 显示工程类型名；F2System 按 SYSCLASSIFYNAME 映射专业名并排序 |
| v11 | F3System 命名优化（方案A 过滤占位符 + 方案B F4 反推后缀） |
| v12 | 修复 DEV SUBDEVICE 虚拟子节点 transformMatrix 为空 |
| v13 | DEV_SUBDEVICE 虚拟节点不作为全量几何查询起点 |
| v14 | 当前版本（详见 18b 文档） |

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

## 10. 实战教训：从 Material 共享到 A.1 解决崩溃（2026-07-06 复盘）

> 本节记录 §7.3 阶段 5（Material 共享）落地后的实测结果，以及由此引出的更深层性能瓶颈分析。
>
> **更新**：方案 A.1（§11）已解决崩溃问题。详见 [18a-experiment-shared-geometry.md](./18a-experiment-shared-geometry.md) §11 实测结论。

### 10.1 实施情况与实测结果

**已实施**（[16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md) §2.4 问题 4 / FIX-3）：

- [xmlModGeometry.ts](../../src/viewer/xmlModGeometry.ts) 新增 `_sharedMaterialCache` 按 `(colorHex, opacity, transparent)` 聚类
- 新增 `disposeSharedXmlModMaterials()` 统一释放
- `disposeXmlModGroup` 不再 dispose Material，仅 dispose geometry
- 测试更新为"仅释放 geometry"

**实测结果**：

| 指标 | 修复前 | Material 共享后 | A.1 实测最终 |
| ---- | ---- | ---- | ---- |
| Material 数量 | ~78000 | 几十个 ✓ | 几十个 ✓ |
| MOD 位置正确性 | 横着放 | 直立显示 ✓（叠加 FIX-4 Z-up→Y-up） | 直立 ✓ |
| 加载速度 | 慢 | 提升 ✓ | 7553 MOD 全加载 ✓ |
| 崩溃临界点 | ~3000 MOD | ~2000+ MOD ✗ | **未崩溃** ✓（A.1 跨 modPath 共享） |
| bbox 跳过 | — | — | 36% ✗（新问题，见 18a §11.3） |

### 10.2 为什么修复 Material 后仍崩溃

Material 共享解决了一部分问题，但 **Geometry 仍然每个 Entity 一个**：

[xmlModGeometry.ts:116-128](../../src/viewer/xmlModGeometry.ts#L116-L128)：

```typescript
export function entityToMesh(e: XmlModEntity): THREE.Mesh | null {
  const geometry = primitiveToGeometry(e.primitive);  // ← 每 Entity new 一个 Geometry
  // ...
  const mesh = new THREE.Mesh(geometry, material);    // ← 每 Entity new 一个 Mesh
  // ...
}
```

按真实数据估算资源累积：

| 资源类型 | 2000 MOD 时 | 7000 MOD 时 | 单位大小 | 总占用 |
| ---- | ----: | ----: | ----: | ----: |
| Mesh 对象 | ~22000 | ~77000 | ~1KB（matrix/quaternion/geometry ref） | 22MB / 77MB |
| BufferGeometry | ~22000 | ~77000 | ~3KB（vertex + index + normal） | 66MB / 231MB |
| draw call | ~22000 | ~77000 | — | 超过核显上限 |
| JS heap | — | — | — | ~80MB / ~280MB |
| GPU vertex buffer | — | — | — | ~30MB / ~100MB |

**崩溃主因**（核显环境尤为明显）：

1. **draw call 数量超限**：核显驱动通常单帧 draw call 上限 3000-5000（独显 10000+），超过后驱动队列溢出或 GPU 频繁切换上下文导致崩溃
2. **JS heap 累积**：77000 个 Three.js Object3D 对象（每个含 matrix/quaternion/geometry 引用），WebView2 子进程通常 1-2GB 上限
3. **GPU 内存压力**：核显共享系统内存，无独立显存，与系统其他进程争用

### 10.3 游戏引擎对比：为什么不崩溃且速度快

游戏资料包里也有大量 `.mod` 文件（如 Neverwinter Nights、Paradox 游戏、Minecraft 模组），但游戏加载不崩溃且速度快，根本原因是 **离线预编译 + 运行时复用**。

**.mod 后缀的真相**：

| 来源 | 格式 | 是否标准 |
| ---- | ---- | ---- |
| GIM（国家电网） | 自定义 XML 文本 | 否（电力行业专有） |
| Neverwinter Nights | 自定义二进制模块包 | 否（BioWare Aurora 引擎专有） |
| Paradox 游戏 | zip 压缩的 mod 目录 | 否（Paradox 自有结构） |
| Minecraft 模组 | zip 压缩的 Java/Bedrock 资产 | 否（Mojang 自有结构） |

**后缀相同但内部格式完全不同**。游戏厂商通常把它们预编译成 GPU 友好的二进制格式（glTF binary、自研 chunk 格式），与我们的 XML 文本格式有本质区别。

**游戏引擎的 7 项关键技术**（我们当前一项未用）：

| 技术 | 游戏引擎做法 | 我们当前做法 | 差距 |
| ---- | ---- | ---- | ---- |
| GPU 实例化 | 同形状 N 个物体 → 1 个 InstancedMesh + 1 draw call | N 个独立 Mesh + N draw call | 1000× |
| 静态合并 | 加载时同材质合并成单个 BufferGeometry | 每个 Entity 独立 geometry | 100× |
| 资源预编译 | 离线把资产转成 GPU 二进制格式 | 运行时解析 XML 文本 | 10× |
| 材质批处理 | 同材质自动合并 draw call | Material 已共享但 Mesh 独立 | — |
| LOD | 远处用低精度模型 | 全部高精度 | — |
| GPU 内存预算 | 显式管理，超限驱逐 | 无上限、无 LRU | — |
| 流式加载 | 分帧加载，每帧 ≤ 16ms | 批次 yield 但单批内串行 | — |

游戏引擎的核心理念是 **减少 draw call 和 GPU 资源数量**，而非减少内存。一个 InstancedMesh 渲染 10000 个实例只占用 1 个 draw call 和 1 份 geometry。

### 10.4 从"游戏为什么快"得出的修复路径

基于上述对比，修复路径有 3 个层次，按改动量递增、收益递增排序：

| 层次 | 方案 | 改动量 | 收益 | 风险 |
| ---- | ---- | ---- | ---- | ---- |
| 短期 | §11 方案 A：Geometry 共享 | 小（~50 行） | GPU 内存 -40%，draw call 不变 | 低（保 Entity 高亮） |
| 中期 | §12 方案 B：mergeGeometries 静态合并 | 中（~150 行） | draw call 从 77k → 几十，GPU 内存 -60% | 中（Entity 信息丢失） |
| 长期 | §13 方案 C/D：游戏引擎预编译 | 大（架构级） | 加载速度 10×，draw call 6 个 | 高（重写加载管线） |

---

## 11. 方案 A：Geometry 共享（已完成，详见 18a 实验文档）

> **状态**：A.1 已实施并实测完成 — 7553 MOD 全加载未崩溃。
> 详见 [18a-experiment-shared-geometry.md](./18a-experiment-shared-geometry.md)。
>
> A.0（按 modPath 缓存）将崩溃临界点从 2000+ 提升到 5000+；
> A.1（移除 modPath，跨 modPath 全局共享）彻底解决崩溃，7553 MOD 全加载完成。
>
> 实测发现两个新问题（非方案 A 缺陷）：
> 1. UI 进度显示 bug（[18a §11.2](./18a-experiment-shared-geometry.md)）
> 2. 36% MOD 被 bbox 异常跳过（[18a §11.3](./18a-experiment-shared-geometry.md)）

### 11.1 设计

按 `(modPath, primitiveSignature)` 缓存 BufferGeometry，同 MOD 文件多实例只解析一次。

**缓存键**：

```typescript
const sig = `${modPath}:${primitiveType}:${JSON.stringify(primitiveParams)}`;
```

**实现**：

```typescript
// xmlModGeometry.ts
const _geometryCache = new Map<string, THREE.BufferGeometry>();

function primitiveToGeometryCached(p: XmlModPrimitive, modPath: string): THREE.BufferGeometry | null {
  const sig = `${modPath}:${p.type}:${JSON.stringify(primitiveParams(p))}`;
  let geo = _geometryCache.get(sig);
  if (geo) return geo;
  geo = primitiveToGeometry(p);
  if (geo) _geometryCache.set(sig, geo);
  return geo;
}

export function disposeSharedXmlModGeometries(): void {
  for (const geo of _geometryCache.values()) geo.dispose();
  _geometryCache.clear();
}
```

### 11.2 预期效果

按 [09 号文档 §11.4](./09-transform-chain-analysis.md) 数据：66.2% MOD 文件被多实例引用，平均复用 1.66 次。

| 指标 | 现状 | 方案 A 后 | 减少 |
| ---- | ----: | ----: | ---: |
| Geometry 对象数 | ~77000 | ~46000 | 40% |
| draw call 数 | ~77000 | ~77000 | 0（不变） |
| GPU vertex buffer | ~100MB | ~60MB | 40% |
| JS heap | ~280MB | ~200MB | 28% |

### 11.3 风险与权衡

**优点**：
- 改动小（~50 行）
- 保留 Entity 级高亮（每个 Mesh 仍独立，含 Entity 信息）
- 与现有 `disposeXmlModGroup` 兼容（只需像 Material 一样不在 per-mesh dispose）

**局限**：
- draw call 数量不变，核显可能仍崩溃（取决于临界点是是否被 Geometry 内存或 draw call 主导）
- 需要测试验证是否足以解决崩溃

### 11.4 实施步骤

1. 修改 `primitiveToGeometry` 为 `primitiveToGeometryCached`，加 `modPath` 参数
2. `entityToMesh` 接收 `modPath`，传给 `primitiveToGeometryCached`
3. `xmlModDocumentToGroup` 已有 `doc.modPath`，传入即可
4. `disposeXmlModGroup` 改为不 dispose geometry（共享，由 `disposeSharedXmlModGeometries` 统一释放）
5. `projectCleanupService` 调用 `disposeSharedXmlModGeometries`
6. 测试更新

### 11.5 验证清单

- [ ] 加载 7000+ MOD 不崩溃
- [ ] `_geometryCache.size` 约为 46000（非 77000）
- [ ] 同 modPath 多实例共享同一 geometry 实例
- [ ] Entity 级高亮仍正常工作
- [ ] 项目切换时 `disposeSharedXmlModGeometries` 被调用

---

## 12. 方案 B：mergeGeometries 静态合并（已实施）

> **状态**：✅ 已实施 — draw call 从 ~77000 降到几十，加载速度大幅提升。
>
> **2026-07-11 更新**：方案 B 实施后，生产路径已切换为顶点烘焙——mm→m 缩放与 placement matrix 都直接 applyMatrix4 到 BufferGeometry 顶点，避免 `Object3D.applyMatrix4 + decompose` 链路在 placement 含缩放分量时 corrupt `group.scale`。详见 [09-transform-chain-analysis.md](./09-transform-chain-analysis.md) §12。

### 12.1 设计

方案 A 虽解决了崩溃，但 ~77000 draw call 导致加载耗时 ~2 小时。需要把同 Material 的多个 geometry 合并成单个 BufferGeometry。

**实现位置**：[xmlModLoader.ts](../../src/viewer/xmlModLoader.ts) 的 `flattenDocumentToGroup` + [xmlModGeometry.ts](../../src/viewer/xmlModGeometry.ts) 的 `collectBakedGeometriesByMaterial`。

**核心实现**：直接从 entity 数据烘焙 TransformMatrix + mm→m 缩放到顶点，按 Material 分组后 `mergeGeometries`：

```typescript
// xmlModGeometry.ts: collectBakedGeometriesByMaterial
const mmToScene = new THREE.Matrix4().makeScale(0.001, 0.001, 0.001);
for (const entity of doc.entities) {
  const baked = baseGeo.clone();
  if (entity.transformMatrix.length === 16) {
    baked.applyMatrix4(gimMatrixToMatrix4(entity.transformMatrix));
  }
  baked.applyMatrix4(mmToScene);
  // 按 Material 分组
}

// xmlModLoader.ts: flattenDocumentToGroup
for (const [mat, geos] of byMaterial) {
  const combined = mergeGeometries(geos, false);
  merged.add(new THREE.Mesh(combined, mat));
}
// group.scale 保持 1（mm→m 已烘焙到顶点）
```

### 12.2 实测效果

| 指标 | 方案 A 后 | 方案 B 后 | 减少 |
| ---- | ----: | ----: | ---: |
| Mesh 对象数 | ~77000 | 几十个 | 99.9% |
| draw call 数 | ~77000 | 几十 | 99.9% |
| GPU vertex buffer | ~60MB | ~60MB | 0（不变） |
| JS heap | ~200MB | ~80MB | 60% |
| 加载耗时 | ~2 小时 | 大幅提升（分钟级） | — |

### 12.3 风险与权衡

**优点**：
- draw call 从 77k 降到几十，**彻底解决核显崩溃**
- Mesh 数量减少 99.9%，JS heap 大幅下降
- 改动量中等（~150 行）

**代价**：
- **Entity 级信息丢失**：合并后无法 raycast 到单个 Entity，只能到 Group 级
- **transform 烘焙**：合并前必须把 Entity.TransformMatrix 烘焙到 vertex position，Geometry 共享（方案 A）失效
- **高亮降级**：从 Entity 级高亮退化为 Group 级高亮

### 12.4 决策点

实施前需要决定：

**问题：保 Entity 级高亮 vs 改回 Group 级高亮？**

| 选项 | 方案 | 后果 |
| ---- | ---- | ---- |
| 保 Entity 高亮 | 仅用方案 A | 可能仍崩溃（核显 draw call 上限主导） |
| 求性能 | 方案 A + B | 彻底解决崩溃，但 Entity 高亮降级为 Group 高亮 |

**决策**：方案 A.1 实测加载 ~2 小时，性能对生产不可接受。方案 B 为当前最高优先级。Entity 级高亮降级为 Group（modPath）级高亮，可接受——用户通过 CBM 树点击设备节点时，高亮整个 MOD Group 已足够定位设备。

### 12.5 实施步骤

1. 安装依赖：`npm install three-stdlib`（提供 `BufferGeometryUtils`）
2. 在 `xmlModLoader.ts` 新增 `flattenGroup` 函数
3. `loadXmlModFromText` 末尾调用 `flattenGroup` 后返回
4. 修改 `highlight.ts`：raycast 命中后从 `mesh.parent.userData.modPath` 取 MOD 信息（而非 `mesh.userData.entityId`）
5. 更新高亮逻辑：从单 Entity 高亮改为整 MOD 高亮
6. 测试更新

### 12.6 验证清单

- [ ] 加载 7000+ MOD 不崩溃
- [ ] draw call 数 < 100（vs 方案 A 的 77000）
- [ ] Mesh 对象数 < 1000
- [ ] 点击拾取返回正确的 modPath（Group 级）
- [ ] 高亮整个 MOD Group（非单 Entity）

---

## 13. 方案 C/D：游戏引擎预编译思路（长期演进）

### 13.1 核心思想

**GIM 文件不会变**（电网工程交付后是只读资产），可以把它当成一个游戏资源包：

```text
传统游戏开发流程：
  美术源文件（FBX/Max/Maya）→ 离线编译 → GPU 二进制资产 → 运行时加载

GIM 类比流程：
  GIM 文件（XML 文本 .mod）→ 离线预编译 → GPU 二进制几何 → 运行时加载
```

**关键洞察**：当前我们在"运行时"做的工作（XML 解析 + 几何构造 + Material 创建），游戏引擎在"打包阶段"就完成了。运行时只做"读取二进制 → upload 到 GPU"。

### 13.2 方案 C：原生预编译（自研工具链）

**预编译阶段**（离线工具，独立于 Viewer）：

```text
输入：原始 GIM 文件（.gim）
输出：预编译资源包（.gimc）

工具流程：
  1. 解压 GIM → 提取所有 .mod/.stl/.cbm/.dev/.phm
  2. 解析 CBM/DEV/PHM 引用链 → 计算 placement 矩阵
  3. 解析 MOD XML → 构造 BufferGeometry
  4. 序列化几何为二进制（§3.4 GMGC 格式 或 .glb）
  5. 生成 manifest.json（modPath → geometry_offset + instance_matrices）
  6. 打包为 .gimc 资源包
```

**运行时阶段**（Viewer 改造）：

```text
1. 用户打开 .gimc（或打开 .gim 时检测同路径 .gimc 存在）
2. 读取 manifest.json → 反序列化几何 → 装配 InstancedMesh
3. 跳过 XML 解析、CBM/DEV/PHM 解析、几何构造
```

**预期收益**：

| 指标 | 当前 | 方案 C 后 |
| ---- | ---- | ---- |
| 首次打开 | 数分钟 | < 5 秒（仅读二进制 + GPU upload） |
| 二次打开 | ~1 秒（§3 几何缓存） | < 1 秒 |
| 内存峰值 | ~300MB | ~200MB（无 XML DOM 残留） |
| draw call | ~77000（方案 A）/ ~几十（方案 B） | 6（InstancedMesh） |

### 13.3 方案 D：引入游戏引擎

**思路**：用现成的游戏引擎作为 GIM 资产打包与渲染层，而非自研。

**候选引擎**：

| 引擎 | 适用性 | 集成难度 | 备注 |
| ---- | ---- | ---- | ---- |
| **Babylon.js** | 高 | 中 | Web 原生，与 Three.js 同生态，支持 InstancedMesh/Thin Instances/资产打包 |
| **PlayCanvas** | 高 | 中 | Web 优先，资产打包成熟，引擎本身为流式加载设计 |
| **Three.js + three-stdlib** | 中 | 低 | 现有架构延续，自行实现资产打包 |
| **Unreal Engine** | 低 | 高 | 桌面应用 Epic Games 同款，但 Tauri 集成困难 |
| **Godot** | 低 | 高 | 开源游戏引擎，但 Web 导出性能弱于 Three.js |

**推荐路径**：保留 Three.js 基础，引入 `three-stdlib` 的资产打包工具 + 自研预编译脚本（方案 C 的实现）。完全切换引擎代价过高，且 Three.js 生态已能满足 GIM 需求。

### 13.4 资产打包格式选择

| 格式 | 优点 | 缺点 | 推荐度 |
| ---- | ---- | ---- | ---- |
| **自定义 GMGC**（§3.4） | 极简，零依赖，零拷贝反序列化 | 需自研工具链，无生态 | 中（已设计） |
| **glTF binary (.glb)** | ISO 标准，工具链丰富，Draco 压缩可选 | 解码有开销，文件略大 | 高 |
| **DRACO 压缩 .glb** | 文件最小（10-20× 压缩） | WASM 解码慢，桌面场景 IO 非瓶颈 | 低 |
| **ThatOpen .frag** | 与 IFC 缓存对齐 | 含 properties/relations，几何纯度低 | 中 |
| **MESHOPT 压缩 .glb** | GPU 友好，解码快 | 较新，工具链不如 Draco 成熟 | 中 |

**建议**：使用 `.glb`（不压缩）作为预编译资产格式。理由：

1. 标准格式，未来可在 Rust 侧或 Worker 侧用任何 glTF 库序列化
2. 桌面 SSD IO 不是瓶颈，无需 Draco 压缩
3. `GLTFLoader` 已内置于 Three.js 生态，无新依赖
4. 工具链丰富（如 `gltf-transform` 可做后续优化）

### 13.5 预编译工具实现路径

**工具形态**：Node.js CLI 脚本，独立于 Viewer 运行

```text
src-tools/
  └─ gimPrecompiler/
      ├─ index.ts              # CLI 入口：node dist/gimPrecompiler.js input.gim
      ├─ extractGim.ts         # 解压 GIM，复用 src/gim/gimExtractor.ts
      ├─ buildGeometry.ts      # 遍历 CBM/DEV/PHM，构造 BufferGeometry
      ├─ serializeGlb.ts       # BufferGeometry → .glb（用 gltf-transform）
      └─ manifestWriter.ts     # 生成 manifest.json
```

**调用方式**：

```bash
# 首次预编译
node dist/gimPrecompiler.js demo-substation.gim
# 生成 demo-substation.gimc/ 目录：
#   manifest.json
#   geometries/
#     cylinder-abc123.glb
#     cuboid-def456.glb
#     ...
#   instances.bin（所有实例的 placement 矩阵）

# Viewer 加载
# 用户打开 demo-substation.gim
# Viewer 检测同路径 .gimc 存在 → 直接加载预编译资源
# 不存在 → 后台触发预编译（或回退到当前 XML 解析路径）
```

### 13.6 方案 C/D 实施路径

| 阶段 | 目标 | 改动范围 | 预期收益 |
| ---- | ---- | ---- | ---- |
| **阶段 6**：预编译工具原型 | Node.js CLI，输入 .gim 输出 .gimc | 新建 `src-tools/gimPrecompiler/` ~600 行 | 首次预编译后，Viewer 加载 < 5 秒 |
| **阶段 7**：Viewer 加载 .gimc | 检测 .gimc 存在则直接加载 | [modAutoLoadService.ts](../../src/services/modAutoLoadService.ts) 改造 ~200 行 | 跳过 XML 解析 |
| **阶段 8**：InstancedMesh 装配 | 按 primitiveType 分组，6 个 InstancedMesh | [xmlModGeometry.ts](../../src/viewer/xmlModGeometry.ts) 重写 ~400 行 | draw call 从 77k → 6 |
| **阶段 9**：后台预编译 | 用户首次打开 .gim 后台触发预编译 | Tauri Rust 侧新增预编译命令 | 二次打开即享预编译收益 |

### 13.7 风险

| 风险 | 影响 | 缓解 |
| ---- | ---- | ---- |
| 预编译工具与 Viewer 几何构造逻辑不一致 | 预编译几何与运行时几何不符 | 复用 `src/gim/` 与 `src/viewer/xmlModGeometry.ts`，不重写 |
| .gimc 与 .gim 失效同步 | .gim 更新但 .gimc 旧 | 按 sha256 + parser_version 校验，不匹配则重新预编译 |
| 预编译耗时 | 大型 GIM 预编译可能数分钟 | 后台异步，UI 显示进度，不阻塞 Viewer（先用现有路径加载） |
| 用户磁盘占用 | .gim + .gimc 双倍占用 | 提供"清理预编译缓存"按钮；.gimc 可删除重建 |

---

## 14. 核显环境性能预算

> 用户当前开发机为核芯显卡（Intel HD/UHD 集显），与游戏独显有显著性能差异。本节给出针对核显的预算建议。

### 14.1 核显 vs 独显能力对比

| 指标 | 核显（Intel UHD） | 独显（GTX 1060） | 高端独显（RTX 3060） |
| ---- | ----: | ----: | ----: |
| 单帧 draw call 上限 | ~3000-5000 | ~10000-15000 | ~20000+ |
| 三角面/秒 | ~50M | ~150M | ~300M+ |
| 显存 | 共享系统内存（~2GB 可用） | 6GB GDDR5 | 12GB GDDR6 |
| fill rate | ~10G pixel/s | ~70G pixel/s | ~250G pixel/s |
| 顶点处理能力 | ~3 顶点/时钟 | ~9 顶点/时钟 | ~28 顶点/时钟 |

### 14.2 GIM 工作负载在核显上的预算

**demo-substation 实例数据**（修复 instanceKey 去重后）：

```text
MOD 实例数      : ~7000
STL 实例数      : ~1800
Entity 总数     : ~77000（7000 MOD × 平均 11 Entity）
三角面总数      : ~7.7M（每 Entity ~100 三角面）
```

**核显预算估算**：

| 方案 | draw call | 三角面 | 内存占用 | 核显可行性 |
| ---- | ----: | ----: | ----: | ---- |
| 现状（每 Mesh 独立） | ~77000 | 7.7M | ~280MB JS heap + ~100MB GPU | ✗ 严重超限 |
| 方案 A（Geometry 共享） | ~77000 | 7.7M | ~200MB JS heap + ~60MB GPU | ✗ draw call 仍超限 |
| 方案 B（mergeGeometries） | ~几十 | 7.7M | ~80MB JS heap + ~60MB GPU | ✓ draw call 在预算内 |
| 方案 C（InstancedMesh） | 6 | 7.7M | ~80MB JS heap + ~50MB GPU | ✓✓ 远低于预算 |

**结论**：在核显环境下，**仅方案 B 或方案 C 能彻底解决问题**。方案 A 单独不足以解决崩溃。

### 14.3 核显环境下的优化优先级

针对核显特点，优先级排序如下：

1. **draw call 优化（最高优先级）**：核显 draw call 上限低，必须用方案 B 或 C 把数量降到几十以内
2. **GPU 内存优化**：核显共享系统内存，与系统其他进程争用，需 Geometry 共享 + LRU 上限
3. **CPU 解析优化**：核显机器通常 CPU 也较弱，Worker 化解析能避免主线程阻塞
4. **三角面优化（低优先级）**：7.7M 三角面对核显不算瓶颈（核显 50M/秒 处理能力），无需 LOD

### 14.4 核显环境下的最低可接受配置

```text
draw call    ≤ 200      （核显预算 3000-5000，留充足余量）
Mesh 对象    ≤ 1000     （避免 Object3D 累积）
GPU 内存     ≤ 200MB    （核显共享系统内存）
JS heap     ≤ 200MB    （WebView2 子进程上限）
加载时间     ≤ 30 秒    （首次）；≤ 3 秒（缓存命中）
帧率         ≥ 30 fps   （核显 60fps 不现实，30fps 为可接受下限）
```

---

## 15. 综合实施路径（更新版）

基于实战教训（§10）与 A.1 实测结论（[18a](./18a-experiment-shared-geometry.md)），以及方案 A.1 实测加载 ~2 小时的性能瓶颈，更新原 §7 的实施路径：

| 阶段 | 目标 | 改动量 | 收益 | 状态 | 优先级 |
| ---- | ---- | ---- | ---- | ---- | ---- |
| 阶段 1 | 假并发修复（Promise.all） | 小 | 4× 吞吐 | 待评估 | 中 |
| 阶段 5 | Material 共享 | 已实施 | -50% Material 内存 | ✓ 已完成 | — |
| 阶段 5b | Geometry 共享 A.0（按 modPath） | 已实施 | -40% GPU 内存 | ✓ 已完成 | — |
| 阶段 5b.1 | Geometry 共享 A.1（跨 modPath） | 已实施 | -80%+ GPU 内存，解决崩溃 | ✓ 已完成 | — |
| **阶段 5c** | **mergeGeometries 静态合并（方案 B）** | **中** | **draw call 77k → 几十** | **✓ 已完成** | — |
| **阶段 5d** | **顶点烘焙修复（placement 含缩放分量）** | **低** | **GIS 设备位置正确** | **✓ 已完成** | — |
| 阶段 5e | GLTFExporter 离线预序列化（方案 C） | 中 | 二次打开秒级 | 待实施 | 最高 |
| 阶段 2 | 几何缓存表（SQLite） | 中 | 二次打开 < 1 秒 | 待实施 | 中 |
| 阶段 3 | Worker 化解析 | 中 | 主线程不阻塞 | 待实施 | 中 |
| 阶段 4 | InstancedMesh 装配 | 大 | draw call → 6 | 待实施 | 中（方案 C 一部分） |
| 阶段 6 | 预编译工具原型 | 大 | 首次打开 < 5 秒 | 待实施 | 低（长期） |
| 阶段 7 | Viewer 加载 .gimc | 中 | 跳过 XML 解析 | 待实施 | 低（长期） |

**当前优先级**：
1. **最高**：阶段 5e（方案 C GLTFExporter 离线预序列化）— 方案 B 已解决 draw call 与崩溃，但加载仍需分钟级；方案 C 把 MOD 解析+几何构造离线缓存为 .glb，二次打开跳过全部解析
2. 中：阶段 2（SQLite 几何缓存）、阶段 3（Worker 化）
3. 低：阶段 4（InstancedMesh）、阶段 6/7（预编译）

---

## 16. 参考资料

### 16.1 游戏引擎预编译参考

- Unity AssetBundle 文档 — https://docs.unity3d.com/Manual/AssetBundlesIntro.html
- Unreal Engine Pak 文件 — https://docs.unrealengine.com/5.0/en-US/unreal-engine-pak-file-system/
- glTF 2.0 规范 — https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
- gltf-transform（Node.js glTF 工具链） — https://gltf-transform.dev/
- Three.js GLTFLoader — https://threejs.org/docs/?q=GLTFLoader#GLTFLoader

### 16.2 核显性能参考

- Intel HD Graphics 性能白皮书 — https://www.intel.com/content/www/us/en/support/articles/000005524/graphics.html
- WebGL Insight（核显 WebGL 能力分析） — http://webglinsights.com/
- Three.js 性能监控 — https://threejs.org/docs/?q=Stats#Stats

### 16.3 内存与 draw call 优化

- Three.js 性能最佳实践 — https://discoverthreejs.com/book/first-steps/performance/
- WebGL Insights: BatchedMesh — https://webglinsights.com/
- Chrome DevTools Memory Profiling — https://developer.chrome.com/docs/devtools/memory-problems/

---

## 17. 内部参考

### 17.1 内部文档

- [09-transform-chain-analysis.md](./09-transform-chain-analysis.md)：完整变换链分析
- [10-substation-mod-grammar.md](./10-substation-mod-grammar.md)：MOD XML 语法
- [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md)：已知 bug（含 FIX-3 Material 共享、FIX-4 Z-up→Y-up）
- [dev.md](./dev.md)、[phm.md](./phm.md)：DEV/PHM 文件格式

### 17.2 外部资料（前 §10.3 内容，与 §16 主题区分）

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

### 17.3 关键代码位置

- [src/services/modAutoLoadService.ts](../../src/services/modAutoLoadService.ts)：现有加载编排
- [src/viewer/xmlModLoader.ts](../../src/viewer/xmlModLoader.ts)：MOD 文件 → Group
- [src/viewer/xmlModGeometry.ts](../../src/viewer/xmlModGeometry.ts)：primitive → BufferGeometry
- [src/viewer/stlLoader.ts](../../src/viewer/stlLoader.ts)：STL 解析
- [src/gim/geometry/xmlModParser.ts](../../src/gim/geometry/xmlModParser.ts)：DOMParser-based XML 解析
- [src/viewer/ifcEntryLoader.ts](../../src/viewer/ifcEntryLoader.ts)：IFC .frag 缓存参考
- [src-tauri/src/db.rs](../../src-tauri/src/db.rs)：SQLite 表结构与 Tauri 命令
- [src/app/state.ts](../../src/app/state.ts)：内存缓存字段
- [src/services/projectCleanupService.ts](../../src/services/projectCleanupService.ts)：项目切换资源释放
