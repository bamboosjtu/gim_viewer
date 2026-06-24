当前项目已经完成：
1. Tauri 文件选择
2. Rust 文件读取
3. GIM FileInfo + sha256
4. SQLite gim_project
5. GIM 轻量索引入库：
   - gim_entry
   - cbm_node
   - ifc_model
   - file_dev_entry
6. IFC 文件缓存到 AppData/extracted/{projectId}/...
7. gim_entry.local_cache_path 保存 IFC 缓存路径

下一轮目标：实现完整缓存命中功能。

目标效果：
第二次打开同一个 GIM 时，如果 SQLite 中已有索引且 IFC 缓存文件存在：
- 不读取原始 GIM 大文件
- 不执行 extractGimFile
- 直接从 SQLite 恢复层级树、文件设备关系、IFC 列表
- 弹出 IFC 选择框
- 用户勾选 IFC 后，从 local_cache_path 读取 IFC 缓存文件并加载模型

注意：
如果缓存不完整、缓存文件不存在、索引为空，则自动回退到现有完整解压流程。

本轮允许改动：
- Rust DB 查询 command
- 前端 database 桥接
- AppState
- openGimService
- 新增 restore service
- loadSelectedIfcFiles 支持缓存路径

本轮禁止：
- 不做 Fragments 缓存
- 不做 IFC 属性数据库缓存
- 不改 UI DOM 结构
- 不改 GIM 解压逻辑
- 不删除浏览器模式 input file 逻辑
- 不破坏当前完整解压流程

====================
一、Rust 侧：新增完整索引读取 command
====================

在 src-tauri/src/db.rs 中新增以下 Record 结构和 command。

1. GimEntryRecord

字段：
- id: i64
- project_id: i64
- entry_path: String
- file_name: String
- entry_type: String
- file_size: u64
- local_cache_path: Option<String>
- created_at_ms: u64

2. FileDevEntryRecord

字段：
- id: i64
- project_id: i64
- model_id: String
- ifc_name: String
- ifc_file: String
- device_count: i64
- device_cbm: String
- sort_order: i64
- created_at_ms: u64

3. GetGimIndexResult

字段：
- entries: Vec<GimEntryRecord>
- cbm_nodes: Vec<CbmNodeRecord>
- ifc_models: Vec<IfcModelRecord>
- file_dev_entries: Vec<FileDevEntryRecord>

如果已有 CbmNodeRecord / IfcModelRecord，可以复用。

新增 command：

get_gim_index(project_id: i64) -> Result<GetGimIndexResult, String>

要求：
- 查询 gim_entry 全量记录，ORDER BY entry_path ASC
- 查询 cbm_node 全量记录，ORDER BY parent_key ASC, sort_order ASC, id ASC
- 查询 ifc_model 全量记录，ORDER BY model_id ASC
- 查询 file_dev_entry 全量记录，ORDER BY model_id ASC, sort_order ASC
- 返回 GetGimIndexResult

新增 command：

validate_gim_cache(project_id: i64) -> Result<GimCacheValidation, String>

GimCacheValidation 字段：
- project_id: i64
- has_index: bool
- ifc_models_count: u64
- cached_ifc_count: u64
- missing_cache_paths: Vec<String>
- valid: bool

逻辑：
- 查询 ifc_model 数量
- 查询 gim_entry 中 entry_type='IFC' 的记录
- 对每条 IFC 记录检查 local_cache_path 是否存在且文件存在
- cached_ifc_count = 存在缓存文件的 IFC 数量
- missing_cache_paths = 缺失缓存路径或文件不存在的 entry_path
- valid = has_index && ifc_models_count > 0 && missing_cache_paths.is_empty()

has_index 规则：
- cbm_node 或 ifc_model 有记录即可

注意：
validate_gim_cache 必须使用 std::path::Path::exists 检查 local_cache_path。

====================
二、lib.rs 注册 command
====================

在 invoke_handler 中注册：
- db::get_gim_index
- db::validate_gim_cache

保留已有 command，不要删除。

====================
三、前端 database.ts 增加桥接
====================

在 src/desktop/database.ts 中新增 interface：

export interface GimEntryRecord {
  id: number;
  project_id: number;
  entry_path: string;
  file_name: string;
  entry_type: string;
  file_size: number;
  local_cache_path: string | null;
  created_at_ms: number;
}

export interface FileDevEntryRecord {
  id: number;
  project_id: number;
  model_id: string;
  ifc_name: string;
  ifc_file: string;
  device_count: number;
  device_cbm: string;
  sort_order: number;
  created_at_ms: number;
}

export interface GimIndexResult {
  entries: GimEntryRecord[];
  cbm_nodes: CbmNodeRecord[];
  ifc_models: IfcModelRecord[];
  file_dev_entries: FileDevEntryRecord[];
}

export interface GimCacheValidation {
  project_id: number;
  has_index: boolean;
  ifc_models_count: number;
  cached_ifc_count: number;
  missing_cache_paths: string[];
  valid: boolean;
}

新增函数：
- getGimIndex(projectId: number): Promise<GimIndexResult>
- validateGimCache(projectId: number): Promise<GimCacheValidation>

内部用 invoke 调 Rust command。

====================
四、AppState 增加缓存路径状态
====================

修改 src/app/state.ts。

新增字段：

cachedIfcPaths = new Map<string, string>();

说明：
- key = IfcEntry.path，也就是 GIM 内部 entry_path
- value = local_cache_path

resetGimState() 中清空：
this.cachedIfcPaths.clear();

不要影响 loadedModels。

====================
五、新增缓存恢复服务
====================

新增文件：

src/services/gimIndexRestoreService.ts

实现：

restoreGimIndexToState(
  state: AppState,
  index: GimIndexResult,
): void

功能：

1. 恢复 currentIfcEntries

从 index.ifc_models 构造 IfcEntry[]：

{
  name: record.name,
  path: record.entry_path,
  modelId: record.model_id
}

赋值：
state.currentIfcEntries = ...

2. 恢复 cachedIfcPaths

遍历 index.entries：
- 只处理 entry_type === 'IFC'
- local_cache_path 不为空时：
  state.cachedIfcPaths.set(entry.entry_path, entry.local_cache_path)

3. 恢复 CBM 树

从 index.cbm_nodes 构造 CbmNode。

CbmNode 类型字段：
- path
- name
- entityName
- children
- famPath
- devPath
- ifcFile
- ifcGuid
- classifyName
- transformMatrix

字段映射：
- entityName = record.entity_name || ''
- classifyName = record.classify_name || ''
- famPath = record.fam_path || ''
- devPath = record.dev_path || ''
- ifcFile = record.ifc_file || ''
- ifcGuid = record.ifc_guid || ''
- transformMatrix = record.transform_matrix || ''

构造逻辑：
- 先用 node_key 建 Map<string, CbmNode>
- 再按 parent_key 组装 children
- 每组 children 按 sort_order 排序
- root 优先选择 path === 'CBM/project.cbm'
- 如果没有 CBM/project.cbm，则选择 parent_key == null 的第一个节点
- 如果仍没有 root，则 state.currentCbmTree = null

赋值：
state.currentCbmTree = root

4. 重建索引

复用现有函数：
- buildIfcGuidIndex(state.currentCbmTree)
- buildCbmNodeIndex(state.currentCbmTree)

赋值：
state.ifcGuidIndex = ...
state.cbmNodeIndex = ...

5. 恢复 FileDevRelation

从 index.file_dev_entries 按 model_id + ifc_name + ifc_file 分组。

每组构造 FileDevEntry：
{
  modelId,
  ifcName,
  ifcFile,
  deviceCount,
  deviceCbms: 按 sort_order 排序后的 device_cbm 数组
}

赋值：
state.fileDevRelations = ...

6. 重建 deviceToIfcFile

遍历 state.fileDevRelations：
for each deviceCbm:
  state.deviceToIfcFile.set(deviceCbm, entry.modelId)

7. currentFiles

缓存命中时不设置 currentFiles。
可以设为 null：
state.currentFiles = null;

说明：
命中后 FAM/DEV 原文属性暂时不可用，这是可以接受的。
基本属性、CBM 树、文件设备、IFC 加载必须可用。

====================
六、修改 loadSelectedIfcFiles 支持缓存 IFC
====================

修改 src/services/openGimService.ts 中 loadSelectedIfcFiles。

当前逻辑只支持：
state.currentFiles.get(entry.path).arrayBuffer()

需要改成：

async function getIfcBufferForEntry(entry: IfcEntry, state: AppState): Promise<Uint8Array | null>

逻辑：

1. 如果 state.currentFiles 存在，并且 state.currentFiles.get(entry.path) 存在：
   - 用原来的 file.arrayBuffer()
   - 返回 Uint8Array

2. 否则如果 isTauri() 且 state.cachedIfcPaths.has(entry.path)：
   - const cachePath = state.cachedIfcPaths.get(entry.path)!
   - const { readCacheFile } = await import('../desktop/database.js')
   - const bytes = await readCacheFile(cachePath)
   - readCacheFile 当前返回 Uint8Array
   - 返回 bytes

3. 否则：
   - console.warn('找不到 IFC 文件内容或缓存:', entry)
   - return null

然后 loadSelectedIfcFiles 中：

for selected entry:
  const buffer = await getIfcBufferForEntry(entry, state)
  if (!buffer) continue
  showLoading(...)
  await loadIfcBuffer(...)

注意：
不要因为 state.currentFiles 为 null 就 break。
现在缓存命中时 state.currentFiles 可能为 null，但仍应该能从 cachedIfcPaths 读取 IFC。

====================
七、修改 openGimService：实现缓存命中分支
====================

在 Tauri 分支中，现有流程大致是：

filePath = await openGimFilePath()
getFileInfo(filePath)
upsertGimProject(info)
getGimIndexStats(record.id)
readFileBytes(filePath)
openGimFromArrayBuffer(... persistIndex=true)

请改成：

1. 选择文件后：
showLoading('正在读取 GIM 文件信息...')
getFileInfo(filePath)
upsertGimProject(info)

2. 查询缓存状态：
showLoading('正在检查本地缓存...')
const { validateGimCache, getGimIndex } = await import('../desktop/database.js')
const validation = await validateGimCache(record.id)
console.log('[Tauri] GIM 缓存校验:', validation)

3. 如果 validation.valid 为 true：
   - showLoading('正在从本地缓存恢复 GIM 索引...')
   - const index = await getGimIndex(record.id)
   - const { restoreGimIndexToState } = await import('./gimIndexRestoreService.js')
   - restoreGimIndexToState(state, index)
   - buildAndRenderCbmTree(ctx, state, showMessage)
   - renderFileDevPanel(ctx, state, showMessage)
   - hideLoading()
   - openIfcModal(state.currentIfcEntries)
   - console.log('[Tauri] 已从缓存恢复 GIM:', {
       ifc_models: state.currentIfcEntries.length,
       cbm_root: state.currentCbmTree?.path,
       cached_ifc: state.cachedIfcPaths.size
     })
   - return

4. 如果 validation.valid 为 false：
   - console.log('[Tauri] 缓存无效，走完整解压流程:', validation)
   - 继续现有 readFileBytes + openGimFromArrayBuffer(... persistIndex=true)

注意：
如果 getGimIndex 或 restoreGimIndexToState 抛错：
- catch 住错误
- console.warn('[Tauri] 缓存恢复失败，回退完整解压:', err)
- 回退 readFileBytes + openGimFromArrayBuffer

5. 浏览器模式不受影响。

====================
八、缓存命中后的功能验收
====================

运行：

npm run build
npm run tauri:dev

验收步骤：

1. 清空旧缓存可选，不强制。
2. 第一次打开某个 GIM：
   - validateGimCache 应显示 invalid 或 missing
   - 走完整解压流程
   - 写入 GIM 索引
   - 缓存 IFC 文件
   - IFC 选择框弹出
   - 加载模型正常

3. 第二次打开同一个 GIM：
   - validateGimCache.valid = true
   - 不应显示“正在读取 GIM 文件...”或“正在解压 GIM 文件...”
   - 应显示“正在从本地缓存恢复 GIM 索引...”
   - 左侧层级树能显示
   - 文件设备面板能显示
   - IFC 选择框能弹出
   - 勾选 IFC 后能从 local_cache_path 加载模型

4. 第二次打开时控制台应打印：
   - [Tauri] GIM 缓存校验
   - [Tauri] 已从缓存恢复 GIM

5. 删除 extracted/{projectId}/ 下某个 IFC 后再次打开：
   - validateGimCache.valid = false
   - 自动回退完整解压流程
   - 不崩溃

6. 浏览器模式：
   npm run dev
   打开 GIM 仍走原 input file + 解压流程
   不调用 Tauri database / cache command

====================
九、必须保留的回退路径
====================

如果任何缓存恢复环节失败，都不能中断用户加载。
必须回退到：

readFileBytes(filePath)
openGimFromArrayBuffer(ctx, state, fileName, ab, showMessage, {
  projectId: record.id,
  persistIndex: true,
})

即：缓存只是加速路径，不是唯一加载路径。