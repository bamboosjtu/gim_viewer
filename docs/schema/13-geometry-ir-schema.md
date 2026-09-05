# 统一 Geometry IR

> Geometry IR 是 `gim/` 解析层与变电/线路展示层之间的稳定数据契约。
> 它不依赖 UI、Three.js 或 OBC；当前实现以 `desktop/src/gim/geometry/ir.ts`、
> `desktop/src/gim/geometry/xmlModParser.ts`、`desktop/src/gim/geometry/lineModParser.ts`
> 为准。

## 1. 顶层模型

每个 CBM 节点可以关联一个或多个几何实例。`source.kind` 区分来源，
`GimGeometryInstance` 保存 placement 级变换和颜色覆盖：

```typescript
export type GimGeometrySource =
  | IfcGeometrySource
  | XmlModGeometrySource
  | LineTextModGeometrySource
  | StlGeometrySource
  | NoneGeometrySource;

export interface GimGeometryInstance {
  source: GimGeometrySource;
  transformMatrix?: number[]; // 16 个数，列主序
  color?: { r: number; g: number; b: number; a: number };
  phmPath: string;
  solidModelIndex: number;
}

export interface CbmGeometryBundle {
  cbmPath: string;
  entityName: string;
  instances: GimGeometryInstance[];
  ifcModelIds: string[];
}
```

## 2. 来源类型

### 2.1 IFC

```typescript
export interface IfcGeometrySource {
  kind: "ifc";
  ifcFile: string;
  ifcGuid?: string;
  modelId: string;
  cachedPath?: string;
}
```

IFC 由 OBC Fragments 加载；空间语义索引只保留导航所需对象和 placement 闭包，
属性详情由 Fragments `getItemsData()` 按需读取。

### 2.2 变电 XML MOD

```typescript
export interface XmlModGeometrySource {
  kind: "xml-mod";
  entities: XmlModEntity[];
  modPath: string;
}

export interface XmlModEntity {
  id: number;
  type: "simple";
  visible: boolean;
  primitive: XmlModPrimitive;
  transformMatrix: number[]; // 列主序
  color?: XmlModColor;
}

export interface XmlModColor {
  r: number;
  g: number;
  b: number;
  a: number;
}
```

当前 parser 对常见 primitive 做强类型解析，对低频或未知类型保留原始字段的弱
schema fallback；单个未知 primitive 不阻塞同一 MOD 中其它实体。

### 2.3 线路文本 MOD

```typescript
export type LineModFormat =
  | "text-hnum-comma-record"
  | "text-point-line"
  | "text-section-kv-record"
  | "text-key-value";

export interface LineTextModGeometrySource {
  kind: "line-text-mod";
  format: LineModFormat;
  modPath: string;
  records: unknown;
}
```

四类记录分别由 HNum、Point/Line、Section-KV 和 Key-Value parser 处理，属性面板
按 `format` 分发。线路不把这些记录创建为独立 3D Viewer；HNum 只用于来源页的
局部骨架预览。

### 2.4 STL 与空结果

```typescript
export interface StlGeometrySource {
  kind: "stl";
  stlPath: string;
  format: "binary";
  triangleCount: number;
  header?: string;
}

export interface NoneGeometrySource {
  kind: "none";
  reason: NoneReason;
  detail?: string;
}
```

`stlLoader.ts` 在进入 IR/渲染前同时识别 binary 和 ASCII STL；IR 的 `format` 保持
当前统一的 binary 资源标记。

`NoneReason` 至少覆盖 `empty-device-xml`、`phm-no-solidmodel`、
`assembly-node-without-own-geometry`、`phm-missing-target`、
`cbm-no-objectmodelpointer`、`dev-no-solidmodel`、`parser-unsupported` 和
`parse-failed`。空结果是可观察的解析结果，不应被误报为成功几何；对应 UI 提示
仍由 [dev-log.md](../dev-log.md) 管理。

## 3. 变换与颜色规则

- DEV、PHM、CBM、SUBDEVICE 的 `TRANSFORMMATRIX` 统一按 16 个浮点数列主序解释，
  在实例级累积后烘焙到顶点或 Three.js 对象。
- PHM `COLORn` 与 `SOLIDMODELn` 一一对应；颜色在实例材质上覆盖 MOD 自带颜色。
  `max(A)>100` 使用字节制，否则使用百分制；`A=0` 按不透明哨兵处理。
- 同一 source 可以产生多个 `GimGeometryInstance`，实例必须保留各自的矩阵和颜色。
  当前不共享可变 `BufferGeometry`，避免 placement 修改相互污染。

## 4. 解析上下文

```typescript
export interface GeometryParseContext {
  currentFiles: Map<string, File> | null;
  cachedIfcPaths: Map<string, string>;
  cachedGeometryPaths: Map<string, string>;
  projectId?: number;
}

export interface GeometryParser {
  resolveBundle(
    cbmNode: import("../types.js").CbmNode,
    context: GeometryParseContext,
  ): Promise<CbmGeometryBundle>;

  resolveBundles(
    cbmTree: import("../types.js").CbmNode,
    context: GeometryParseContext,
  ): Promise<Map<string, CbmGeometryBundle>>;
}
```

`currentFiles` 可来自浏览器内存 Map 或 Tauri `DiskBackedFile`；缓存命中时通过
`projectId + entry_path` 按需读取磁盘源文件。解析层不得依赖 AppState、DOM 或
ViewerContext。

## 5. 当前消费路径

| 来源 | 解析入口 | 当前消费方 |
|---|---|---|
| IFC | `ifcEntryLoader.ts` / Spatial Core | OBC Fragments、空间树、IFC 属性面板 |
| 变电 XML MOD | `xmlModParser.ts` | DEV GLB 管线、MOD/STL 实例回放 |
| 线路文本 MOD | `lineModParser.ts` | 线路属性面板、HNum 来源预览 |
| STL | `stlLoader.ts` | 变电 DEV GLB 管线、来源追溯 |
| none | 各来源链 parser | 诊断和无几何提示（提示 UI 尚未完成） |

## 6. 兼容边界

- Geometry IR 不替代 `CbmNode.ifcFile`、`CbmNode.ifcGuid` 等既有字段，只在解析时
  消费它们。
- IR 不规定 SQLite geometry BLOB、shared geometry、Worker 调度或预编译容器；这些
  不属于当前实现契约。
- 新增 primitive 或 `NoneReason` 时，先更新类型、parser、属性字典和测试；未知
  字段保留原值，不根据单一样本臆造业务含义。
