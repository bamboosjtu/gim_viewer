# 日志与诊断说明

> GIM 阅读器的日志分类、运行时开关与诊断工具使用说明。

## 日志分类

| 分类标识 | 常量 | 覆盖范围 |
|---------|------|---------|
| `runtime` | `DEBUG_RUNTIME_LOGS` | 工程类型识别、cleanup 统计、线路图构建、通用运行时诊断 |
| `ifc` | `DEBUG_IFC_LOAD` | IFC Engine 初始化、IFC Buffer 字节、IFC Loader 校验、WASM 路径、高亮、名称索引、相机定位 |
| `gim-cache` | `DEBUG_GIM_CACHE` | GIM 索引读写、缓存校验/恢复、线路图缓存、FAM/DEV 属性持久化/恢复 |
| `line-map` | `DEBUG_LINE_MAP` | Canvas 地图渲染、图层开关、focus 定位、LineMapData 提取 |
| `fragments` | `DEBUG_FRAGMENTS` | Fragments update 异常详情（safeFragmentsUpdate）、unhandledrejection |

## 默认行为

| 模式 | debug 日志 | console.error | 关键 warning |
|------|-----------|--------------|-------------|
| 开发模式（`npm run dev` / `tauri:dev`） | ✅ 全部开启 | ✅ 始终输出 | ✅ 始终输出 |
| 生产模式（`npm run build` / `tauri:build`） | ❌ 全部关闭 | ✅ 始终输出 | ✅ 始终输出 |

**始终输出的 warning（不受 debug 开关控制）：**

- IFC 缓存字节为空（缓存损坏）
- IFC 文件头非 ISO- 前缀（缓存可能损坏）
- Fragments 缓存校验失败 / 读取失败 / 反序列化失败
- payload 过大警告
- 缓存恢复失败回退完整解压

## localStorage override（生产排障）

生产环境下，开发者可通过 localStorage 临时开启 debug 日志，无需重新构建。

### 开启指定分类

```js
// 开启 IFC 和 Fragments 相关日志
localStorage.setItem('GIM_DEBUG', '1')
localStorage.setItem('GIM_DEBUG_CATEGORIES', 'ifc,fragments')
location.reload()
```

### 开启全部分类

```js
// GIM_DEBUG=1 且不设置 GIM_DEBUG_CATEGORIES → 全部开启
localStorage.setItem('GIM_DEBUG', '1')
location.reload()
```

### 关闭

```js
localStorage.removeItem('GIM_DEBUG')
localStorage.removeItem('GIM_DEBUG_CATEGORIES')
location.reload()
```

### 规则总结

| 条件 | 结果 |
|------|------|
| `import.meta.env.DEV = true` | 全部开启（忽略 localStorage） |
| `GIM_DEBUG` 未设置 | 全部关闭 |
| `GIM_DEBUG = '1'`，`GIM_DEBUG_CATEGORIES` 未设置 | 全部开启 |
| `GIM_DEBUG = '1'`，`GIM_DEBUG_CATEGORIES = 'ifc,fragments'` | 仅 ifc + fragments 开启 |
| `GIM_DEBUG = '1'`，`GIM_DEBUG_CATEGORIES = 'invalid'` | 全部关闭（无有效分类） |

## Ctrl+Shift+D 诊断

Tauri 桌面模式下按 `Ctrl+Shift+D`，将诊断 JSON 复制到剪贴板。

### JSON 结构

```json
{
  "dbPath": "/path/to/gim_viewer.db",
  "diagnostic": {
    "project_type": "transmission_line",
    "parser_version": "gim-parser-v5",
    "line_cbm_node_count": 1234,
    "ifc_models_count": 0,
    "..."
  },
  "debug": {
    "dev": false,
    "gimDebug": "1",
    "categoriesRaw": "ifc,fragments",
    "categories": ["ifc", "fragments"],
    "runtime": false,
    "ifc": true,
    "gimCache": false,
    "lineMap": false,
    "fragments": true
  }
}
```

### debug 字段说明

| 字段 | 说明 |
|------|------|
| `dev` | `import.meta.env.DEV` 值（true=开发模式） |
| `gimDebug` | localStorage `GIM_DEBUG` 原始值（null 表示未设置） |
| `categoriesRaw` | localStorage `GIM_DEBUG_CATEGORIES` 原始值 |
| `categories` | 解析后的分类列表，或 `"ALL"`（表示全部开启） |
| `runtime` | runtime 分类最终生效状态 |
| `ifc` | ifc 分类最终生效状态 |
| `gimCache` | gim-cache 分类最终生效状态 |
| `lineMap` | line-map 分类最终生效状态 |
| `fragments` | fragments 分类最终生效状态 |

## 生产环境排障建议

1. **第一步**：按 `Ctrl+Shift+D`，粘贴诊断 JSON，检查 `debug` 字段确认日志开关状态
2. **第二步**：如需详细日志，在 DevTools Console 执行：
   ```js
   localStorage.setItem('GIM_DEBUG', '1')
   localStorage.setItem('GIM_DEBUG_CATEGORIES', 'ifc,fragments')
   location.reload()
   ```
3. **第三步**：复现问题，收集 Console 日志 + Ctrl+Shift+D 诊断 JSON
4. **第四步**：排障完成后关闭 debug：
   ```js
   localStorage.removeItem('GIM_DEBUG')
   localStorage.removeItem('GIM_DEBUG_CATEGORIES')
   location.reload()
   ```

## logger API

```ts
import { debugLog, debugWarn, debugError } from '../utils/logger.js';
import { DEBUG_IFC_LOAD, DEBUG_FRAGMENTS } from '../config/debug.js';

// 普通调试日志（console.log）
debugLog(DEBUG_IFC_LOAD, '[IFC Engine] init start', { href });

// 条件警告（console.warn）
debugWarn(DEBUG_FRAGMENTS, '[Fragments] update failed', err);

// 条件错误详情（console.error，仅用于 debug 级别完整堆栈）
// 不替代真正的 console.error —— 致命错误仍应直接 console.error
debugError(DEBUG_FRAGMENTS, '[Fragments] full stack trace', err);
```

### 使用原则

| 场景 | 使用 |
|------|------|
| 正常调试信息 | `debugLog(DEBUG_*, ...)` |
| 可恢复异常详情 | `debugWarn(DEBUG_*, ...)` |
| 需要完整堆栈的 debug 级错误 | `debugError(DEBUG_*, ...)` |
| 致命错误（不受开关控制） | `console.error(...)` |
| 缓存损坏（不受开关控制） | `console.warn(...)` |
