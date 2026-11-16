# 原生 v1 契约

[`native-v1.json`](native-v1.json) 是变电与线路 FAM/DEV payload、读取 record、原生错误码和错误 DTO 的唯一来源。`$base` 共享字段并允许读取记录收紧来源行号等字段；`$alias` 表达读写同构的线路记录。标量 `i64/u64` 生成 Rust 整数与 TS number，实际资源/数值范围继续由已有生产校验负责，不在前端追加逐行运行时审计。

运行 `node contracts/generate-native.mjs` 更新 `packages/powerline-core/src/generated/nativeContracts.ts` 与 `contracts/generated/native.rs`；`--check` 只检查漂移，不写文件。Rust 的共享 core 和 Android 插件包含同一生成模块，不为错误 DTO 引入解码器或桌面资源依赖。桌面也提供 `npm run generate:native-contracts`、`npm run check:native-contracts`、`npm run test:native-contracts`。生成文件提交到仓库，构建时检查，不动态读取主程序源码推导协议。

字段的 optional 与 nullable 分别定义缺省和显式 null。Rust 对必需 nullable 字段使用生成的 deserialize helper，不能把缺失字段静默当 null；optional 字段为 None 时省略。原始 FAM JSON、物理行、Unicode 和包含等号的值作为普通值保留。写入/读取记录使用同一字段定义，SQLite 物理 schema 与 parser/cache 契约仍固定 v1。

IPC 错误为 `{code, message, context?}`。code 为生成的闭合枚举；message 只用于展示和诊断，不能决定回退、重试或完整性。原生资源配额、归档损坏、源替换、会话替换、取消、pack/index 和来源物化状态在产生处赋码；未分类的内部消息进入 `OPERATION_FAILED`，任务 panic 进入 `INTERNAL`。7z 回调通过独立错误槽保留原错误，不从第三方包装后的文本恢复配额或取消含义。

bridge 将合法错误 DTO 转成 `GimError`，不支持旧字符串或 `KIND:` 前缀协议；非契约响应记为 `PROTOCOL_INVALID`。原生解压只允许明确的 `IO / BACKEND_UNAVAILABLE / UNSUPPORTED_FORMAT` 选择 WASM 回退；已成功返回但响应解码失败的 `RESPONSE_INVALID` 只允许恢复有效的源 SHA 清单，不能直接换解码器。其他错误拒绝恢复或换解码器。线路 pack 的单项 null 仍使用现有单文件回退；整体错误向上传递，未保留不存在的 `ENTRY_MISS` 异常分支。

两端共用 [`native-v1.fixtures.json`](native-v1.fixtures.json)。Node 测试检查生成漂移和 TS 编译，Rust 测试检查序列化、必需 nullable、未知字段/错误码；桌面注册表测试要求命令使用生成的 NativeError。契约保持 v1，不提供旧开发格式兼容或迁移。
