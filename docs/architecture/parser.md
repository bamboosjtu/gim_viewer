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
- `parser/values.ts`：GIM 空值 sentinel 的纯格式判断。
- `source/famBusinessIdentity.ts`：`resolveSubstationBusinessIdentity()` 留在 Source 层，Parser 不导出。

保留在各自所有者，后续按“纯函数先迁移”的顺序处理：

- `desktop/src/gim/cbmParser.ts` 的 `buildCbmTree()` 是来源树构建器，仍归 `desktop/src/gim/`；其纯词法/引用字段解析可再下沉。
- `desktop/src/gim/ifcSpatialParser.ts` 的 STEP 扫描可下沉；空间归属、坐标解释和空间索引仍归 Geometry/Source 运行时。
- DEV/PHM/MOD 解析与 IFC 几何转换保留在桌面端，待去掉 DOM/Worker/第三方解码器依赖后再适配。

## 门禁

- `verify-capabilities.mjs` 为 `parser` 分配独立角色，并拒绝 Parser 导入 Core。
- `test-consumer.mjs` 检查根入口与 `parser` 子路径在无 `window` 环境可用。
- 新增 Parser 纯函数必须配套 `parser/__tests__/` 测试和格式/类型检查。
