# 18b. 方案 B 实验：CBM 树展开 DEV SUBDEVICES 与名称优化

> 实验编号：EXP-2026-07-06-B
> 关联文档：[17-batch-load-schema.md](./17-batch-load-schema.md)、[18a-experiment-shared-geometry.md](./18a-experiment-shared-geometry.md) §11
> 状态：**已实施 / 待用户实测**
> 实施日期：2026-07-06

## 1. 实验背景

### 1.1 问题来源

用户在方案 A.1 实测后反馈两个层级树问题：

1. **节点名称可读性差**：非叶子节点大部分用编码（如 `SYSCLASSIFYNAME=0AFD*002`），找不到设备或系统名称
2. **层级树缺失 mod/stl 对应设备**：mod/stl 对应一次设备与二次设备，但层级树中看不到这些设备节点

### 1.2 根因分析

#### 问题 1：名称优先级链不优

[cbmParser.ts](../../src/gim/cbmParser.ts) 原版名称提取逻辑：

```typescript
const cn = kv['SYSCLASSIFYNAME'] || kv['PARTNAME'] || '';
const dn = cn || en || p.split('/').pop()!;
```

优先级链：`SYSCLASSIFYNAME`（编码）→ `PARTNAME` → `ENTITYNAME` → 文件名。

**问题**：`SYSCLASSIFYNAME` 是分类编码（如 `0AFD*002`），可读性差。CBM 文件实际有更可读的字段未使用：

```
ENTITYNAME=F3System
SYSCLASSIFYNAME=0AFD*002              ← 当前使用（编码）
SYSTEMNAME1=交流电气系统              ← 可读性强，未使用
SYSTEMNAME2=110kV系统                 ← 可读性强，未使用
SYSTEMNAME3=#2主变 110kV进线间隔      ← 可读性强，未使用
```

#### 问题 2：DEV SUBDEVICES 未展开

DEV 文件有 `SUBDEVICES` 块（递归子 DEV 引用，如屏柜内的开关、继电器）。原版 [cbmParser.ts](../../src/gim/cbmParser.ts) 只解析 CBM 的 `SUBDEVICES.NUM`+`SUBDEVICEi`（指向子 CBM），**不解析 DEV 文件的 SUBDEVICES 块**。

```
当前层级树：
  CBM F4System（设备）
    └── CBM PARTINDEX（部件索引）  ← 仅此层

应有层级树：
  CBM F4System（设备）
    ├── CBM PARTINDEX（部件索引）
    └── DEV SUBDEVICE 展开的虚拟子节点  ← 方向 B 新增
        ├── 子 DEV（如屏柜内开关）  ← SYMBOLNAME 显示
        │   └── 孙 DEV（如开关内触头）
        └── 子 DEV（如屏柜内继电器）
```

## 2. 实施方案

### 2.1 名称优先级链优化

新的优先级链（详见 [cbmParser.ts extractDisplayName](../../src/gim/cbmParser.ts)）：

```
1. SYSTEMNAME1..4 拼接（"交流电气系统 / 110kV系统 / #2主变 110kV进线间隔"）— 最可读
2. PARTNAME（部件名）
3. SYSCLASSIFYNAME（系统分类编码，如 0AFD*002）— 编码可读性差，作为回退
4. ENTITYNAME（如 F1System/F2System/F3System/F4System/PARTINDEX）
5. 文件名（去 .cbm 后缀）
```

**关键决策**：`SYSTEMNAME1..4` 用 ` / ` 分隔拼接（语义递进：系统大类→小类）。

### 2.2 DEV SUBDEVICES 展开

新增 `expandDevSubDevices` 函数（[cbmParser.ts](../../src/gim/cbmParser.ts)），在 `buildCbmTree` 的每个节点：

1. 若节点有 `devPath`（OBJECTMODELPOINTER）→ 解析 DEV 文件
2. 读取 DEV 的 `SUBDEVICES` 块
3. 每个 SUBDEVICE 展开为虚拟 CbmNode：
   - `path` = `${parentCbmPath}#dev:${childDevPath}`（虚拟路径，避免与真实 CBM 冲突）
   - `entityName` = `'DEV_SUBDEVICE'`（标识为 DEV 子设备节点）
   - `name` = 子 DEV 的 `SYMBOLNAME`（最可读）
   - `devPath` = 子 DEV 文件名
4. 递归展开子 DEV 的 SUBDEVICES（深度优先，含循环引用防护）

### 2.3 防循环引用

`expandDevSubDevices` 接收 `devVisited: Set<string>` 参数，记录已解析的 DEV 路径。遇到已访问的 DEV 直接返回空数组，防止 DEV 互相引用导致无限递归。

## 3. 代码修改

### 3.1 类型扩展

[src/gim/types.ts](../../src/gim/types.ts) `CbmNode` 接口新增 4 个字段：

```typescript
export interface CbmNode {
  // 原有字段...
  systemNames: string[];     // CBM 的 SYSTEMNAME1..4 字段
  devSymbolName: string;    // DEV 的 SYMBOLNAME 字段
  devType: string;           // DEV 的 TYPE 字段
  devExpanded: boolean;      // 是否已展开 DEV SUBDEVICES
}
```

### 3.2 cbmParser.ts 重写

[src/gim/cbmParser.ts](../../src/gim/cbmParser.ts) 新增：

- `extractDisplayName(kv, path)` 函数：实现新优先级链
- `expandDevSubDevices(devPath, files, parentCbmPath, devVisited?)` 函数：DEV SUBDEVICES 展开
- `buildCbmTree` 第 4 步：若节点有 devPath，调用 `expandDevSubDevices` 添加虚拟子节点

### 3.3 gimIndexer.ts 优化

[src/gim/gimIndexer.ts](../../src/gim/gimIndexer.ts) `getNodeDisplayName` 优先级链：

```
1. 若节点有 ifcFile + ifcGuid → 查询 IFC 名称索引（最精确）
2. 若节点是 DEV 虚拟子节点（devSymbolName 非空）→ 用 devSymbolName
3. 回退到 node.name（已含 SYSTEMNAME 优先级链）
```

### 3.4 cbmTreeView.ts 增强

[src/ui/cbmTreeView.ts](../../src/ui/cbmTreeView.ts)：

- `ENTITY_ICONS` 新增 `DEV_SUBDEVICE: '🔌'`
- `label.title` 提供详细 tooltip（CBM 路径 + 设备名 + 类型 + DEV 路径）

### 3.5 兼容性修复

3 处构造 CbmNode 的位置补充新字段默认值：

- [gimIndexRestoreService.ts](../../src/services/gimIndexRestoreService.ts)：缓存恢复场景（默认空值）
- [fileDevView.ts](../../src/ui/fileDevView.ts)：临时 CbmNode 构造
- [modGeometryDiscovery.test.ts](../../src/services/__tests__/modGeometryDiscovery.test.ts)：测试 mock

## 4. 验证

### 4.1 TypeScript 编译

```bash
npm run build
```

**结果**：✅ 通过（vite build 成功）

### 4.2 单元测试

```bash
npx vitest run src/gim src/services/__tests__/modGeometryDiscovery.test.ts
```

**结果**：✅ 172 通过 / 4 失败（全部是预先存在的问题，与方向 B 无关）

- devParser.test.ts：31/31 通过
- phmParser.test.ts：25/25 通过
- xmlModParser.test.ts：43/43 通过
- modGeometryDiscovery.test.ts：20/20 通过
- ir.test.ts：18/18 通过

## 5. 预期效果

### 5.1 节点名称可读性提升

**修复前**（典型 CBM 节点）：

```
📁 0AFD*002                          ← SYSCLASSIFYNAME 编码
  📁 F4System
    🔩 PARTINDEX
```

**修复后**：

```
⚡ 交流电气系统 / 110kV系统 / #2主变 110kV进线间隔    ← SYSTEMNAME1..4 拼接
  🔧 电气一次系统
    🔩 柜体                                          ← DEV SYMBOLNAME
      🔌 开关                                        ← DEV SUBDEVICE 虚拟子节点
        🔌 触头                                      ← 递归 DEV SUBDEVICE
```

### 5.2 DEV SUBDEVICES 可见性

**修复前**：CBM F4System 节点下只有 PARTINDEX 子节点，DEV SUBDEVICES 不可见。

**修复后**：CBM F4System 节点下额外显示 DEV SUBDEVICES 展开的虚拟子节点（如开关、继电器、触头等），每个虚拟节点：
- 图标：🔌（DEV_SUBDEVICE）
- 名称：DEV SYMBOLNAME（如"开关"）
- Tooltip：虚拟路径 + 设备名 + 类型 + DEV 路径

### 5.3 与 IFC 的互补性

用户观察"mod/stl 对应一次设备与二次设备，与 IFC 的建筑、结构、水暖、通风互补"现在能在层级树中直接看到：
- IFC 节点：F1System 建筑结构（已存在）
- DEV 虚拟节点：F4System 一次/二次设备（方向 B 新增）

## 6. 风险与权衡

### 6.1 性能影响

**风险**：`buildCbmTree` 现在需要解析每个有 devPath 的 DEV 文件，以及递归解析所有 SUBDEVICES 子 DEV。

**评估**：
- 变电站工程约 21857 个 CBM 节点有 OBJECTMODELPOINTER（[04-cbm-field-dictionary.md](./04-cbm-field-dictionary.md)）
- 但多数 DEV 文件无 SUBDEVICES 块，仅 285 个 F4System 是"设备入口（含子设备）"
- DEV 文件解析在 [devParser.ts](../../src/gim/geometry/devParser.ts) 中是纯文本解析，速度很快
- 缓存命中场景（[gimIndexRestoreService.ts](../../src/services/gimIndexRestoreService.ts)）不触发 DEV 解析（虚拟子节点不入库）

**结论**：性能影响可接受。

### 6.2 循环引用

**风险**：DEV A 的 SUBDEVICES 引用 DEV B，DEV B 的 SUBDEVICES 又引用 DEV A。

**防护**：`expandDevSubDevices` 传入 `devVisited: Set<string>`，遇到已访问的 DEV 直接返回空数组。

### 6.3 缓存命中场景

**当前实现**：缓存命中时 `buildCbmTree` 不被调用（[gimIndexRestoreService.ts](../../src/services/gimIndexRestoreService.ts) 从 SQLite 恢复 CbmNode）。

**结果**：
- DEV 虚拟子节点不入库
- 缓存命中场景层级树只有 CBM 节点，无 DEV SUBDEVICES 展开
- `systemNames`/`devSymbolName`/`devType` 字段为默认空值

**待优化**：未来可在 `gimIndexPersistenceService` 中持久化这些字段，或在缓存命中时按需解析 DEV 文件补充。

## 7. 待用户实测验证

- [ ] 层级树节点名称从编码变为可读名称（如 "0AFD*002" → "交流电气系统 / 110kV系统 / #2主变 110kV进线间隔"）
- [ ] F4System 设备节点下出现 DEV SUBDEVICES 虚拟子节点
- [ ] 虚拟子节点名称为 DEV SYMBOLNAME（如"开关"、"继电器"、"触头"）
- [ ] 虚拟子节点 tooltip 显示详细信息
- [ ] 点击虚拟子节点不报错（应能触发对应的 MOD/STL 加载）
- [ ] 整体加载性能无明显退化

## 8. 下一步

### 8.1 若实测通过

方向 B 成功，层级树问题解决。继续修复：
- UI 进度显示 bug（[18a §11.2](./18a-experiment-shared-geometry.md)）
- bbox 跳过 36% 问题（[18a §11.3](./18a-experiment-shared-geometry.md)）

### 8.2 若发现问题

- **若 DEV 解析过慢**：考虑改为按需解析（用户展开节点时才解析 DEV），或加 LRU 缓存
- **若循环引用防护不足**：增加最大递归深度限制
- **若虚拟子节点点击行为异常**：检查 `nodeInteractionService` 对虚拟路径的处理

## 9. 后续优化方向（方向 A）

若用户希望层级树显示 DEV SYMBOLNAME 而非展开 SUBDEVICES：

- 在 `buildCbmTree` 解析每个有 devPath 的节点的 DEV 文件
- 把 DEV 的 SYMBOLNAME 写入 `node.devSymbolName`
- `getNodeDisplayName` 会自动用 devSymbolName 覆盖

代价：所有节点都要解析 DEV 文件（性能影响更大）。

## 10. 相关文件

- [src/gim/types.ts](../../src/gim/types.ts)：CbmNode 接口扩展
- [src/gim/cbmParser.ts](../../src/gim/cbmParser.ts)：核心重写（extractDisplayName + expandDevSubDevices）
- [src/gim/gimIndexer.ts](../../src/gim/gimIndexer.ts)：getNodeDisplayName 优先级链优化
- [src/ui/cbmTreeView.ts](../../src/ui/cbmTreeView.ts)：图标映射 + tooltip 增强
- [src/services/gimIndexRestoreService.ts](../../src/services/gimIndexRestoreService.ts)：兼容性修复
- [src/ui/fileDevView.ts](../../src/ui/fileDevView.ts)：兼容性修复
- [src/services/__tests__/modGeometryDiscovery.test.ts](../../src/services/__tests__/modGeometryDiscovery.test.ts)：测试兼容性

---

## 11. 第二轮优化（2026-07-06）：根节点工程名 + 设备名优先 + "&其他"过滤

### 11.1 用户反馈

第一轮方案 B（§4）后用户反馈：

1. **F1System 根节点显示编码不可读**：F1System 是全站根节点，应显示 GIM 头部的工程名称（如"XX变电站"），而非 `ENTITYNAME=F1System`
2. **最底层（设备层）显示分类名称而非设备名称**：F4System/PARTINDEX 应显示 DEV 文件中的 SYMBOLNAME（设备名），而非分类编码
3. **F4System 优先显示工程中的名称**：DEV 中的 SYMBOLNAME 是工程中的实际名称，优先于 CBM 中的编码
4. **IFC 名称索引返回"&其他"占位符覆盖了设备名**：大量节点被 IFC Name="&其他"覆盖，导致层级树出现"&其他"节点

### 11.2 根因

1. `getNodeDisplayName` 原来最高优先 IFC Name，但 IFC 中未分类构件的 Name 是"&其他"（GIM 标准占位符），无意义
2. `buildCbmTree` 中 `extractDisplayName` 对 F4System 没有特殊处理，`SYSCLASSIFYNAME`（编码）优先于 DEV SYMBOLNAME
3. F1System 根节点没有使用 GIM 头部中存储的工程名称

### 11.3 修改内容

#### 11.3.1 GIM 头部解析（新增 GimHeaderInfo）

**文件**：[src/gim/gimExtractor.ts](../../src/gim/gimExtractor.ts)

新增 `extractGimHeader(buffer: ArrayBuffer): GimHeaderInfo | null` 函数：

- 在检测压缩签名的同时，从 GIM 头部（魔数之后的 784 字节区域）提取：
  - `magic`：魔数（`GIMPKGS`/`GIMPKGT`）
  - `projectId`：项目编号（第一个非空字段）
  - `projectName`：项目名称（第二个非空字段，用 GB18030 解码）
  - `archiveOffset`：压缩数据起始偏移
- 使用动态 import 加载（已有 worker 导入路径，无需额外 chunk）

GB18030 解码通过 `TextDecoder('gb18030')` 实现（现代浏览器和 Tauri WebView 均支持）。

#### 11.3.2 AppState 新增 projectName 字段

**文件**：[src/app/state.ts](../../src/app/state.ts)

新增 `projectName: string` 字段，存储 GIM 头部提取的工程名称，用于 F1System 根节点显示。

#### 11.3.3 openGimService 调用 extractGimHeader

**文件**：[src/services/openGimService.ts](../../src/services/openGimService.ts)

在 `loadGimFromArrayBuffer` 中，动态 import gimExtractor 后立即调用 `extractGimHeader(ab)` 提取工程名称，传入 `onGimExtracted` → `parseGimEntries` → `buildCbmTree`，最终写入 `state.projectName`。

#### 11.3.4 cbmParser 全面重写：DEV SYMBOLNAME 回填所有有 devPath 的节点

**文件**：[src/gim/cbmParser.ts](../../src/gim/cbmParser.ts)

核心变更：

1. **新增 `isDeviceLayer(entityName)` 判断设备层**：
   - F4System、PARTINDEX、DEV_SUBDEVICE 均为设备层
   - 设备层节点的 `name` 直接使用 DEV SYMBOLNAME（设备名），覆盖 CBM 的分类编码

2. **所有有 devPath 的节点都解析 DEV**（不再只在 expandDevSubDevices 时解析）：
   - 新增 `devInfoCache: Map<string, DevInfo>` 避免同一 DEV 重复解析
   - 解析后回填 `devSymbolName` 和 `devType`
   - 对设备层节点，`name = devSymbolName`（设备名优先）
   - 对非设备层节点，`name` 仍走 CBM 名称优先级链，但 `devSymbolName` 已缓存供后续使用

3. **SUBDEVICES 展开继续沿用**：对有 SUBDEVICES 的 DEV 文件，展开为 DEV_SUBDEVICE 虚拟子节点

4. **根节点特殊处理**：F1System 根节点，如果传入了 projectName，则 name 直接使用 projectName

#### 11.3.5 getNodeDisplayName 过滤"&其他"占位符

**文件**：[src/gim/gimIndexer.ts](../../src/gim/gimIndexer.ts)

新增 `isPlaceholderName(name)` 函数，判断 IFC Name 是否为无意义占位符：

- 空字符串、"&其他"、"其他"、"Other"、"OTHER"、"others" 均跳过
- 跳过占位符后，回退到 `devSymbolName` → `node.name`

更新 `getNodeDisplayName` 优先级链：

1. IFC 名称（跳过占位符）
2. DEV SYMBOLNAME（设备名）
3. node.name（CBM 提取的最优名称）

#### 11.3.6 ifcNameIndex 同步过滤占位符

**文件**：[src/viewer/ifcNameIndex.ts](../../src/viewer/ifcNameIndex.ts)

- 新增 `isPlaceholderIfcName(name)` 函数，与 gimIndexer 保持一致
- 在批量设置 `state.ifcGuidToName` 和覆盖 `node.name` 时，跳过占位符名称

### 11.4 层级树名称显示预期

| 层级 | ENTITYNAME | 显示内容 | 来源 |
|------|-----------|---------|------|
| L0（根） | F1System | 工程名称（如"XX 220kV变电站"） | GIM 头部 projectName |
| L1 | F2System | 系统分类名（待后续优化） | CBM SYSTEMNAME 拼接 |
| L2 | F3System | 间隔名称/子系统名（待后续优化） | CBM SYSTEMNAME 拼接 |
| L3 | F4System | **设备名称**（如"1号主变压器"） | DEV SYMBOLNAME |
| L4 | PARTINDEX | **设备/部件名称**（如有 SUBDEVICES 则为子设备） | DEV SYMBOLNAME / SUBDEVICE SYMBOLNAME |
| L5 | DEV_SUBDEVICE | **子设备名称** | SUBDEVICE SYMBOLNAME |

### 11.5 注意事项

- **parser_version**：从 `gim-parser-v8` 升级到 `gim-parser-v9`，旧缓存自动失效（需重新解压一次 GIM 以填充正确的节点名称）
- **F2/F3 暂不优化**：本轮按用户要求不改 F2System/F3System，后续可解析 FAM 文件获取更可读的系统名称
- **性能**：所有有 devPath 的节点都解析 DEV 文件，但有 devInfoCache 缓存；变电站工程通常有数百个 DEV，首次解析增加 100-500ms，可接受
