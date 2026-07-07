# 变电工程几何可视化实现计划（P0）

> 目标：补齐变电 GIM 工程的 MOD primitive 渲染能力，使其与现有 IFC 渲染栈共存。
>
> 范围：仅 P0 4 项核心任务（IR schema + PHM 解析 + xml-mod parser + xml-mod 渲染）。
> P1（STL 渲染 / COLOR 应用 / EMPTY 提示）与 P2（装配节点提示 / TransformMatrix 应用 / 缓存回放 / 节点联动扩展）不在本计划范围。

## 1. 现状与目标

### 1.1 当前已实现（不改动）

| 能力 | 实现位置 |
|---|---|
| GIM 容器解压 | `src/gim/gimExtractor.ts` |
| CBM 层级解析 | `src/gim/cbmParser.ts` |
| FAM/DEV 解析 | `src/gim/famParser.ts` / 内联 |
| IFC 3D 渲染（OBC + web-ifc + Three.js） | `src/viewer/viewerEngine.ts` 等 |
| 节点级 IFC 懒加载 + Fragments 缓存 | `src/viewer/ifcEntryLoader.ts` |
| 3D 拾取 / 高亮 / 相机定位 | `src/viewer/selection.ts` 等 |
| 属性面板（CBM/FAM/DEV/IFC） | `src/ui/propsDrawer.ts` |

### 1.2 P0 目标

补齐以下能力：

1. **IR schema**：定义 `GimGeometrySource` 联合类型与 5 个 kind interface
2. **PHM 解析器**：解析 `SOLIDMODELS` + `TRANSFORMMATRIXn` + `COLORn`，输出 `PhmDocument`
3. **xml-mod parser**：解析 14 类 primitive（11 强类型 + 3 弱 schema fallback），输出 `XmlModDocument`
4. **xml-mod 渲染**：把 `XmlModEntity[]` 转 Three.js `BufferGeometry`，与 IFC 同一 scene

### 1.3 不在范围

- 线路 MOD 文本格式族（4 类）解析与渲染
- STL 渲染（P1）
- PHM COLOR 应用到 Fragments material（P1）
- 装配节点无几何提示（P2）
- 缓存命中回放（P2）
- 节点联动扩展（P2）

## 2. 实施顺序与依赖

```
Phase 1：IR schema 落地（src/gim/geometry/ir.ts）
   ↓ （无依赖，纯类型定义）
Phase 2：PHM 解析器（src/gim/geometry/phmParser.ts）
   ↓ （依赖 IR schema 中 PhmDocument 类型）
Phase 3：xml-mod parser（src/gim/geometry/xmlModParser.ts）
   ↓ （依赖 IR schema 中 XmlModEntity 类型）
Phase 4：xml-mod 渲染集成（src/viewer/xmlModLoader.ts + nodeInteractionService 集成）
   ↓ （依赖 Phase 2 + Phase 3 产出）
完成
```

## 3. Phase 1：IR schema 落地

### 3.1 输入

- 设计稿：[docs/schema/13-geometry-ir-schema.md](../schema/13-geometry-ir-schema.md) §2-§4
- 现有代码风格：`src/gim/types.ts`（CbmNode 简单 interface）

### 3.2 产出

**新建文件**：
- `src/gim/geometry/ir.ts`：IR schema 定义（不含解析逻辑）
- `src/gim/geometry/__tests__/ir.test.ts`：类型守卫与 type narrowing 测试

**内容范围**：

```typescript
// 顶层联合类型（引用 interface，不 inline）
export type GimGeometrySource =
  | IfcGeometrySource
  | XmlModGeometrySource
  | LineTextModGeometrySource
  | StlGeometrySource
  | NoneGeometrySource;

// 5 个 kind interface（按 13-geometry-ir-schema.md §3.1-§3.5）
export interface IfcGeometrySource { ... }
export interface XmlModGeometrySource { ... }
export interface LineTextModGeometrySource { ... }
export interface StlGeometrySource { ... }
export interface NoneGeometrySource { ... }

// 辅助类型
export type NoneReason = ...
export type LineModFormat = ...

// 14 类 primitive 联合类型（按 10-substation-mod-grammar.md §6.4）
export type XmlModPrimitive = ...
export interface XmlModEntity { ... }
export interface XmlModColor { ... }

// 实例化（按 13-geometry-ir-schema.md §4.2）
export interface GimGeometryInstance {
  source: GimGeometrySource;
  transformMatrix: number[];  // 长度 16，列主序
  color?: XmlModColor;
}

// 类型守卫（按 13-geometry-ir-schema.md §5.1）
export function isIfcSource(s: GimGeometrySource): s is IfcGeometrySource;
export function isXmlModSource(s: GimGeometrySource): s is XmlModGeometrySource;
// ... 其他 4 个守卫

// PHM 解析中间产物（Phase 2 用）
export interface PhmSolidModelEntry {
  solidModelPath: string;        // .mod / .stl 文件名
  transformMatrix: number[];    // 长度 16，列主序
  color?: XmlModColor;          // R,G,B,A 解析后；MOD 引用为空
}
export interface PhmDocument {
  phmPath: string;
  solidModels: PhmSolidModelEntry[];
  /** 14 个无 SOLIDMODEL 的空 PHM 标识 */
  isEmpty: boolean;
}
```

### 3.3 测试

- 类型守卫返回正确 boolean
- 5 个 kind 互斥
- NoneReason 9 种值覆盖

### 3.4 验收

- `tsc` 通过（strict 模式）
- `vitest run src/gim/geometry/__tests__/ir.test.ts` 通过
- 不引入运行时依赖（纯类型 + 函数）

## 4. Phase 2：PHM 解析器

### 4.1 输入

- 设计稿：[docs/schema/phm.md](../schema/phm.md)（格式详解）
- IR schema：`PhmDocument` / `PhmSolidModelEntry` / `XmlModColor`
- 现有代码风格：`src/gim/famParser.ts`（简单函数式）

### 4.2 产出

**新建文件**：
- `src/gim/geometry/phmParser.ts`：PHM 解析器
- `src/gim/geometry/__tests__/phmParser.test.ts`：测试

**核心函数**：

```typescript
export function parsePhm(text: string, phmPath: string): PhmDocument;
```

**解析逻辑**：

1. 按 `KEY=VALUE` 解析（复用 `parseKeyValue` 思路，但 PHM 不分节）
2. 读取 `SOLIDMODELS.NUM`
3. 按 index 收集 `SOLIDMODELn` + `TRANSFORMMATRIXn` + `COLORn`
4. 验证三者一一对应（缺失则 `transformMatrix` 默认单位矩阵）
5. 解析 `COLOR` 字段（`R,G,B,A` 格式，可能为空字符串）
6. 解析 `TRANSFORMMATRIX`（16 浮点逗号分隔，验证长度）
7. 输出 `PhmDocument`（含 `isEmpty` 标识）

**关键约束**：
- PHM 不分节，无 `[section]` 语法
- `COLORn` 为空字符串时 `color` 字段为 `undefined`
- `TRANSFORMMATRIXn` 缺失时回退单位矩阵
- PHM 不嵌套引用同级 PHM（实证已确认，解析器不处理此情况）

### 4.3 测试

- 单 STL 模型（NUM=1，COLOR 非空）
- 双 MOD 模型（NUM=2，COLOR 均为空）
- 无几何装配节点（NUM=0）
- 单 MOD 模型（NUM=1，COLOR 为空，变电典型）
- TRANSFORMMATRIX 缺失时回退单位矩阵
- COLOR 字段格式异常（如 "abc"）解析失败时 color=undefined
- 大小写敏感（PHM 字段名大小写敏感）

### 4.4 验收

- `tsc` 通过
- `vitest run src/gim/geometry/__tests__/phmParser.test.ts` 通过
- 不依赖 DOM / Tauri / OBC

## 5. Phase 3：xml-mod parser

### 5.1 输入

- 设计稿：[docs/schema/10-substation-mod-grammar.md](../schema/10-substation-mod-grammar.md)（14 类 primitive 字段）
- 设计稿：[docs/schema/mod.md](../schema/mod.md)（XML 结构）
- IR schema：`XmlModEntity` / `XmlModPrimitive` / `XmlModColor`

### 5.2 产出

**新建文件**：
- `src/gim/geometry/xmlModParser.ts`：XML MOD 解析器
- `src/gim/geometry/__tests__/xmlModParser.test.ts`：测试

**核心函数**：

```typescript
export function parseXmlMod(text: string, modPath: string): XmlModDocument;

export interface XmlModDocument {
  modPath: string;
  entities: XmlModEntity[];
  /** EMPTY_DEVICE_XML（44 个）标识 */
  isEmpty: boolean;
}
```

**解析逻辑**：

1. 用 `DOMParser` 解析 XML（浏览器原生 API，无新依赖）
2. 遍历 `/Device/Entities/Entity`
3. 每个 Entity 提取：
   - `id` / `type` / `visible` 属性
   - 子节点 `TransformMatrix`（16 浮点，列主序）
   - 子节点 `Color`（R/G/B/A 4 属性）
   - 子节点 primitive（按 `nodeName` 分发到 14 类）
4. 14 类 primitive 字段映射（按 10-substation-mod-grammar.md §6.4）：
   - `Cylinder`: R, H
   - `Cuboid`: L, W, H
   - `StretchedBody`: L, Array, Normal（Array/Normal 保留 string）
   - `PorcelainBushing`: R, R1, R2, H, N
   - `TruncatedCone`: BR, TR, H
   - `Ring`: R, DR, Rad
   - `TerminalBlock`: L, W, H?, T, R, BL, CL, CS, RS, CN, RN, Phase
   - `Sphere`: R
   - `ChannelSteel`: L, Model, D?, H?, B?, T?
   - `Table`: H, LL1, LL2, TL1, TL2
   - `CircularGasket`: H, Rad, OR, IR
   - 其余 3 类（`RectangularFixedPlate` / `OffsetRectangularTable` / `RectangularRing`）保留 `raw: Record<string, string>`
5. 数值字段解析：`parseFloat`，失败则保留 string（弱 schema fallback）
6. `Entities` 为空时 `isEmpty=true`

**关键约束**：
- XML root 为 `Device`，子节点 `Entities`，再子节点 `Entity`
- Entity 必含 `TransformMatrix`（除非 EMPTY_DEVICE_XML）
- Entity 可含 `Color`（实测 100%，但保留可选）
- primitive 节点 `nodeName` 大小写敏感
- `StretchedBody.Array` 格式：`"x,y,z;x,y,z;..."`，保留 string 由渲染层解析
- `StretchedBody.Normal` 格式：`"x,y,z"`，保留 string，渲染层需除以 304.8 还原单位向量

### 5.3 测试

- 单 Cylinder Entity
- 单 Cuboid Entity
- StretchedBody Entity（Array/Normal 保留 string）
- PorcelainBushing Entity（5 字段）
- TerminalBlock Entity（12 字段，含 Phase）
- ChannelSteel Entity（D/H/B/T 可选）
- EMPTY_DEVICE_XML（`<Entities />` 为空）
- 多 Entity 文件
- 数值字段解析失败时保留 string
- XML 格式异常时抛错

### 5.4 验收

- `tsc` 通过
- `vitest run src/gim/geometry/__tests__/xmlModParser.test.ts` 通过
- 不依赖 Tauri / OBC（仅 DOMParser）

## 6. Phase 4：xml-mod 渲染集成

### 6.1 输入

- Phase 2 产出的 `PhmDocument`
- Phase 3 产出的 `XmlModDocument`
- 现有 viewer：`src/viewer/viewerEngine.ts` / `viewerRuntime.ts`

### 6.2 产出

**新建文件**：
- `src/viewer/xmlModGeometry.ts`：primitive → Three.js BufferGeometry 转换
- `src/viewer/xmlModLoader.ts`：MOD 文件加载入口（读 buffer → parseXmlMod → 转 Three.Mesh → 入 scene）
- `src/viewer/__tests__/xmlModGeometry.test.ts`：几何转换测试

**修改文件**：
- `src/services/nodeInteractionService.ts`：节点点击时，如 CBM 节点带 OBJECTMODELPOINTER（DEV），且 DEV 引用 PHM，且 PHM 引用 .mod 文件 → 调用 xmlModLoader 加载
- `src/services/openGimService.ts`：首次打开时，遍历 PHM 引用 .mod 的，预解析（可选，按需懒加载）

**核心函数**：

```typescript
// xmlModGeometry.ts
export function primitiveToGeometry(p: XmlModPrimitive): THREE.BufferGeometry;
export function entityToMesh(e: XmlModEntity): THREE.Mesh;
export function xmlModDocumentToGroup(doc: XmlModDocument): THREE.Group;

// xmlModLoader.ts
export async function loadXmlMod(
  modPath: string,
  files: Map<string, File> | null,
  cachedPath?: string
): Promise<THREE.Group>;
```

**14 类 primitive 几何转换**：

| Primitive | Three.js 几何 |
|---|---|
| Cylinder | `CylinderGeometry(r, r, h, 32)` |
| Cuboid | `BoxGeometry(l, w, h)` |
| StretchedBody | `ExtrudeGeometry`（按 Array 点 + Normal 方向拉伸 L） |
| PorcelainBushing | `LatheGeometry`（按 R/R1/R2/N 生成伞盘轮廓） |
| TruncatedCone | `CylinderGeometry(br, tr, h, 32)` |
| Ring | `TorusGeometry(r, dr/2, 16, 32, rad)` |
| TerminalBlock | `BoxGeometry(l, w, h)` + 端子细节 |
| Sphere | `SphereGeometry(r, 32, 16)` |
| ChannelSteel | `ExtrudeGeometry`（按 Model 字符串查型号表，C5 等） |
| Table | `BoxGeometry` 组合（H + 4 腿 LL1/LL2/TL1/TL2） |
| CircularGasket | `TorusGeometry` |
| 弱 schema 3 类 | `BoxGeometry` 占位 + 控制台 warn |

**关键约束**：
- TransformMatrix 应用：`mesh.applyMatrix4(new THREE.Matrix4().fromArray(e.transformMatrix).transpose())`
  - 注：GIM 矩阵为列主序，Three.js `Matrix4.fromArray` 默认列主序，无需 transpose
  - 实测 PHM TRANSFORMMATRIX 100% IDENTITY，但保留应用逻辑
- Color 应用：`mesh.material.color.setRGB(r/255, g/255, b/255)` + `material.opacity = a/100`
- 单位：毫米，渲染层不做单位换算（与 IFC 保持一致）
- StretchedBody.Normal 需除以 304.8 还原单位向量

### 6.3 集成点

修改 `nodeInteractionService.ts`：

```typescript
// 现有逻辑（保留）：
//   if (node.ifcFile) → loadIfcEntry → highlightIfcFromNode

// 新增逻辑：
//   if (node.devPath) → 读 DEV → 收集 SOLIDMODEL → 读 PHM → 遍历 SOLIDMODELn
//     .ifc → 现有 ifcLoader
//     .mod → loadXmlMod → mesh 入 scene → highlight
//     .stl → P1 实现（暂跳过）
```

### 6.4 测试

- Cylinder → CylinderGeometry 顶点数正确
- Cuboid → BoxGeometry 尺寸正确
- StretchedBody → ExtrudeGeometry 拉伸方向正确
- TransformMatrix 单位矩阵 → mesh 不变形
- TransformMatrix 平移 → mesh.position 正确
- Color 应用 → material.color / opacity 正确
- EMPTY_DEVICE_XML → Group 为空

### 6.5 验收

- `tsc` 通过
- `vitest run src/viewer/__tests__/xmlModGeometry.test.ts` 通过
- 手动验证：打开 demo-substation，点击带 MOD primitive 的设备节点，3D 视图出现几何

## 7. 文档同步策略

每个 Phase 完成后同步更新：

| 文档 | 更新内容 |
|---|---|
| `docs/gim_substation.md` §0 | 对应行从 ❌ 改为 ✅ |
| `docs/schema/13-geometry-ir-schema.md` | 顶部追加"实现状态"小节 |
| `docs/plans/substation-geometry-impl.md` | 标记 Phase 完成 |
| `docs/schema/10-substation-mod-grammar.md` | 末尾追加"实现对照"小节 |
| `docs/schema/phm.md` | 末尾追加"实现对照"小节 |

## 8. 风险点

| 风险 | 缓解 |
|---|---|
| 9 类低样本 primitive 字段未完全拆解 | 保留弱 schema fallback，渲染层用 BoxGeometry 占位 + warn |
| 86 个变电 STL+MOD 并存 PHM 是否重复 | 本期不实现 STL（P1），MOD 优先；P1 时评估去重策略 |
| StretchedBody.Normal 长度恒为 304.8 | 渲染层除以 304.8 还原单位向量 |
| StretchedBody.Array 点数 3-46 | ExtrudeGeometry 支持 3+ 点，无问题 |
| ChannelSteel.Model 字符串未映射型号表 | 用 BoxGeometry 占位 + warn，待型号表补充 |
| PHM TRANSFORMMATRIX 100% IDENTITY | 保留应用逻辑，未来样本变化无需返工 |
| DOMParser 在 Vitest 环境不可用 | 用 `jsdom` 或 `happy-dom` 作为 test environment |

## 9. 测试环境

### 9.1 Vitest 配置

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',  // DOMParser 需要
    globals: true,
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
```

### 9.2 devDependencies 新增

- `vitest`
- `jsdom`
- `@types/three`（已有）

### 9.3 package.json scripts

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

## 10. 进度追踪

| Phase | 状态 | 产出 |
|---|---|---|
| Phase 1：IR schema | ✅ 已完成 | `src/gim/geometry/ir.ts`（18 个测试通过，tsc 通过） |
| Phase 2：PHM 解析器 | ✅ 已完成 | `src/gim/geometry/phmParser.ts`（25 个测试通过，tsc 通过） |
| Phase 3：xml-mod parser | ✅ 已完成 | `src/gim/geometry/xmlModParser.ts`（43 个测试通过，tsc 通过） |
| Phase 4：xml-mod 渲染集成 | ✅ 已完成 | 4.1 devParser（31 测试） + 4.2/4.3 xmlModGeometry（34 测试） + 4.4 xmlModLoader/modGeometryDiscovery（35 测试） + 4.5 state/cleanup/nodeInteraction 集成（disposeXmlModGroup 3 测试） + 4.6 文档同步。全部 189 测试通过，tsc 通过。 |

### 10.1 Phase 4 子任务明细

| 子任务 | 状态 | 产出 |
|---|---|---|
| 4.1 devParser | ✅ | `src/gim/geometry/devParser.ts` + 31 测试（SOLIDMODELS/SUBDEVICES 独立索引、行主序矩阵） |
| 4.2 xmlModGeometry | ✅ | `src/viewer/xmlModGeometry.ts`（14 类 primitive → BufferGeometry 转换） |
| 4.3 xmlModGeometry 测试 | ✅ | `src/viewer/__tests__/xmlModGeometry.test.ts`（34 测试：geometry 尺寸、transform 应用、color sRGB hex、StretchedBody 拉伸方向） |
| 4.4 xmlModLoader + modGeometryDiscovery | ✅ | `src/viewer/xmlModLoader.ts`（loadXmlModFromText/Files + applyPlacementTransformToSceneUnits + disposeXmlModGroup） / `src/services/modGeometryDiscovery.ts`（CBM→DEV→PHM→MOD 引用链发现） / 35 测试 + vitest.setup.ts Blob polyfill |
| 4.5 state + cleanup + nodeInteraction 集成 | ✅ | `state.ts` 新增 loadedXmlModGroups / `projectCleanupService.ts` 新增 dispose 逻辑 / `nodeInteractionService.ts` 新增 loadXmlModForNode（无 IFC 但有 devPath 时回退 xml-mod） / 3 dispose 测试 |
| 4.6 tsc + 全部测试 + 文档同步 | ✅ | 189 测试通过，tsc 通过；同步 gim_substation.md §0、plan §10、schema/phm.md、schema/10-substation-mod-grammar.md、schema/13-geometry-ir-schema.md（新增 §0 实现状态） |

## 11. 验收标准

P0 全部完成的验收标准：

1. `npm run build`（tsc + vite build）通过
2. `npm test`（vitest run）全部通过
3. 打开 demo-substation，CBM 树显示
4. 点击带 MOD primitive 的设备节点（如绝缘子 / 套管），3D 视图出现几何
5. IFC 渲染不受影响（既有路径保留）
6. 文档已同步更新（gim_substation.md §0、schema 文档"实现对照"）
