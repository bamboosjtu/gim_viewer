# 线路文本 MOD 与 WIRE 来源

线路 MOD 采用四类内容 grammar。它不是变电 Device XML，也不是所有文件都可用 KEY=VALUE Map 读取。
分型与类型定义以 [lineModParser](../../desktop/src/gim/geometry/lineModParser.ts) 和[IR](../../desktop/src/gim/geometry/ir.ts) 为准。

## 内容分型

| 优先级 | 类型 | 签名 |
|---|---|---|
| 1 | TEXT_POINT_LINE | 同时存在 CODE、POINTNUM、LINENUM |
| 2 | TEXT_HNUM_COMMA_RECORD | HNum 逗号记录 |
| 3 | TEXT_SECTION_KV_RECORD | 独立 Bolt 节与键值记录 |
| 4 | TEXT_KEY_VALUE | ASCII 键名的 KEY=VALUE 行 |

处理 UTF-8 BOM、CRLF/LF 和空行。无法分类时不能默认当 HNum。
声明数和实际有效记录分别保留，数量上限不能被文件声明绕过。

## HNum 逗号记录

```text
HNum,1
H,27000,Body1,Leg1
Body1
HBody1,25000
P,1,0,0,0
P,2,1000,0,1000
R,1,2,L50,Q235,1,0,0,0,1,0
G,1,挂点A,100,0,900
HSubLeg1,0
HLeg1,1000,0
```

合成例仅表达记录形状。H 与 body/leg 标识按 parser 实际 token 保留，不能从 HNum 数字直接推定完整杆塔部件数。

| 记录 | 字段/结构 | 用途与边界 |
|---|---|---|
| HNum,n | 声明数量 | 有界计数 |
| H,height,body[,leg] | 高度、Body 与可选 Leg 引用 | 高度方案来源 |
| BodyN | 体段开始 | 刷新当前分块，保留顺序 |
| HBodyN,height | 体段参考高度 | 与点坐标独立 |
| P,id,x,y,z | 含 P 共 5 token | 局部节点 |
| R,id1,id2,spec,material,dir1x,dir1y,dir1z,dir2x,dir2y,dir2z | 含 R 共 11 token | angle 杆件 |
| R,id1,id2,spec,material | 含 R 共 5 token | tube 杆件 |
| R 的其他长度 | raw，合法端点可保留 | unknown，不猜测其余字段 |
| G,type,name,x,y,z | 含 G 共 6 token | 局部挂点，不是地理塔位 |
| HSubLegN,offset | 附腿偏移记录 | 依 body/leg 关系解释 |
| HLegN,x,y | 腿位置来源 | 不等于全局经纬度 |

骨架预览连接 P/R，不能宣称完整钢材实体或施工级模型。
在册 HNum 存在 P 分布于多个 Body、R 集中在文件尾部的布局，H 高度方案不截断几何。
当前预览在点号全文件唯一时按全文件 ID 连接杆件；出现重复点号时只在当前 Body 内解析，不借用其他 Body 的同号点或缺失端点。几何范围从实际连接的 P/R 计算，不按 H 或 HBody 裁切。
未匹配词法的行可能不进入结构记录，raw/source 应用于诊断；科学计数法等覆盖见未决事项。

## POINT_LINE

```text
CODE=201
POINTNUM=2
LINENUM=1
POINT1=1,0.001,0.002,10,13
POINT2=2,0.002,0.003,12,42
LINE1=1,2
```

合成地理示例不代表真实位置。POINT 值为 id,lat,lon,alt,type 五 token，LINE 值为 fromId,toId 两 token，通过 POINT.id 建立局部点线拓扑。
索引 n 与 POINT.id 是不同字段，不能假定等同。

CODE 和 type 保留源值，不能在 parser 层强行映射为完整业务枚举。
跨越 MOD 的点不是杆塔总清单；未引用点和非闭合线并不自动表示损坏。
当前正则对数字和 ID 具有具体词法限制，不保证任何合法数值写法都能消费。

## Bolt 分节键值记录

```text
Bolt
BoltNum=1
Bolt0=M20,100,8.8,1,2,0,0,3,4,5,0,0;1,100,200,300
```

常见首段为 12 个逗号 token，首两个投影为 spec 与 length，剩余十项保留 restFields。
分号后常见 code,x,y,z 四项位置。源文件可有多个分号段，不能固定宣布所有值只有两个段。
当前 parser 在第一个分号处分开，读取后续位置段前四 token，未消费的额外段不等于已经解析。
restFields 的工程含义没有充分证据时保持原值，不把猜测字段名当标准。

## KEY_VALUE

| 家族 | 字段/来源 | 当前识别 |
|---|---|---|
| Tower_Device | type、H1..H4、d、e1/e2 等 | 当前签名要求 type、H1、d；保留数值和扩展参数 |
| WIRE | TYPE、SECTIONALAREA、OUTSIDEDIAMETER、WIREWEIGHT、COEFFICIENTOFELASTICITY、EXPANSIONCOEFFICIENTOFWIRE、RATEDSTRENGTH | 根据实际字段集合识别，不能只看 TYPE 大小写 |
| Unknown KV | 其他键值 | 原始集合与 key 顺序保留 |

单值集合采用后写值覆盖，不能代替文件原文本。未知字段不自动变成错误或强类型工程参数。
属性单位与设计用途需要对应字段来源，不能从英文键名推定所有文件使用同一单位。

## WIRE、串与挂点

WIRE 的源链为 CBM 语义/端点→DEV/FAM→PHM/MOD，结构与属性各保留来源。
POINTn.STRING/GPOINT/BLHA/MATRIX0 描述串、挂点、地理坐标和局部几何的关联。
挂点 ID 应在对应串/塔模板范围解析，不能全工程拿第一个同名 G 点。

BLHA 使用纬度、经度、高程、方位来源；地图投影交换为 `[lon,lat]`。
MATRIX0 是源字段，不自动与 BLHA 互相替代。跨塔导线、同塔跳线和缺端点各自处理。
CONDUCTOR、GROUNDWIRE、OPGW 和分裂来源保留，RawWire 数不等于物理档数。

KVALUE、导线材料与局部矩阵的完整工程含义尚未形成可验收公式。
当前地图曲线采用采样近似：有系数时按实现估算，缺省弧垂按档距比例并受上限约束。
它属于视觉示意，不能用于净空、张力或施工放样。
原属性长度、地理端点直线长度、采样曲线长度和回路里程必须分列。

当前地图行为见 [软件规格](../software-spec.md)，原 F2 长度见
[台账](sample-corpus.md)，所有公式/词法/预览补齐行动见 [未决事项](../open-issues.md)。
