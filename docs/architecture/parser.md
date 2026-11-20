# Parser 基础层

`packages/gim-sdk/src/parser/` 是五个 Core 共同依赖的低层格式解析层，不是第六个平级业务 Core，也不是独立 npm 包。

## 边界

Parser 只处理：

- 语法、原始字段值、引用字段和物理行位置。
- 语法级诊断（malformed line、截断、编码/分隔符事实）。
- 与运行环境无关的纯函数和不可变结果。

Parser 不处理：

- 业务身份、设备分类、间隔归属或工程实体绑定。
- 文件读取、归档解压、缓存、Tree Builder、Worker 或运行时调度。
- DOM、Tauri、Three、web-ifc 或第三方几何解码器的适配。

因此 `parser/` 只能依赖 `parser/`、`shared/` 和格式工具（`powerline-core` 的纯格式入口）；不得反向导入 `source/`、`semantic/`、`geometry/`、`engineering/`、`projection/` 或 `adapters/`。五个 Core 可以依赖 Parser，反向依赖由 `verify-capabilities.mjs` 拒绝。

## 契约

公开入口为 `@gim/gim-sdk/parser`，同时通过根命名空间 `parser` 暴露。核心结果形状：

```ts
type ParseStatus = 'ok' | 'partial' | 'empty' | 'unsupported' | 'failed';

interface ParseDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  path?: string;
  line?: number;
  rawValue?: string;
}

interface ParseResult<T> {
  value: T | null;
  diagnostics: readonly ParseDiagnostic[];
  status?: ParseStatus;
}
```

`ParseResult`/`ParseStatus` 是新 Parser 的统一契约，`parseCbmResult()`、`parseDevResult()`、`parsePhmResult()` 为已有专用结果提供同形诊断包装；专用结果（CBM/DEV/PHM/MOD/STD/SLD）可以保留自己的 value 结构，但必须复用 `ParseDiagnostic`，用 `status`/诊断区分成功、部分成功、空输入、未知格式和不支持格式。IFC 流式扫描保留 `count + callback`，不强制物化全量结果。原始字段和行号只在 Parser 中读取并保留，不在这里解释业务含义。

## 当前迁移范围

已迁移：

- `parser/fam.ts`：FAM 物理分节、原始属性行和 malformed 诊断。
- `parser/cbm.ts`：CBM 无损文档、原始属性、ENTITYNAME/OBJECTMODELPOINTER 记录；显示名和 Tree Builder 仍归 Source/Desktop。
- `parser/dev.ts`：DEV 的 SOLIDMODEL/SUBDEVICE 槽位、块内矩阵与来源诊断。
- `parser/phm.ts`：PHM 的 SOLIDS/SOLIDMODELS 槽位、矩阵和颜色。
- `parser/substationMod.ts`：变电 XML MOD 的 Device/Entities/Entity 语法；primitive 标签/属性由 Parser 读取，别名/几何近似映射由宿主 `xmlModPrimitiveAdapter` 提供；缺失矩阵与无效矩阵分开记录，无效矩阵保留原始值并给出 `invalid-source-matrix` 诊断。
- `parser/mod.ts`：MOD 格式族入口，明确区分变电 XML 与线路文本模式；线路实现仍由 `powerline-core` 共享格式源提供。
- `parser/ifcStep.ts`：IFC STEP 实体边界、引号/括号/注释扫描、参数拆分；字符串内的伪造实体头不会被识别，空间归属、坐标解释和空间索引仍在桌面 Geometry。
- `parser/fileDevRelation.ts`：FileDevRelation 三种厂商写法的纯文本声明和诊断；文件发现、IFC 路径/重复 basename 与 modelId 生成留在桌面适配层。
- `parser/sch.ts`：SCH 索引语法和 STD/SLD 条目分类；文件发现仍归桌面。
- `parser/std.ts` / `parser/sld.ts`：STD 拓扑和 SLD SVG 语法、白名单净化；通过 `parser/xml.ts` 的宿主 XML 适配器注入 DOM，不在 Parser 内创建 DOMParser。
- `parser/affineMatrix.ts`：来源矩阵可用性判断，供 DEV/PHM 和 Geometry 共用。
- `parser/values.ts`：GIM 空值 sentinel 的纯格式判断。
- `parser/diagnostics.ts`：把 `SourceDiagnostic` 映射为统一 `ParseDiagnostic`，并推导 `ok/partial/empty` 状态。
- `source/famBusinessIdentity.ts`：`resolveSubstationBusinessIdentity()` 留在 Source 层，Parser 不导出。

保留在各自所有者，后续按“纯函数先迁移”的顺序处理：

- `desktop/src/gim/cbmParser.ts` 的 `buildCbmTree()` 仍是来源树构建器；CBM 词法/原始字段已由 `parser/cbm.ts` 提供。
- `desktop/src/gim/ifcSpatialParser.ts` 的 STEP 字符扫描已由 `parser/ifcStep.ts` 提供；`parseIfcModel` 的空间语义和索引不迁入 Parser。
- STD/SLD 的 XML 适配器已完成：宿主只负责 DOMParser 和节点适配，语法/净化在 Parser。
- IFC 的 STEP 词法已下沉；IFC 几何/语义的 web-ifc 适配属于宿主/adapters，不在 Parser 内直接绑定 WASM。

## 门禁

- `verify-capabilities.mjs` 为 `parser` 分配独立角色，并同时检查运行时和类型依赖闭包；未知 `src/` 目录直接失败，Parser 导入 Core 被拒绝。
- `test-consumer.mjs` 检查根入口与 `parser` 子路径在无 `window` 环境可用。
- 新增 Parser 纯函数必须配套 `parser/__tests__/` 测试和格式/类型检查。
