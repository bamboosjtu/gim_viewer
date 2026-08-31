# 评审意见

## P0-1 模型唯一 ID：必须先解决

### 当前问题

现在 `IfcEntry` 只有：

```ts
interface IfcEntry {
  name: string;
  path: string;
  modelId: string;
}
```

而 `scanIfcFiles()` / `discoverIfcFromCBM()` 都基本采用：

```text
DEV/foo.ifc
      ↓
modelId = foo
```

也就是说：

```text
DEV/A/foo.ifc
CBM/B/foo.ifc
```

会得到同一个 `modelId=foo`。后果不只是 UI 名字冲突。`loadIfcEntry()` 第一件事就是：

```ts
if (state.loadedModels.has(modelId)) return;
```

因此第二个同名 IFC **可能直接不加载**。数据库同样规定：

```sql
UNIQUE(project_id, model_id)
```

所以问题会一路传播到持久化层。


### 修改原则

把三个概念彻底分开：

```text
entryPath     = GIM 包内真实身份
displayName   = 给人看的名称
runtimeModelId = 给 Fragments/Viewer 用的稳定唯一 ID
```

建议修改成：

```ts
interface IfcEntry {
  name: string;          // foo，纯显示
  path: string;          // DEV/A/foo.ifc，真实资源身份
  modelId: string;       // 由 path 稳定生成，不再由 basename 生成
}
```

不需要新增复杂数据库主键体系，**直接改变 `modelId` 的生成规则即可**。例如：

```text
DEV/A/foo.ifc
    ↓ normalize
DEV/A/foo.ifc
    ↓ stable encoding/hash
ifc_4f69xxxx
```

建议：

```text
modelId = "ifc_" + stableHash(normalizedEntryPath)
```

而不是：

```text
modelId = basename
```

hash 要满足：

* deterministic；
* 不依赖加载顺序；
* 同一个 GIM 二次打开结果一致；
* Windows/Linux 路径分隔符一致；
* 不直接使用随机 UUID。

### 同时必须修改的地方

不能只改 `scanIfcFiles()`。

至少同时处理：

```text
gimIndexer.ts
  scanIfcFiles
  discoverIfcFromCBM

fileDevParser.ts
  FileDevEntry.modelId

AppState
  loadedModels
  deviceToIfcFile

buildIfcGuidIndex
  IFC model + GUID 索引

propsDrawer
nodeInteractionService
highlight
ifcNameIndex

SQLite
  substation_ifc_model
  substation_file_dev_entry
  substation_fragment_cache
```

尤其这一类索引：

```text
ifcFile + ":" + GUID
```

也不能继续依赖裸文件名，否则：

```text
A/foo.ifc : GUID-X
B/foo.ifc : GUID-X
```

仍然可能碰撞。

应该统一成：

```text
modelId + ":" + GUID
```

### 还有一个隐藏 P0

`resolveIfcPath()` 当前在常见目录找不到后，会遍历所有 IFC，通过 basename 匹配并返回第一个。

以后遇到：

```text
A/foo.ifc
B/foo.ifc
```

不能“找到第一个就算成功”。

建议改为三态：

```ts
type ResolveResult =
  | { kind: 'resolved'; path: string }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; candidates: string[] };
```

`ambiguous` 应记录诊断，不能静默猜。

### P0 验收用例

分别选择实测demo下的一个变电和一个线路GIM：

```text
DEV/A/foo.ifc
DEV/B/foo.ifc
```

要求：

1. 两个 IFC 都进入 `fragments.list`；
2. 两个 `modelId` 不同；
3. UI 可以同时显示；
4. GUID → CBM 关联没有串；
5. 缓存后第二次打开仍然一致；
6. 删除/隐藏一个模型不会影响另一个。

**这一项建议最先改。**

---

## P0-2 解包大内存：从“内存解包”改成“磁盘源 + 按需读取”


### 当前真正的问题

Rust 已经做对了大半。现在 native extraction 已经能够：

```text
.gim
 ↓
Rust 7z/ZIP
 ↓
直接写：
app_data_dir/extracted/{project_id}/...
```

但是写完之后，又把所有内容重新：

```text
entry bytes
 ↓
blob.extend_from_slice
 ↓
[manifest][巨大 blob]
 ↓ IPC
ArrayBuffer
 ↓
buf.slice()
 ↓
File
 ↓
Map<string, File>
```

前端明确会为每个 entry 再 `slice()` 并创建 `File`。而 Tauri 主流程随后仍然把：

```ts
preExtracted.files
```

交给整个原有 `Map<string, File>` 解析体系。因此：

> **现在已经是 disk cache，但还不是 disk-first architecture。**

---

### 目标结构

桌面端应该变成：

```text
                    .gim
                     │
                 Rust 解压
                     │
        ┌────────────┴────────────┐
        │                         │
     manifest                  磁盘文件
        │               extracted/{projectId}/...
        │                         │
        └───────────┬─────────────┘
                    │
              GimEntrySource
                    │
       ┌────────────┼────────────┐
       │            │            │
     CBM/FAM       IFC        MOD/STL
     按需读取       按需读取      按需读取
```

不要再：

```text
整个 GIM
→ Map<string, File>
```

---

### 建议新增一个抽象

这是这次重构的核心。

```ts
interface GimEntryMeta {
  path: string;
  size: number;
  type: string;
}

interface GimEntrySource {
  list(): readonly GimEntryMeta[];
  has(path: string): boolean;

  readBytes(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
}
```

然后做两个实现：

```text
MemoryGimEntrySource
    浏览器模式
    Map<string, File>

DiskGimEntrySource
    Tauri 模式
    projectId + manifest
    ↓
    Rust 按路径读取缓存
```

这样浏览器版本完全不用推倒：

```text
Browser
Map<File>
   ↓
MemoryGimEntrySource
```

桌面端则：

```text
Rust extracted cache
   ↓
DiskGimEntrySource
```

---

### Rust command 应该改什么

现在：

```text
extract_gim_archive(...)
    ↓
tauri::ipc::Response
    ↓
manifest + 全部 blob
```

改成：

```text
extract_gim_archive(...)
    ↓
ExtractManifest
```

manifest 只包含：

```json
{
  "magic": "...",
  "projectId": "...",
  "projectName": "...",
  "entries": [
    {
      "path": "...",
      "size": 1234,
      "cachePath": "..."
    }
  ]
}
```

**projectId 存在时绝对不要附带 entry bytes。**

原来：

```rust
let mut blob = Vec<u8>
blob.extend_from_slice(...)
```

这一整条路径可以从 Tauri 主流程拿掉。


---

### 不建议一次性重写全部 parser


#### 第一步

把：

```ts
Map<string, File>
```

包起来，不再让新代码直接使用它。

#### 第二步

优先改：

```text
CBM
FAM
DEV
PHM
STD
SLD
SCH
```

这类：

```text
await file.text()
```

为：

```ts
await source.readText(path)
```

#### 第三步

IFC：

```ts
await source.readBytes(entry.path)
```

只在模型真正准备加载时读取。

#### 第四步

MOD/STL 同样改成 lazy。

最后才删除 `currentFiles` 对桌面模式的依赖。

---

### 最终内存目标

现在大致是：

```text
O(整个 GIM 解压体积)
```

最终应该接近：

```text
O(当前正在解析的最大文件)
+
O(当前运行时模型)
+
O(语义索引)
```

而不是与整个 `.gim` 展开体积线性增长。

这是 P0 的真正验收标准。

---

## P0-3 Runtime Cache 的正确性门槛

这里我会把“Runtime Cache”拆成两个等级：

> **缓存正确性属于 P0；开启缓存提升性能属于 P1。**

当前 Fragments Cache 默认是关闭的。这是正确决定，因为现在还没有完全满足我认为的缓存身份要求。

### 现有缓存键已经做对了一部分

你已经绑定：

```text
fragments-cache-v5
+
@thatopen/fragments 实际版本
+
web-ifc 实际版本
```

很好。

但 `tryLoadFromFragmentsCache()` 当前调用：

```ts
validateFragmentCache(
    projectId,
    entryPath,
    0,
    FRAG_CACHE_VERSION
)
```

这里 `sourceIfcSize=0` 明确表示**不验证 IFC 大小**。

而 Fragment 表目前也只记录：

```text
project_id
entry_path
model_id
source_ifc_size
fragment_file_size
fragments_version
```

没有记录“生成这个 fragment 时是哪一个 GIM SHA”。

---

### 建议建立统一 Artifact Identity

不需要搞一个庞大的 Cache Framework。

只统一一个原则：

```text
Runtime artifact =
    Source identity
  + Entry identity
  + Parser/runtime identity
  + Build options
```

例如 IFC Fragments：

```text
sourceGimSha256
entryPath
fragmentsVersion
webIfcVersion
coordinateToOrigin
```

GLB：

```text
sourceGimSha256
devPath
geometryCacheVersion
parserVersion
```

---

### Fragments 表建议增加

至少：

```sql
source_gim_sha256 TEXT NOT NULL
```

于是校验：

```text
projectId
+
entryPath
+
sourceGimSha256
+
fragmentsVersion
```

全部相同才允许命中。

我甚至建议不要再依赖：

```text
sourceIfcSize
```

作为主要身份。

文件大小只能做辅助检查：

```text
100 MB old.ifc
100 MB new.ifc
```

完全可能内容已经变化。GIM 本身已经计算 SHA-256，所以直接复用：

```text
session.sourceSha256
```


---

## P1-1 Runtime Cache：真正把二次打开做成 Runtime Ready

解决上述 P0 正确性之后，再启用 Fragments Cache。

当前缓存体系其实已经比较成熟：

```text
Source Cache
    extracted/

Semantic Cache
    SQLite

Geometry Runtime Cache
    GLB

IFC Runtime Cache
    .frag（目前关闭）
```

文档目前称“两层缓存”，但现在实际上已经逐渐形成第三层 Runtime Cache。

建议正式定义：

```text
Layer 1 Source Cache
原始解压资源

Layer 2 Semantic Cache
CBM/FAM/DEV/引用关系/空间索引

Layer 3 Runtime Cache
IFC → Fragments
DEV/MOD → GLB
```

不要把它们合并存储，只需要让**失效规则一致**。

---

### Fragments 应该照 GLB 的办法治理

GLB 这条线其实已经比 Fragments 成熟：

```text
source SHA
+
GEOMETRY_CACHE_VERSION
+
manifest
+
完成后才写版本标记
```

而且 progressive pipeline 已经规定：

> 有 DEV 编译或落盘失败，就不写完成版本标记，下次重新构建。

这套思想应该直接复制给 Fragments。

即：

```text
building
   ↓
写 tmp
   ↓
校验
   ↓
atomic rename
   ↓
写 DB record
   ↓
READY
```

而不要：

```text
有文件
=
缓存有效
```

---

### Fragments 的重新启用顺序

不要直接：

```ts
ENABLE_FRAGMENTS_CACHE_BASE = true
```

先继续使用现有：

```text
localStorage gray switch
```

用真实 GIM 样本跑以下矩阵：

| 场景                   | 应有结果                 |
| ---------------------- | ------------------------ |
| 第一次打开             | IFC → Fragments          |
| 第二次打开             | 不读取 IFC，直接 `.frag` |
| GIM 内容修改但路径不变 | `.frag` 必须失效         |
| fragments 升级         | 失效                     |
| web-ifc 升级           | 失效                     |
| `.frag` 截断           | 删除并回退 IFC           |
| 快速切换 GIM           | 旧项目不能污染新项目     |
| 两个同 basename IFC    | 各自命中正确 cache       |

这些通过后再默认开启。

---

## P1-2 Worker：只 Worker 化真正还在主线程的 GIM 几何编译

这里要避免一个误区：

> **项目不是“没有 Worker”。**

Fragments 已经：

```ts
ctx.fragments.init(fragmentsWorkerUrl)
```

libarchive fallback 也有 Worker。

Rust 原生解压则已经：

```rust
spawn_blocking(...)
```

所以真正值得 Worker 化的是：

```text
GIM DEV
 ↓
PHM
 ↓
MOD/STL parsing
 ↓
Three Geometry
 ↓
GLTFExporter
```

当前 `serializeDevToGlb()` 整条链仍在前端主线程：

```ts
discoverGeometriesFromDevPath()
loadXmlModFromFiles()
parseStlBinary()
...
GLTFExporter.parse()
```

现在只能靠：

```ts
await yieldToMain()
```

每个 DEV 之间让出事件循环。

这解决的是“连续卡死”，不是 CPU 与 UI 真正解耦。

---

### 推荐 Worker 边界

不要让 Worker 碰：

```text
AppState
Scene
ViewerContext
DOM
Fragments
```

Worker 应该是纯编译器：

```text
Main thread
    │
    │ CompileDevRequest
    ▼
modCompile.worker
    │
    ├─ DEV
    ├─ PHM
    ├─ MOD
    ├─ STL
    │
    ▼
GLB / GeometryIR
    │
    │ Transferable ArrayBuffer
    ▼
Main thread
    │
    ├─ GLB 落盘
    ├─ GLTFLoader
    ├─ CBM transform
    └─ add(scene)
```

这条边界最干净。

---

### Worker 不要接整个 GIM

禁止这样：

```ts
worker.postMessage({
    files: state.currentFiles
})
```

否则又回到：

```text
整个 GIM
→ structured clone
→ Worker
```

P0 内存改造就白做了。

正确的是：

```text
DEV dependency closure
```

即只给当前 DEV 编译实际需要的数据：

```text
DEV
相关 PHM
相关 MOD
相关 STL
```

然后：

```ts
postMessage(job, transferList)
```

用 `ArrayBuffer` transfer，不做复制。

---

### Worker 数量也不要按 CPU 核数开

GIM 几何是高内存任务。

建议一开始：

```text
worker pool = 1
```

稳定后：

```text
worker pool = 2
```

而不是：

```ts
navigator.hardwareConcurrency
```

否则几个大型 DEV 同时构建，很容易 CPU 很快、内存先炸。

---

### 取消机制

你现在已经有很好的：

```text
generation
session
geometryLoadToken
```

Worker 直接继承：

```ts
{
  jobId,
  generation,
  projectId,
  devPath
}
```

切项目：

```text
generation + 1
    ↓
worker.cancel(oldGeneration)
```

Worker 即使无法中断当前一个同步 parser，也必须：

```text
当前 DEV 完成
→ 发现 token 过期
→ 丢弃结果
→ 不落盘
```

不要把旧项目 GLB 写进新项目。

---

## P1-3 IFC Semantic Worker


当前：

```text
buildSubstationSpatialIndexFromFiles()
```

也会解析 IFC STEP 文本、空间关系、PropertySet 等。

理论上也适合 Worker。

但应当先实测：

```text
IFC semantic indexing
```

如果大型 GIM：

```text
> 500 ms
甚至几秒
```

再迁。

优先顺序必须是：

```text
serializeDevToGlb
        ↓
确认 UI Long Task 已明显下降
        ↓
再决定 IFC spatial parser
```

不要一开始搞两个 Worker 架构。

---

## P0：IfcLocalPlacement 建议顺手修掉


当前 `ifcSpatialParser` 对 `IFCLOCALPLACEMENT` 使用：

```text
args[0] → relative
args[1] → parent
```

但标准 IFC 的字段顺序是：

```text
PlacementRelTo
RelativePlacement
```

即应该：

```ts
parentRef = args[0]
relativeRef = args[1]
```

并计算：

```text
World = Parent × Relative
```

这是一个**纯正确性 P0**，而且改动小。

现有测试只覆盖了父级为空、纯平移，所以没有把这个问题暴露出来。

增加两个测试即可：

```text
Parent translation + child translation
```

以及更关键的：

```text
Parent rotation + child translation
```

第二个才能真正验证矩阵乘法顺序。