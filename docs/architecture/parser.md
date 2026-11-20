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
interface ParseDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  path?: string;
  line?: number;
}

interface ParseResult<T> {
  value: T | null;
  diagnostics: readonly ParseDiagnostic[];
}
```

FAM 的既有详细返回形状保留给当前 source/UI 消费者；新调用方使用 `parseFamDocument()` 获取 `ParseResult`。

## 当前迁移范围

已迁移：

- `parser/fam.ts`：FAM 物理分节、原始属性行和 malformed 诊断。
- `parser/cbm.ts`：CBM 无损文档、原始属性、ENTITYNAME/OBJECTMODELPOINTER 记录；显示名和 Tree Builder 仍归 Source/Desktop。
- `parser/dev.ts`：DEV 的 SOLIDMODEL/SUBDEVICE 槽位、块内矩阵与来源诊断。
- `parser/phm.ts`：PHM 的 SOLIDS/SOLIDMODELS 槽位、矩阵和颜色。
- `parser/substationMod.ts`：变电 XML MOD 的 Device/Entities/Entity 语法；桌面 DOM 适配和 Worker XML 读取在宿主。
- `parser/mod.ts`：MOD 格式族入口，明确区分变电 XML 与线路文本模式；线路实现仍由 `powerline-core` 共享格式源提供。
- `parser/ifcStep.ts`：IFC STEP 实体边界、引号/括号扫描、参数拆分；空间归属、坐标解释和空间索引仍在桌面 Geometry。
- `parser/sch.ts`：SCH 索引语法和 STD/SLD 条目分类；文件发现仍归桌面。
- `parser/affineMatrix.ts`：来源矩阵可用性判断，供 DEV/PHM 和 Geometry 共用。
- `parser/values.ts`：GIM 空值 sentinel 的纯格式判断。
- `source/famBusinessIdentity.ts`：`resolveSubstationBusinessIdentity()` 留在 Source 层，Parser 不导出。

保留在各自所有者，后续按“纯函数先迁移”的顺序处理：

- `desktop/src/gim/cbmParser.ts` 的 `buildCbmTree()` 仍是来源树构建器；CBM 词法/原始字段已由 `parser/cbm.ts` 提供。
- `desktop/src/gim/ifcSpatialParser.ts` 的 STEP 字符扫描已由 `parser/ifcStep.ts` 提供；`parseIfcModel` 的空间语义和索引不迁入 Parser。
- STD/SLD 目前依赖 DOM；应先在宿主提供 XML 节点适配器，再把纯语法部分下沉。MOD/IFC 几何转换同理，不能在未适配前直接变成跨平台纯解析器。

## 门禁

- `verify-capabilities.mjs` 为 `parser` 分配独立角色，并拒绝 Parser 导入 Core。
- `test-consumer.mjs` 检查根入口与 `parser` 子路径在无 `window` 环境可用。
- 新增 Parser 纯函数必须配套 `parser/__tests__/` 测试和格式/类型检查。
