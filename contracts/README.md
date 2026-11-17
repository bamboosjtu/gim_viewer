# 原生 v1 契约

[`native-v1.json`](native-v1.json) 是桌面、Android 与导入插件共用的原生 DTO、错误、命令名和共享版本常量的唯一来源。覆盖 FAM/DEV、图/引用、几何 manifest、提取清单/计时、平台元数据与设置。生产边界不通过读取应用源码推导协议；生成输出提交到仓库，构建时检查漂移。

`node contracts/generate-native.mjs` 更新 TS 与 Rust；`--check` 只验证。桌面提供 `generate:native-contracts`、`check:native-contracts`、`test:native-contracts`。`$base/$alias` 表达共享字段；数组、映射、元组、整数/浮点、枚举及 camelCase wire 名由同一描述生成。原生不透明 JSON 仍由所属领域解释，不为缓存/Worker 的内部模型再维护一份重复 Rust 领域实现。

字段 optional、nullable、输入缺省与 wire 省略规则分别记录。原有必需 nullable 字段仍拒绝缺省；只有明确声明 inputOptional/default 的字段可在输入缺省。带 skipNone 的 optional 字段在 None 时省略，其他 nullable 字段按契约输出 null。资源、业务路径与源身份仍由原有有界 validator 校验，不增加逐顶点或完整缓存重序列化审计。

提取清单的借用序列化视图由同一字段定义生成，只借用条目/计时数据；不会为共享 DTO 复制整份 entry 清单。GIMR 解码后的 Uint8Array、File/Map 及领域内存模型是应用适配结果，保留各自类型，不把它们伪装成 JSON wire DTO。

生成命令集合为 53 个桌面、13 个移动端和 7 个平台插件命令。bridge 使用生成常量与 command union；Rust AST 注册表对照相同集合，拒绝注册漂移。共享物理 schema、线路/变电 parser 与 DEV 几何基础版本也由此生成；单语言派生域与内容指纹保留自己的所有权和独立失效策略。

属性补写显式指定 properties_mode：replace 是完整快照，确认的空数组可有意清空；preserve 不接受属性数组，不改变已有属性或完成标记。缺失/读取失败/冲突来源不能构造成空快照。第一/二阶段共用属性 validator，源身份与事务约束继续独立校验。

IPC 错误为 `{code, message, context?}`。code 是生成的闭合枚举；message 只用于显示。未分类内部错误使用 OPERATION_FAILED，线程任务失败使用 INTERNAL；schema 不匹配使用 SCHEMA_UNSUPPORTED，旧开发库由开发者删除重建。bridge 将合法 DTO 规范化为 GimError，不按中文、前缀或旧字符串分类。

原生解压只允许 IO/BACKEND_UNAVAILABLE/UNSUPPORTED_FORMAT 进入 WASM 回退；RESPONSE_INVALID 只允许恢复有效源 SHA 清单。其他安全、来源、会话和完整性错误不换解码器。领域 Finding、Worker 生命周期和渲染状态不是同一个错误域，保留各自语义，不能合并为全局失败开关。

[`native-v1.fixtures.json`](native-v1.fixtures.json) 是无工程样本的 wire 夹具：Node 验证 TS 类型、输出漂移与类型所有权；Rust 逐模型往返，并拒绝未知字段/枚举及缺失必需 nullable。它不代表业务 payload、几何或真实工程已经通过校验。协议、派生缓存与物理 schema 固定 v1，不提供旧开发格式兼容或迁移。
