/**
 * GIM 属性字典与检查器渲染辅助。
 *
 * 该模块是 UI 的“语义边界”：原始文件仍保留原键值，但用户首先看到
 * 中文标签、工程含义、单位和经过裁剪的值。未知字段不会丢失，而是进入
 * 默认折叠的技术字段区域。
 */

import { escHtml } from '../shared/html.js';

export type PropertyComponent =
  | 'generic'
  | 'substation-cbm'
  | 'substation-fam'
  | 'substation-dev'
  | 'ifc-space'
  | 'ifc-object'
  | 'line-node'
  | 'line-wire'
  | 'line-hnum'
  | 'line-bolt'
  | 'line-tower-device'
  | 'line-wire-params'
  | 'line-point-line';

export type PropertyPriority = 0 | 1 | 2;
export type PropertyDataType = 'text' | 'number' | 'coordinate' | 'matrix' | 'reference' | 'enum';

export interface PropertyDefinition {
  key: string;
  label: string;
  description: string;
  unit?: string;
  group: string;
  priority: PropertyPriority;
  dataType: PropertyDataType;
  aliases?: string[];
}

export interface PropertyRow {
  /** 原始键；用于字典查找和导出。也可直接传中文标签。 */
  key: string;
  value: unknown;
  /** 已经格式化的 HTML 值，仅允许由本模块的 fileReferenceValue 产生。 */
  valueHtml?: string;
  /** 用于 CSV/无障碍的纯文本值；缺省时取 value 的格式化文本。 */
  valueText?: string;
  /** 覆盖字典中的单位或技术字段样式。 */
  unit?: string;
  /** 可选的文件引用类型；不提供时由键名/扩展名安全推断。 */
  referenceKind?: PropertyReferenceDetail['kind'];
  mono?: boolean;
  definition?: PropertyDefinition;
}

export interface FileReferenceValue {
  html: string;
  text: string;
}

export interface PropertyReferenceDetail {
  kind: 'cbm' | 'dev' | 'fam' | 'phm' | 'mod' | 'stl' | 'ifc' | 'sld' | 'file';
  path: string;
}

type PropertyReferenceHandler = (detail: PropertyReferenceDetail) => boolean | void;
const propertyReferenceHandlers = new Set<PropertyReferenceHandler>();
let propertyReferenceEventsReady = false;

/** 安装一次属性引用事件桥；正文中的路径永远不会作为可见文本输出。 */
export function ensurePropertyReferenceEvents(): void {
  if (propertyReferenceEventsReady || typeof window === 'undefined') return;
  propertyReferenceEventsReady = true;
  window.addEventListener('gim:file-reference-click', (event) => {
    const detail = (event as CustomEvent<PropertyReferenceDetail>).detail;
    if (!detail?.kind || !detail.path) return;
    for (const handler of Array.from(propertyReferenceHandlers)) {
      try {
        if (handler(detail) === true) break;
      } catch (error) {
        console.warn('[属性引用] 跳转处理失败:', error);
      }
    }
  });
}

/** 注册工程级文件引用路由，返回可选的注销函数。 */
export function registerPropertyReferenceHandler(handler: PropertyReferenceHandler): () => void {
  ensurePropertyReferenceEvents();
  propertyReferenceHandlers.add(handler);
  return () => propertyReferenceHandlers.delete(handler);
}

const GENERIC_DEFINITIONS: PropertyDefinition[] = [
  def('ENTITYNAME', '实体类型', 'GIM/CBM 节点的实体类型标识', 'generic', 0, 'enum'),
  def('GROUPTYPE', '分组类型', '线路 F4 分组类型', '线路分类', 1, 'enum'),
  def('WIRETYPE', '导线类型', '导线、地线或 OPGW 的类型标识', '线路分类', 0, 'enum'),
  def('DEVICETYPE', '设备类型', '设备或杆塔的业务类型', '设备分类', 0, 'enum'),
  def('SYSCLASSIFYNAME', '系统分类', '导出器提供的系统分类编码/名称', '系统分类', 1, 'text'),
  def('PARTNAME', '部件名称', '部件或设备的业务名称', '基本信息', 0, 'text'),
  def('SYSTEMNAME1', '系统名称 1', '变电功能系统名称层级 1', '功能系统', 0, 'text'),
  def('SYSTEMNAME2', '系统名称 2', '变电功能系统名称层级 2', '功能系统', 0, 'text'),
  def('SYSTEMNAME3', '系统名称 3', '变电功能系统名称层级 3', '功能系统', 0, 'text'),
  def('SYSTEMNAME4', '系统名称 4', '变电功能系统名称层级 4', '功能系统', 1, 'text'),
  def('SYMBOLNAME', '设备名称', 'DEV 文件中的设备可读名称', '设备信息', 0, 'text'),
  def('TYPE', '类型', 'DEV/MOD 文件声明的类型；具体含义随组件变化', '设备信息', 0, 'text'),
  def('BASEFAMILY', '属性族引用', '设备引用的 FAM 属性族文件', '来源引用', 1, 'reference'),
  def('BASEFAMILYPOINTER', '属性族引用', '设备引用的 FAM 属性族文件（部分导出器使用该键名）', '来源引用', 1, 'reference'),
  def('OBJECTMODELPOINTER', '设备模型引用', 'CBM 指向 DEV 设备定义的引用', '来源引用', 1, 'reference'),
  def('IFCFILE', 'IFC 模型引用', 'CBM/设备对应的 IFC 模型文件', '来源引用', 1, 'reference'),
  def('IFCGUID', 'IFC GUID', 'IFC 构件 GlobalId，用于跨模型关联', '来源引用', 2, 'reference'),
  def('TRANSFORMMATRIX', '变换矩阵', '列主序 4×4 放置矩阵，平移位于第 13–15 个值', '技术字段', 2, 'matrix'),
  def('SCH', '电气图纸引用', '变电工程逻辑模型/主接线图入口', '来源引用', 1, 'reference'),
  def('IFC.NUM', 'IFC 模型数量', '工程级 IFC 文件索引声明的数量', '结构统计', 1, 'number', '个'),
  def('IFC', 'IFC 模型引用', '工程级 IFC 文件索引中的模型文件', '来源引用', 1, 'reference'),
  def('SUBSYSTEMS.NUM', '子系统数量', '变电主层级下的子系统数量', '结构统计', 1, 'number', '个'),
  def('SECTIONS.NUM', '区段数量', '线路工程 F1 层级的区段数量', '结构统计', 1, 'number', '个'),
  def('STRAINSECTIONS.NUM', '耐张段数量', '线路工程 F2 层级的耐张段数量', '结构统计', 1, 'number', '个'),
  def('GROUPS.NUM', '分组数量', '线路工程 F3 层级的分组数量', '结构统计', 1, 'number', '个'),
  def('TOWERS.NUM', '杆塔数量', '线路 TOWER 分组中的塔位引用数量', '结构统计', 1, 'number', '个'),
  def('BASES.NUM', '基础数量', '线路 TOWER 分组中的基础引用数量', '结构统计', 1, 'number', '个'),
  def('STRINGS.NUM', '导线串数量', '线路 TOWER 分组中的导线串引用数量', '结构统计', 1, 'number', '个'),
  def('SUBDEVICES.NUM', '子设备数量', '设备或分组中的子设备数量', '结构统计', 1, 'number', '个'),
  def('SOLIDMODELS.NUM', '几何引用数量', 'DEV/PHM 声明的组合模型引用数量', '结构统计', 1, 'number', '个'),
  def('SUBLOGICALMODELS.NUM', '子逻辑模型数量', '部分导出器声明的子逻辑模型数量', '结构统计', 1, 'number', '个'),
  def('SUBSYSTEM', '子系统引用', '变电工程 F1～F3 主层级的 CBM 引用', '来源引用', 1, 'reference'),
  def('SECTION', '区段引用', '线路工程 F1 层级的 CBM 引用', '来源引用', 1, 'reference'),
  def('STRAINSECTION', '耐张段引用', '线路工程 F2 层级的 CBM 引用', '来源引用', 1, 'reference'),
  def('GROUP', '分组引用', '线路工程 F3 层级的 CBM 引用', '来源引用', 1, 'reference'),
  def('TOWER', '杆塔引用', '线路 TOWER 分组中的塔位 CBM 引用', '来源引用', 1, 'reference'),
  def('BASE', '基础构件引用', '线路 TOWER 分组中的基础 CBM 引用', '来源引用', 1, 'reference'),
  def('SUBDEVICE', '子设备引用', 'F4System 或 DEV 中的子设备引用', '来源引用', 1, 'reference'),
  def('SOLIDMODEL', '组合模型引用', 'DEV/PHM 指向 PHM、MOD 或 STL 的几何引用', '来源引用', 1, 'reference'),
  def('COLOR', '颜色覆盖', 'PHM 或 MOD 的实例颜色覆盖值', '技术字段', 2, 'text'),
  def('STRING.STRING', '导线串引用', '线路 TOWER 分组中的导线/地线串 CBM 引用', '来源引用', 1, 'reference'),
  def('STRING.GPOINT', '导线挂点', '导线串在塔上的挂点名称', '端点关系', 0, 'text'),
  def('BACKSTRING', '后侧挂点引用', '导线后侧字符串/塔位引用', '端点关系', 1, 'reference'),
  def('FRONTSTRING', '前侧挂点引用', '导线前侧字符串/塔位引用', '端点关系', 1, 'reference'),
  def('ISJUMPER', '跳线', '是否为同塔内部跳线', '导线语义', 0, 'enum'),
  def('SPLIT', '分裂数', '导线分裂子导线数量', '导线语义', 0, 'number'),
  def('KVALUE', 'K 值', '悬链线候选参数；具体公式尚未在规范中确认', '导线语义', 1, 'number'),
  def('POINT0.BLHA', '起点塔位坐标', '导线起点 BLHA：纬度、经度、高程、方位角', '端点坐标', 0, 'coordinate'),
  def('POINT1.BLHA', '终点塔位坐标', '导线终点 BLHA：纬度、经度、高程、方位角', '端点坐标', 0, 'coordinate'),
  def('POINT0.MATRIX0', '起点挂点矩阵', '起点横担偏移/挂点高度的局部矩阵', '技术字段', 2, 'matrix'),
  def('POINT1.MATRIX0', '终点挂点矩阵', '终点横担偏移/挂点高度的局部矩阵', '技术字段', 2, 'matrix'),
  def('spanMeters', '档距长度', '导线两端塔位之间的平面/球面距离', '导线语义', 0, 'number', 'm'),
  def('count', '记录数', '当前来源文件中已解析的记录数量', '结构统计', 1, 'number', '个'),
  def('pointNum', '点数量', '跨越物点线文件声明的 POINT 记录数', '结构统计', 1, 'number', '个'),
  def('lineNum', '线数量', '跨越物点线文件声明的 LINE 记录数', '结构统计', 1, 'number', '条'),
  def('BLHA', '塔位坐标', '塔位中心的纬度、经度、高程、方位角', '位置', 0, 'coordinate'),
  def('NOMINALHEIGHT', '呼高', '塔位实例的呼高（导线挂点/设计基准高度）', '塔位参数', 0, 'number', 'm'),
  def('CALLHEIGHT', '呼高', '塔位实例的呼高（导线挂点/设计基准高度）', '塔位参数', 0, 'number', 'm'),
  def('HOUGAO', '呼高', '导出器使用的呼高字段', '塔位参数', 0, 'number', 'm'),
  def('TOWERHEIGHT', '杆塔高', '塔位实例的杆塔总高；与呼高是不同字段', '塔位参数', 0, 'number', 'm'),
  def('LINEANGLE', '转角', '塔位实例在线路方向上的转角', '塔位参数', 0, 'number', '°'),
  def('TURNANGLE', '转角', '导出器使用的线路转角字段', '塔位参数', 0, 'number', '°'),
  def('ANGLE', '转角', '导出器使用的转角字段', '塔位参数', 0, 'number', '°'),
  def('CODE', '业务码', '跨越物或点线表的来源业务码，不能单独当作类型', '分类', 1, 'enum'),
  def('POINTNUM', '点数量', '点线表中的 POINT 记录数量', '结构统计', 1, 'number'),
  def('LINENUM', '线数量', '点线表中的 LINE 记录数量', '结构统计', 1, 'number'),
  def('NUM', '数量', '文件声明的记录数量', '结构统计', 1, 'number'),
  def('ZCOUNT', '地脚数量', '杆塔基础地脚/支柱数量', '塔基参数', 1, 'number'),
  def('ZPOSTARRAY', '地脚数组', '杆塔基础地脚位置数组', '技术字段', 2, 'text'),
  def('TOWERO', '杆塔引用', 'F4System 指向的塔位 CBM 节点', '来源引用', 1, 'reference'),
  def('STRING0.STRING', '导线串引用', 'F4System 中导线串的 CBM 引用', '来源引用', 1, 'reference'),
  def('STRING0.GPOINT', '导线挂点', '导线串在塔上的挂点名称', '端点关系', 0, 'text'),
];

/** 变电 FAM 中跨样本稳定、可直接翻译的中文键。其余键保留原文并折叠。 */
const SUBSTATION_FAM_DEFINITIONS: PropertyDefinition[] = [
  def('生产厂家', '生产厂家', '设备或物资的生产厂商', '设备信息', 1, 'text'),
  def('厂家', '生产厂家', '设备或物资的生产厂商', '设备信息', 1, 'text'),
  def('单位', '计量单位', '属性记录使用的计量单位', '设备信息', 1, 'text'),
  def('装置型号', '装置型号', '设备装置型号', '设备信息', 0, 'text'),
  def('装置名称', '装置名称', '设备装置名称', '设备信息', 0, 'text'),
  def('装置编号', '装置编号', '设备装置编号', '设备信息', 1, 'text'),
  def('设备名称', '设备名称', '设备业务名称', '设备信息', 0, 'text'),
  def('名称', '名称', '设备或构件名称', '设备信息', 0, 'text'),
  def('工程中名称', '工程中名称', '工程语境下使用的设备名称', '设备信息', 0, 'text'),
  def('型号', '型号', '设备或物资型号', '设备信息', 0, 'text'),
  def('设备型号', '设备型号', '设备型号', '设备信息', 0, 'text'),
  def('类型', '类型', '设备或构件类型', '设备信息', 0, 'text'),
  def('额定电压', '额定电压', '设备额定工作电压', '电气参数', 0, 'text'),
  def('电压等级', '电压等级', '设备或系统电压等级', '电气参数', 0, 'text'),
  def('额定电流', '额定电流', '设备额定工作电流', '电气参数', 1, 'text'),
  def('额定频率', '额定频率', '设备额定频率', '电气参数', 1, 'text'),
  def('额定容量', '额定容量', '设备额定容量', '电气参数', 1, 'text'),
  def('相序', '相序', '三相设备的相序标识', '电气参数', 1, 'enum'),
  def('极性', '极性', '设备端子或互感器极性', '电气参数', 1, 'enum'),
  def('操作方式', '操作方式', '设备操作机构或控制方式', '运行参数', 1, 'text'),
  def('设备形式', '设备形式', '设备结构或安装形式', '设备信息', 1, 'text'),
  def('物料编码', '物料编码', '物资主数据编码', '追溯信息', 1, 'text'),
  def('通用/标准设备编号', '通用/标准设备编号', '通用或标准设备编号', '追溯信息', 1, 'text'),
  def('电网工程标识系统编码', '电网工程标识系统编码', '电网工程标识系统中的编码', '追溯信息', 1, 'text'),
  def('实物ID', '实物 ID', '实物资产唯一标识', '追溯信息', 1, 'text'),
  def('调度编码', '调度编码', '调度系统使用的设备编码', '追溯信息', 1, 'text'),
  def('附件编号', '附件编号', '关联附件或附件记录编号', '追溯信息', 1, 'text'),
];

/** 线路 FAM 中由样本重复验证的业务字段。 */
const LINE_FAM_DEFINITIONS: PropertyDefinition[] = [
  def('MATERIALCODE', '物料编码', '线路物资主数据编码', '追溯信息', 1, 'text'),
  def('MANUFACTURER', '生产厂家', '线路设备或物资的生产厂商', '设备信息', 1, 'text'),
  def('VOLTAGE', '电压等级', '线路设备适用的电压等级', '电气参数', 0, 'text'),
  def('TYPE', '型号', 'FAM 中的设备或导线型号', '设备信息', 0, 'text'),
  def('BUNDLENUMBER', '分裂数', '导线或导线串的分裂子导线数量', '导线参数', 0, 'number', '个'),
  def('CONDUCTORKVALUE', '导线 K 值', '导线工况参数 K 值；物理公式仍以规范为准', '导线参数', 1, 'number'),
  def('GROUNDWIREKVALUE', '地线 K 值', '地线工况参数 K 值；物理公式仍以规范为准', '导线参数', 1, 'number'),
  def('LP', '代表档距', '导线设计工况中的代表档距', '导线参数', 1, 'number', 'm'),
  def('MAXTENSION', '最大张力', '导线最大张力工况值', '导线参数', 1, 'number'),
  def('MAXSTRESS', '最大应力', '导线最大应力工况值', '导线参数', 1, 'number'),
  def('EVERYDAYTENSION', '日常张力', '日常气象工况下的导线张力', '导线参数', 1, 'number'),
  def('SAFETYCOEFFICIENTMAXTENSION', '最大张力安全系数', '最大张力对应的安全系数', '导线参数', 1, 'number'),
  def('SAFETYCOEFFICIENTEVERYDAYTENSION', '日常张力安全系数', '日常张力对应的安全系数', '导线参数', 1, 'number'),
  def('BUNDLESPACING', '分裂间距', '分裂导线之间的间距', '导线参数', 1, 'number'),
  def('PHASE', '相别', '导线或回路相别', '电气参数', 1, 'enum'),
  def('SERIALNUMBEROFCIRCUIT', '回路序号', '线路回路序号', '电气参数', 1, 'number'),
  def('SPLITTYPE', '分裂类型', '导线分裂布置类型', '导线参数', 1, 'text'),
  def('INSULATORTYPE', '绝缘子型号', '绝缘子型号', '绝缘子串参数', 0, 'text'),
  def('MATERIALOFINSULATOR', '绝缘子材质', '绝缘子材料编码或名称', '绝缘子串参数', 1, 'text'),
  def('WINDAREA', '受风面积', '绝缘子串或设备的受风面积', '绝缘子串参数', 1, 'number'),
  def('SETTYPE', '串类型', '绝缘子串类型', '绝缘子串参数', 0, 'enum'),
  def('APPLICATION', '串用途', '绝缘子串的线路用途', '绝缘子串参数', 1, 'text'),
  def('LENGTH', '总长度', '绝缘子串或组件总长度', '几何参数', 1, 'number'),
  def('WEIGHT', '总质量', '绝缘子串或组件总质量', '几何参数', 1, 'number'),
  def('MATCHEDCONDUCTORTYPE', '适用导线型号', '绝缘子串适配的导线型号', '绝缘子串参数', 1, 'text'),
  def('TOWERPOINT', '连塔挂点数', '绝缘子串连接塔体的挂点数量', '绝缘子串参数', 1, 'number', '个'),
  def('STRINGNUMBER', '联数', '绝缘子串联数', '绝缘子串参数', 1, 'number', '个'),
  def('ENTANGLEMENTTYPE', '缠绕物类型', '预绞丝或缠绕物类型', '绝缘子串参数', 1, 'text'),
  def('ISENTANGLEMENT', '是否使用预绞丝', '是否为预绞丝悬垂线夹', '绝缘子串参数', 1, 'enum'),
  def('WIREPOINT', '接线点信息', '绝缘子串接线点局部坐标记录', '端点关系', 2, 'coordinate'),
  def('CONCRETEGRADE', '混凝土强度等级', '基础混凝土强度等级', '基础参数', 0, 'text'),
  def('CONCRETEVOL', '混凝土体积', '基础混凝土体积', '基础参数', 1, 'number'),
  def('STEELGRADE', '一般钢筋强度等级', '基础一般钢筋强度等级', '基础参数', 1, 'text'),
  def('STEELWEIGHT', '一般钢筋质量', '基础一般钢筋质量', '基础参数', 1, 'number'),
  def('CAGESTEELGRADE', '钢筋笼强度等级', '基础钢筋笼强度等级', '基础参数', 1, 'text'),
  def('CAGESTEELWEIGHT', '钢筋笼质量', '基础钢筋笼质量', '基础参数', 1, 'number'),
];

const SUBSTATION_DEV_DEFINITIONS: PropertyDefinition[] = [
  def('BASEFAMILYPOINTER', '属性族引用', '部分变电导出器使用的 DEV → FAM 引用', '来源引用', 1, 'reference'),
];

const IFC_SPACE_DEFINITIONS: PropertyDefinition[] = [
  def('ifcType', '空间类型', 'IFC 空间容器实体类型', '空间信息', 0, 'enum'),
  def('name', '名称', 'IFC 空间容器名称', '空间信息', 0, 'text'),
  def('longName', '长名称', 'IFC 空间容器长名称', '空间信息', 1, 'text'),
  def('description', '描述', 'IFC 空间容器描述', '空间信息', 1, 'text'),
  def('objectType', '对象类型', 'IFC 原生对象类型', '空间信息', 1, 'enum'),
  def('compositionType', '组成类型', 'IFC 空间组成类型', '空间关系', 1, 'enum'),
  def('elevation', '标高', 'IFC 空间标高', '位置', 0, 'number'),
  def('placement', '位置', 'IFC placement 位置', '位置', 1, 'coordinate'),
  def('geometryStatus', '几何状态', '是否提供 IFC Representation', '空间信息', 1, 'enum'),
  def('objectKeys', '空间内 IFC 构件', '空间包含或继承的 IFC 构件数量', '结构统计', 1, 'number', '个'),
  def('placementRef', 'IFC 放置引用', 'IFC ObjectPlacement 引用', '技术字段', 2, 'reference'),
  def('representationRef', 'IFC 表示引用', 'IFC Representation 引用', '技术字段', 2, 'reference'),
];

const IFC_OBJECT_DEFINITIONS: PropertyDefinition[] = [
  def('ifcType', 'IFC 类型', 'IFC 构件实体类型', '构件信息', 0, 'enum'),
  def('Name', '名称', 'IFC 构件名称', '构件信息', 0, 'text'),
  def('GlobalId', 'IFC GUID', 'IFC 构件 GlobalId；只用于追溯', '技术字段', 2, 'reference'),
  def('Description', '描述', 'IFC 构件描述', '构件信息', 1, 'text'),
  def('ObjectType', '对象类型', 'IFC 原生对象类型', '构件信息', 1, 'enum'),
  def('PredefinedType', '预定义类型', 'IFC 原生预定义类型', '构件信息', 1, 'enum'),
  def('Tag', 'Tag', 'IFC 构件标签', '构件信息', 1, 'text'),
  def('ExpressId', 'IFC ExpressId', 'IFC 模型内部实体编号', '技术字段', 2, 'number'),
  def('modelId', '模型', '当前 IFC 模型标识', '来源引用', 1, 'text'),
  def('relationshipCount', '关系记录数', 'IFC 关系记录数量', '结构统计', 2, 'number', '条'),
  def('geometryStatus', '几何状态', '是否提供 IFC Representation', '构件信息', 1, 'enum'),
  def('placement', '位置', 'IFC placement 位置', '位置', 1, 'coordinate'),
  def('materials', '材质', 'IFC 材质关联', '构件信息', 1, 'text'),
  def('classifications', '分类引用', 'IFC 分类关联', '构件信息', 1, 'reference'),
  def('groupNames', '所属组/系统', 'IFC 所属组或系统名称', '关系', 1, 'text'),
];

const LINE_WIRE_DEFINITIONS: PropertyDefinition[] = [
  def('TYPE', '导线型号', '导线/地线的型号名称', '导线参数', 0, 'text'),
  def('SECTIONALAREA', '截面面积', '导线金属截面面积', '导线参数', 0, 'number', 'mm²'),
  def('OUTSIDEDIAMETER', '外径', '导线外径', '导线参数', 0, 'number', 'mm'),
  def('WIREWEIGHT', '单位重量', '导线单位长度重量', '导线参数', 0, 'number', 'kg/km'),
  def('COEFFICIENTOFELASTICITY', '弹性模量', '导线材料弹性模量', '导线参数', 0, 'number', 'MPa'),
  def('EXPANSIONCOEFFICIENTOFWIRE', '线膨胀系数', '导线线性热膨胀系数；样本通常以 10⁻⁶/°C 表示', '导线参数', 0, 'number', '10⁻⁶/°C'),
  def('RATEDSTRENGTH', '额定拉断力', '导线额定拉断力', '导线参数', 0, 'number', 'N'),
];

const LINE_TOWER_DEFINITIONS: PropertyDefinition[] = [
  def('type', '基础类型', '杆塔基础或塔脚类型', '塔基参数', 0, 'text'),
  def('H1', '基础高度 H1', '基础几何高度参数 H1', '塔基参数', 0, 'number', 'mm'),
  def('H2', '基础高度 H2', '基础几何高度参数 H2', '塔基参数', 0, 'number', 'mm'),
  def('H3', '基础高度 H3', '基础几何高度参数 H3', '塔基参数', 1, 'number', 'mm'),
  def('H4', '基础高度 H4', '基础几何高度参数 H4', '塔基参数', 1, 'number', 'mm'),
  def('H5', '基础高度 H5', '可选基础几何高度参数 H5', '技术字段', 2, 'number', 'mm'),
  def('H6', '基础高度 H6', '可选基础几何高度参数 H6', '技术字段', 2, 'number', 'mm'),
  def('d', '基础直径 d', '基础底部/主直径参数', '塔基参数', 0, 'number', 'mm'),
  def('D', '基础直径 D', '导出器提供的大写直径参数', '塔基参数', 1, 'number', 'mm'),
  def('e1', '偏心距 e1', '基础横向偏心参数', '塔基参数', 1, 'number', 'mm'),
  def('e2', '偏心距 e2', '基础纵向偏心参数', '塔基参数', 1, 'number', 'mm'),
  def('α1', '转角 α1', '基础方向角参数', '技术字段', 2, 'number', '°'),
  def('α2', '转角 α2', '基础方向角参数', '技术字段', 2, 'number', '°'),
  def('ZCOUNT', '地脚数量', '基础地脚数量', '塔基参数', 0, 'number', '个'),
  def('ZPOSTARRAY', '地脚位置数组', '基础地脚位置序列', '技术字段', 2, 'text'),
];

const LINE_HNUM_DEFINITIONS: PropertyDefinition[] = [
  def('hNum', '档位数', 'H 记录声明的塔架档位数量', '杆塔骨架', 0, 'number', '个'),
  def('hRecords', '档位记录', '档位标高与 Body/Leg 归属记录', '杆塔骨架', 1, 'text'),
  def('bodySections', '体段', '杆塔主体 Body 分段', '杆塔骨架', 0, 'number', '段'),
  def('points', '节点', '局部毫米坐标 P 节点数量', '杆塔骨架', 0, 'number', '个'),
  def('rods', '杆件', 'P 节点之间的 R 杆件数量', '杆塔骨架', 0, 'number', '根'),
  def('groundPoints', '挂点', '导线/地线挂点 G 数量', '杆塔骨架', 0, 'number', '个'),
  def('hSubLegs', '子腿偏移', '塔腿高度偏移记录数量', '杆塔骨架', 1, 'number', '个'),
  def('hLegs', '腿顶坐标', '塔腿顶点平面坐标记录数量', '杆塔骨架', 1, 'number', '个'),
];

const LINE_BOLT_DEFINITIONS: PropertyDefinition[] = [
  def('boltNum', '螺栓数量', 'Bolt 文件声明的螺栓数量', '连接件', 0, 'number', '个'),
  def('spec', '规格', '螺栓规格，如 M64', '连接件', 0, 'text'),
  def('length', '长度', '螺栓长度', '连接件', 0, 'number', 'mm'),
  def('grade', '材质/等级', 'BoltN 第一段第 3 个 token；样本语义已确认', '连接件', 1, 'text'),
  def('code', '方位码', '螺栓法兰盘位置方位码', '连接件', 1, 'number'),
  def('x', 'X 坐标', '螺栓位置 X 坐标', '连接件', 0, 'number', 'mm'),
  def('y', 'Y 坐标', '螺栓位置 Y 坐标', '连接件', 0, 'number', 'mm'),
  def('z', 'Z 坐标', '螺栓位置 Z 坐标', '连接件', 0, 'number', 'mm'),
];

const LINE_POINT_DEFINITIONS: PropertyDefinition[] = [
  def('id', '点编号', 'POINT 记录编号', '跨越点', 0, 'number'),
  def('lat', '纬度', 'WGS84 纬度', '跨越点', 0, 'number', '°'),
  def('lon', '经度', 'WGS84 经度', '跨越点', 0, 'number', '°'),
  def('alt', '高程', '点高程', '跨越点', 0, 'number', 'm'),
  def('type', '点类型', '来源文件中的点类型编码，保留原值', '跨越点', 1, 'enum'),
  def('fromId', '起点编号', 'LINE 起点 POINT 编号', '跨越点', 0, 'number'),
  def('toId', '终点编号', 'LINE 终点 POINT 编号', '跨越点', 0, 'number'),
];

const DICTIONARIES: Record<PropertyComponent, PropertyDefinition[]> = {
  generic: GENERIC_DEFINITIONS,
  'substation-cbm': [...GENERIC_DEFINITIONS],
  'substation-fam': [...GENERIC_DEFINITIONS, ...SUBSTATION_FAM_DEFINITIONS],
  'substation-dev': [...GENERIC_DEFINITIONS, ...SUBSTATION_DEV_DEFINITIONS],
  'ifc-space': [...GENERIC_DEFINITIONS, ...IFC_SPACE_DEFINITIONS],
  'ifc-object': [...GENERIC_DEFINITIONS, ...IFC_OBJECT_DEFINITIONS],
  'line-node': [...GENERIC_DEFINITIONS, ...LINE_FAM_DEFINITIONS],
  'line-wire': [...GENERIC_DEFINITIONS, ...LINE_FAM_DEFINITIONS, ...LINE_WIRE_DEFINITIONS],
  'line-hnum': [...GENERIC_DEFINITIONS, ...LINE_FAM_DEFINITIONS, ...LINE_HNUM_DEFINITIONS],
  'line-bolt': [...GENERIC_DEFINITIONS, ...LINE_FAM_DEFINITIONS, ...LINE_BOLT_DEFINITIONS],
  'line-tower-device': [...GENERIC_DEFINITIONS, ...LINE_FAM_DEFINITIONS, ...LINE_TOWER_DEFINITIONS],
  'line-wire-params': [...GENERIC_DEFINITIONS, ...LINE_FAM_DEFINITIONS, ...LINE_WIRE_DEFINITIONS],
  'line-point-line': [...GENERIC_DEFINITIONS, ...LINE_FAM_DEFINITIONS, ...LINE_POINT_DEFINITIONS],
};

const definitionsByComponent = new Map<PropertyComponent, Map<string, PropertyDefinition>>();
for (const [component, definitions] of Object.entries(DICTIONARIES) as Array<[PropertyComponent, PropertyDefinition[]]>) {
  const map = new Map<string, PropertyDefinition>();
  for (const definition of definitions) {
    map.set(definition.key, definition);
    for (const alias of definition.aliases ?? []) map.set(alias, definition);
  }
  definitionsByComponent.set(component, map);
}

/** 导出机器可读字典，供文档/诊断工具使用；UI 不应直接修改。 */
export const PROPERTY_DICTIONARIES: Readonly<Record<PropertyComponent, readonly PropertyDefinition[]>> = DICTIONARIES;

function def(
  key: string,
  label: string,
  description: string,
  group: string,
  priority: PropertyPriority,
  dataType: PropertyDataType,
  unit?: string,
): PropertyDefinition {
  return { key, label, description, group, priority, dataType, ...(unit ? { unit } : {}) };
}

export function getPropertyDefinition(component: PropertyComponent, key: string): PropertyDefinition | undefined {
  const candidates = dictionaryKeyCandidates(key);
  for (const candidate of candidates) {
    const exact = definitionsByComponent.get(component)?.get(candidate);
    if (exact) return exact;
    const generic = definitionsByComponent.get('generic')?.get(candidate);
    if (generic) return generic;
  }
  const lowerCandidates = candidates.map((candidate) => candidate.toLowerCase());
  for (const definition of definitionsByComponent.get(component)?.values() ?? []) {
    if (lowerCandidates.includes(definition.key.toLowerCase()) || definition.aliases?.some((alias) => lowerCandidates.includes(alias.toLowerCase()))) return definition;
  }
  for (const definition of GENERIC_DEFINITIONS) {
    if (lowerCandidates.includes(definition.key.toLowerCase()) || definition.aliases?.some((alias) => lowerCandidates.includes(alias.toLowerCase()))) return definition;
  }
  return undefined;
}

/** 将带序号的 GIM 键归一到字典中的字段族（如 SOLIDMODEL0 → SOLIDMODEL）。 */
function dictionaryKeyCandidates(key: string): string[] {
  const candidates = [key];
  const add = (value: string): void => { if (!candidates.includes(value)) candidates.push(value); };
  if (/^BASEFAMILY\d+$/i.test(key)) add('BASEFAMILY');
  if (/^(SOLIDMODEL|TRANSFORMMATRIX|COLOR|SUBDEVICE|SUBSYSTEM|SECTION|STRAINSECTION|GROUP|TOWER|BASE|IFC)\d+$/i.test(key)) {
    add(key.replace(/\d+$/, ''));
  }
  if (/^STRING\d+\.STRING$/i.test(key)) add('STRING.STRING');
  if (/^STRING\d+\.GPOINT$/i.test(key)) add('STRING.GPOINT');
  if (/^POINT\d+\.BLHA$/i.test(key)) add('POINT0.BLHA');
  if (/^POINT\d+\.MATRIX0$/i.test(key)) add('POINT0.MATRIX0');
  return candidates;
}

export function getPropertyLabel(component: PropertyComponent, key: string): string {
  return getPropertyDefinition(component, key)?.label || key;
}

export function getPropertyGroup(component: PropertyComponent, key: string): string {
  return getPropertyDefinition(component, key)?.group || '技术字段';
}

export function getPropertyPriority(component: PropertyComponent, key: string): PropertyPriority {
  return getPropertyDefinition(component, key)?.priority ?? 2;
}

/** 对外暴露安全的引用推断，供关系页把 rawRefs 中的裸文件名转换为按钮。 */
export function getPropertyReferenceKind(
  component: PropertyComponent,
  key: string,
  value: unknown,
  explicit?: PropertyReferenceDetail['kind'],
): PropertyReferenceDetail['kind'] | undefined {
  return inferReferenceKind(component, key, value, explicit);
}

export function formatPropertyValue(component: PropertyComponent, key: string, value: unknown, unitOverride?: string): { text: string; html: string } {
  const definition = getPropertyDefinition(component, key);
  const text = value === null || value === undefined || value === '' ? '—' : String(value);
  if (definition?.dataType === 'coordinate' && text !== '—') {
    return formatCoordinateValue(key, text);
  }
  const unit = unitOverride ?? definition?.unit;
  const suffix = unit && text !== '—' && !text.endsWith(` ${unit}`) ? ` ${unit}` : '';
  const displayText = `${text}${suffix}`;
  return { text: displayText, html: escHtml(displayText) };
}

/**
 * 将 BLHA/POINT*.BLHA 这类逗号坐标拆成逐行字段。
 *
 * 原始值仍保留在 aria-label/CSV 文本中（用换行分隔），视觉值按“纬度、
 * 经度、高程、方位角”排列，避免一整串数字挤在检查器窄列中。对不完整
 * 或非数值坐标不做猜测，只按可识别的字段逐行展示。
 */
function formatCoordinateValue(key: string, raw: string): { text: string; html: string } {
  const parts = raw.split(/\s*,\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return { text: raw, html: escHtml(raw) };
  const labels = ['纬度', '经度', '高程', '方位角'];
  const units = ['°', '°', 'm', '°'];
  const prefix = /POINT0/i.test(key) ? '起点' : /POINT1/i.test(key) ? '终点' : '';
  const lines = parts.slice(0, labels.length).map((part, index) => {
    const label = `${prefix}${labels[index]}`;
    const unit = units[index] || '';
    return `${label} ${part}${unit ? ` ${unit}` : ''}`;
  });
  const text = lines.join('\n');
  const html = `<div class="prop-coordinate">${lines
    .map((line) => `<div class="prop-coordinate-row">${escHtml(line)}</div>`)
    .join('')}</div>`;
  return { text, html };
}

/**
 * 把属性值中的文件引用转成可读按钮。
 *
 * 不能只依据“值看起来像 UUID”：普通业务字段也可能包含编码。这里仅
 * 接受已知文件扩展名，或明确的引用键（BASEFAMILY/OBJECTMODELPOINTER/
 * IFCFILE/SOLIDMODEL/SCH 等），并且显式排除 IFCGUID。这样既不会误把
 * GUID 当作文件按钮，也不会让 GUID 文件名直接污染检查器正文。
 */
function inferReferenceKind(
  component: PropertyComponent,
  key: string,
  value: unknown,
  explicit?: PropertyReferenceDetail['kind'],
): PropertyReferenceDetail['kind'] | undefined {
  if (explicit) return explicit;
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text || /^IFCGUID$/i.test(key) || /guid/i.test(key)) return undefined;
  const keyUpper = key.toUpperCase();
  const extension = text.match(/\.(cbm|dev|fam|phm|mod|stl|ifc|sld)$/i)?.[1]?.toLowerCase();
  if (extension) return extension as PropertyReferenceDetail['kind'];
  if (keyUpper === 'OBJECTMODELPOINTER' || keyUpper.includes('DEVFILE') || keyUpper === 'DEV') return 'dev';
  if (keyUpper === 'BASEFAMILY' || keyUpper === 'BASEFAMILYPOINTER' || keyUpper.includes('FAMFILE') || keyUpper === 'FAM') return 'fam';
  if (keyUpper === 'IFCFILE' || keyUpper === 'IFC') return 'ifc';
  if (keyUpper.startsWith('SOLIDMODEL')) return component.startsWith('substation') ? 'phm' : 'file';
  if (keyUpper === 'SCH' || keyUpper === 'SLD') return 'sld';
  if (keyUpper.includes('CBMFILE') || keyUpper === 'CBM') return 'cbm';
  return undefined;
}

/**
 * 文件引用不会把 GUID 文件名暴露在正文中；完整路径只放在 data 属性里，
 * 点击后由注册的工程路由处理。这样既可追溯又不破坏检查器可读性。
 */
export function fileReferenceValue(
  kind: 'cbm' | 'dev' | 'fam' | 'phm' | 'mod' | 'stl' | 'ifc' | 'sld' | 'file',
  path: string,
  label?: string,
): FileReferenceValue {
  const labels: Record<typeof kind, string> = {
    cbm: '定位 CBM',
    dev: '查看 DEV',
    fam: '查看属性族',
    phm: '查看 PHM',
    mod: '查看 MOD',
    stl: '查看 STL',
    ifc: '切换 IFC 模型',
    sld: '打开电气图纸',
    file: '查看源文件',
  };
  const text = label || labels[kind];
  return {
    text,
    html: `<button type="button" class="prop-ref-link" data-prop-ref="1" data-reference-kind="${escHtml(kind)}" data-reference-path="${escHtml(path)}">${escHtml(text)}</button>`,
  };
}

export function fileReferencesValue(
  kind: Parameters<typeof fileReferenceValue>[0],
  paths: string[],
  label?: string,
): FileReferenceValue {
  const unique = Array.from(new Set(paths.filter(Boolean)));
  if (unique.length === 0) return { text: '—', html: '—' };
  const values = unique.map((path, index) => fileReferenceValue(kind, path, label || (unique.length > 1 ? `${label || '查看来源'} ${index + 1}` : undefined)));
  return {
    text: values.map((value) => value.text).join('、'),
    html: values.map((value) => value.html).join('<span class="prop-ref-separator"> </span>'),
  };
}

export function renderPropertyRows(
  component: PropertyComponent,
  rows: PropertyRow[],
  options: { technicalOnly?: boolean; includeTechnical?: boolean; allowReferences?: boolean } = {},
): string {
  const filtered = rows.filter((row) => {
    const priority = row.definition?.priority ?? getPropertyPriority(component, row.key);
    if (options.technicalOnly) return priority >= 2;
    if (options.includeTechnical === false) return priority < 2;
    return true;
  });
  if (filtered.length === 0) return '';
  return `<table class="props-table">${filtered.map((row) => {
    const definition = row.definition || getPropertyDefinition(component, row.key);
    const formatted = formatPropertyValue(component, row.key, row.value, row.unit);
    let valueHtml = row.valueHtml || formatted.html;
    let valueText = row.valueText ?? formatted.text;
    // 参数/关系等业务面板可以关闭自动引用渲染，把所有文件入口统一收敛
    // 到“来源”页签；显式传入的 valueHtml 仍然保留，便于来源页使用按钮。
    const referenceKind = options.allowReferences === false
      ? undefined
      : inferReferenceKind(component, row.key, row.value, row.referenceKind);
    if (!row.valueHtml && referenceKind) {
      const reference = fileReferenceValue(referenceKind, String(row.value), `查看${getPropertyLabel(component, row.key)}`);
      valueHtml = reference.html;
      valueText = reference.text;
    }
    const title = definition?.description ? ` title="${escHtml(definition.description)}"` : '';
    const classes = ['prop-val'];
    if (row.mono || definition?.dataType === 'matrix') classes.push('mono-val');
    if (definition?.dataType === 'coordinate') classes.push('coordinate-val');
    if ((definition?.priority ?? 2) >= 2) classes.push('prop-technical');
    // valueText is deliberately retained as a plain-text accessibility/CSV
    // fallback even when valueHtml is a reference button.  Keeping it on the
    // row makes the renderer safe for callers that provide a formatted link
    // while still exposing the human-readable value to assistive technology.
    return `<tr><td class="prop-key"${title}>${escHtml(definition?.label || row.key)}</td><td class="${classes.join(' ')}" aria-label="${escHtml(valueText)}">${valueHtml}</td></tr>`;
  }).join('')}</table>`;
}

export function renderPropertySection(
  title: string,
  component: PropertyComponent,
  rows: PropertyRow[],
  options: { technicalOnly?: boolean; includeTechnical?: boolean; details?: boolean; allowReferences?: boolean } = {},
): string {
  const table = renderPropertyRows(component, rows, options);
  if (!table) return '';
  return options.details
    ? `<details class="props-advanced"><summary>${escHtml(title)}</summary>${table}</details>`
    : `<div class="props-section"><div class="props-section-title">${escHtml(title)}</div>${table}</div>`;
}

export function renderTechnicalSection(
  title: string,
  component: PropertyComponent,
  rows: PropertyRow[],
  options: { allowReferences?: boolean } = {},
): string {
  return renderPropertySection(title, component, rows, { technicalOnly: true, details: true, ...options });
}
