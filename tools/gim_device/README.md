# gim_device —— GIM 设备三维查看器

把任意变电设备 `.gim` 解析成三维模型并交互浏览的完整源码，可打包为单文件 exe。
日常教学/汇报直接用 `GIM设备查看器.exe`，改代码看本目录。

---

## 目录结构

```
gim_device/
├── viewer_app.py           桌面外壳（PySide6 + QtWebEngine）：选文件/拖放/解析线程/菜单
├── viewer_shell.html       渲染层（Three.js r128）：primitive 工厂 + 交互 + 侧栏
├── gim_core.py             解析核心（无 UI 依赖）：解包 → 链条 → XML → JSON
├── viewer.spec             PyInstaller 打包配置（单文件 exe）
├── app.ico                 图标（build 时内嵌）
├── three.min.js            渲染库（本地副本，断网可用）
├── OrbitControls.js        相机控制（本地副本）
├── dist/
│   └── GIM设备查看器.exe    打包产物（约 190 MB，可单独拷走）
├── tools/
│   ├── test_render.py      无头浏览器回归测试（不开 GUI 快速验证任意 gim）
│   └── survey_prim.py      图元普查：抽样统计规范库的 primitive 类型分布
├── _probe_bbox.py          装配调试：按 z 分层统计网格数，定位「某段没有几何」
└── _probe_bbox.py          装配调试：按 z 分层统计网格数，定位「某段没有几何」
```

`_screenshots/` 是回归测试的临时输出目录（`tools/test_render.py` 用），**随时可整个删掉**，脚本用的时候 `os.makedirs(exist_ok=True)` 自动重建。

---

## 一、直接用 exe

线框源码的棱边阈值为 1°：保留圆柱/圆台侧面的纵向棱线，同时排除共面三角剖分对角线；细线和屏幕空间粗线使用同一阈值。不能用 24° 的锐边阈值代替完整分段线框，否则圆柱侧面会被滤掉，只剩端部圆环。修改源码后需重新打包，已有 dist 中的 exe 不会自动更新。

双击根目录的 `GIM设备查看器.exe`（日常入口，工程根一层就能看到），或 `dist/GIM设备查看器.exe`（PyInstaller 产物位），把 `.gim` 拖进窗口，或 `Ctrl+O` 选择文件。
首次启动约 5–10 秒（单文件 exe 需先解压到临时目录），之后秒开。

> 根目录那份与 `dist/` 里的**是同一个文件的两份拷贝**，都保留：前者图方便，后者是打包标准输出位。
> 重打包后记得同步根目录：`cp dist/GIM设备查看器.exe ../`。

菜单里可导出三维视图 PNG（`Ctrl+S`，按画布 2 倍分辨率，不含界面）。

## 二、从源码运行

```bash
python viewer_app.py                    # 启动 GUI
python viewer_app.py some.gim           # 启动并直接打开
python viewer_app.py --smoke a.gim out.png   # 自检：无窗渲染并导出 PNG 后退出
GIM_SMOKE_MODE=edge python viewer_app.py --smoke a.gim out.png   # 自检线框模式
```

依赖：`PySide6`（含 QtWebEngine）、`py7zr`。

## 三、重新打包

```bash
cd gim_device
python -m PyInstaller --noconfirm viewer.spec
# 产物：dist/GIM设备查看器.exe
```

`viewer.spec` 里的资源路径基于 `SPECPATH`，所以从任意工作目录调用都能正确收集
`viewer_shell.html` / `three.min.js` / `OrbitControls.js` / `app.ico`。
py7zr 的解压后端（`pyzstd`/`pyppmd`/`pybcj`/`inflate64`/`brotli`…）是编译扩展，已用
`collect_all` 全量收集，漏一个就会在解包时报找不到模块。

## 四、解析核心单独使用

`gim_core.py` 不依赖 Qt，可直接脚本调用：

```bash
python gim_core.py some.gim          # 打印容器/设备名/mod 数/实体数/类型分布
```

```python
import gim_core
data = gim_core.load('x.gim', workdir)   # -> dict(meta, entities[])
```

`entities[]` 每项含 `id / type / attrs(原始 XML 属性) / m(16 项列主序矩阵) / color / hidden`。
把这份 JSON 直接喂给 `window.loadModel(json)` 即可渲染。

## 五、装配链（渲染正确性的关键）

GIM 的几何位置**不在 mod 里**，而是逐边累计的矩阵链：

```
CBM.TRANSFORMMATRIX × DEV.SUBDEVICEn 矩阵 × DEV.SOLIDMODELn 矩阵 × PHM.TRANSFORMMATRIXn × Entity 局部矩阵
```

几个必须遵守的点（`gim_core.build_instances` 已实现）：

1. **DEV 是有序块文本**。`SUBDEVICEn` 和 `SOLIDMODELn` 各自紧跟一个 `TRANSFORMMATRIXk`，两类块都可能出现 `TRANSFORMMATRIX0` —— 扁平字典会互相覆盖，必须按源顺序绑到最近的目标。
2. **DEV 可嵌套子 DEV**（如 2QS 隔离开关：根 DEV 有 28 个子设备，摆在 3×3 网格上，其中还有 `y=-1` 的镜像）。只读第一层会让所有绝缘支柱叠在一处。
3. **同一个 DEV/MOD 可被多次引用**，每次是一个独立 occurrence，不能去重。
4. **两套键名并存**：2025 版 `SOLIDMODELS.NUM` + `SOLIDMODELn`，2018 版 `SOLIDS.NUM` + `SOLIDSn`。
5. **CBM 的 TRANSFORMMATRIX 布局不同**（实测写成 `1,0,0,1,0,0,0,1,...`，不是列主序仿射阵）。这类矩阵必须按单位阵回退，否则整棵装配树会被算飞（表现为几何 NaN / 尺寸荒谬）。`parse_matrix()` 做两道校验：仿射形式 + 线性部分非奇异。
6. 单位是 mm、Z 轴朝上，顶点已经是绝对量纲，不再做缩放。

验证方法：`_probe_bbox.py` 会按 z 分层统计网格数，能直接看出「某段高度没有几何」这类装配缺口。

## 六、回归测试

```bash
python tools/test_render.py some.gim --out tag --views iso,front
# 截图落在 gim_device/_screenshots/_r_<tag>_<view>.png
```

不开 GUI，用 Playwright 走系统 Chrome（`channel='chrome'`）验证渲染，适合批量回归。`_probe_bbox.py` 可导出每个网格的世界包围盒用于定位装配问题。

---

## 覆盖范围与已知边界

抽样 98 个规范库 gim（26,970 个实体）统计的图元分布：Cylinder 41%、Cuboid 32%、StretchedBody 7%、EccentricTruncatedCone 4.2%、Sphere 3.8%、PorcelainBushing 3.6%、TruncatedCone 1.9%、Boolean 1.8%、Ring 1.1%、TerminalBlock 1.0%。前 5 种覆盖 88%，已实现约 99% 的实体出几何。

几何来源除 MOD（XML 图元）外还支持 **STL**（二进制 + ASCII）：120 个抽样里 19 个是MOD+STL 混合、101 个纯 MOD、0 个纯 STL。STL 网格挂在顶层 `meshes`，实体以 `TriMesh` 引用。

- **Boolean 不做真 CSG**：按第一操作数取形，界面提示「N 个布尔实体按操作数近似」。需要精确挖孔得引入 CSG 库，体积和复杂度都会上去。
- **型钢按盒体近似**：`ChannelSteel`/`BeamChannel` 缺截面型号表，只给外包尺寸。**约 0.5% 实体未渲染**：主要是电缆符号曲线（`GimGeCableSymbolicCurve` 等）。界面会标「未知图元」并列出类型名，不会静默丢几何。
- **隐藏实体（`Visible=false`）保留但不渲染**：Boolean 的操作数常指向隐藏实体，丢弃会丢几何；界面有「显示隐藏实体」开关。

## 技术备注

1. **装配链优先**：几何位置来自 CBM/DEV/PHM 的矩阵链，mod 里只有局部几何。见「五、装配链」。
2. **StretchedBody 语义**：`Normal` 模长恒为 304.8（1 ft 厂商常量），只是方向载体；几何 = 平面轮廓沿 `normalize(Normal)` 拉伸 `L`。项目 `gim_viewer/docs/schema/substation-mod.md`中「非单位 Normal 按完整位移解释」的约定不成立（按它算 L 全部失效、几何断裂）。
3. **TransformMatrix 是 16 项列主序**，平移在 index 12/13/14，可直接 `Matrix4.fromArray`；但要 `decompose` 到 position/quaternion/scale，不要 `matrixAutoUpdate=false`，否则分解视图失效。
4. **包围盒用 `geo.boundingBox.applyMatrix4(mesh.matrix)`**，不要用 `Box3.setFromObject()`——后者返回含 group 旋转的世界坐标，会让宽高互换。
5. **Qt 的 `runJavaScript` 不会自动调用箭头函数**，必须写 `(() => {…})()`，否则回调永远为空；回调对 JS 对象序列化也不可靠，让 JS 返回 `JSON.stringify(...)` 字符串。
6. **`QWidget.grab()` 抓不到 WebEngine 的 GPU 合成层**（截图全白），导出走 `canvas.toDataURL()`，且 WebGL 需 `preserveDrawingBuffer: true`。
7. 容器两种都要支持：带 `GIMPKGS/GIMPKGT` 头的（搜索 7z 签名定位 payload），和 LW36 那种裸 7z（第 0 字节即签名）。
8. **线框走屏幕空间粗线**，不是 `LineBasicMaterial`：WebGL 里 `linewidth` 在绝大多数驱动上被强制为 1 个**设备**像素，高 DPI 屏上只剩半个 CSS 像素；而 48 mm 厚的横担在 13 m 视野里本来只有 3 px 高，1 px 的线根本撑不起形体，看起来就像「构件没画出来」。`buildFatEdges()` 把每条边扩成 6 顶点三角形带（`InstancedBufferGeometry` + 顶点着色器里按屏幕法线偏移，宽度按设备像素给），只在纯线框模式启用；`both` 模式仍是 1 px 细线叠加。构建失败会置 `userData.fatFail` 并回退细线，不影响显示。**另一个坑**：线材质若开 `transparent + opacity`，在浅色背景上会被混到几乎看不见
   （实测暗像素只有不透明深色的 1/37）。纯线框必须不透明。
