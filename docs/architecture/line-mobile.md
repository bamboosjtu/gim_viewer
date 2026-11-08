# 线路与移动端

本文件描述线路工程的运行时和 Android 边界。线路格式见[线路 MOD](../schema/powerline-mod.md)，用户行为见[桌面软件规格](../software-spec.md)与[移动端规格](../mobile-spec.md)。

## 共享核心

`packages/powerline-core/` 提供无平台依赖的线路能力：

- CBM/属性 parser core、线路图构建、路径/引用边、F2/F3/F4 投影；
- HNum 预览、领域对象与属性范围；
- 桌面和 Android 共用同一语义；平台只提供文件、SQLite、地图/渲染。

桌面通过兼容出口使用它；Android 独立 npm/SQLite，不依赖桌面 Viewer、IFC 或 Three.js。

## 桌面线路运行时

```text
GIMPKGT / 裸包
  → 解压/缓存
  → buildLineGimGraph（CBM 引用图）
  → parseLineAttributes（FAM/DEV 来源）
  → begin/chunks/finish 三阶段入库
  → 线路树 + 地图
```

- 图是可共享节点的有向图；树是展示投影，不复制节点制造新塔位。
- 入库 `finish` 才提交有效 parser 标记；失败/取消的半成品不能作为合法缓存。
- 缓存恢复包不完整时重建，不用部分 graph 冒充完整工程。
- 地图从有效 BLHA 提取经纬度/高程；导线挂点、跨越与杆塔坐标角色分开，同塔跳线不构造虚假跨塔档。
- MapLibre、Canvas、树和搜索共用对象选择状态；线路不显示桌面变电的选择工具栏。
- 默认 OSM 在线底图；OSM 官方瓦片异常时用 CARTO 同源栅格垫底，不整块空白。天地图为可配置能力；都不可达时 Canvas 覆盖层仍可用。
- 线路弧垂是视觉示意，不能用于净空、张力或施工放样。

## Android

- 只面向线路；SAF 导入、私有 SQLite、HNum 预览和领域投影独立。
- 缓存身份包含源 SHA/大小和 parser 契约；缓存不能覆盖源类型或掩盖源包替换。
- 启动清理未完成导入；“我的工程”只列已完成工程。
- 打开缓存前重新读取原包 magic/大小/完整 SHA，再检查 SQLite 语义表完整性、版本、对象 ID 唯一性和数量；语义无效时重新投影，数据库缺失/损坏时有界解压重建。
- 原包身份不符时明确失败，不覆盖原包；重建完成前不替换正式数据库。
- 原生存储门禁、SAF/权限/折叠屏/沉浸模式验收见[验证](../validation.md)与[移动端规格](../mobile-spec.md)。

## 边界

- 桌面底部图依赖网络；离线 PMTiles 未实现。
- 线路三维、杆塔完整几何和设计级弧垂未实现；HNum/MOD 预览只是局部骨架。
- 桌面与移动端缓存契约独立，不能把桌面 parser 版本写入移动端。
- 线路选择/属性入口与变电三视图分离；共享底层修改必须回归线路与设备。

## 相关文档

- [线路文本 MOD](../schema/powerline-mod.md)
- [移动端规格](../mobile-spec.md)
- [桌面软件规格](../software-spec.md)
- [语义模型](../schema/semantic-model.md)
