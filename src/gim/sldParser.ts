/**
 * SLD（Single Line Diagram）解析器。
 *
 * SLD 是 GIM 工程的电气单线图（SVG 格式），描述电气设备的图形化布局：
 *
 * ```xml
 * <svg version="DLT1" xmlns="..." xmlns:xlink="..." width="..." height="..." viewBox="...">
 *   <defs>
 *     <script type="text/css"><![CDATA[.主接线连接线层 {fill:none;stroke:rgb(0,191,255);}]]></script>
 *     <symbol id="UUID" xOffset="..." yOffset="..."> ... </symbol>
 *   </defs>
 *   <g id="BackGround_Layer" type="Drawing"> ... </g>
 *   <g gridId="A0AEC*002" type="Bay">
 *     <use xlink:href="#UUID" x="..." y="..." />
 *     ...
 *   </g>
 * </svg>
 * ```
 *
 * **关键发现**：
 * - SLD 中 `<g gridId="..." type="Bay|ConductingEquipment|...">` 的 gridId 与 STD 一一对应
 * - `<symbol>` 定义元件图形（id 为 UUID），通过 `<use xlink:href="#UUID">` 实例化
 * - CSS 在 `<script type="text/css">` 块中，Tauri CSP 下会被阻止，需预处理为 `<style>` 标签
 *
 * 关联文档：[05-cbm-tree-structure.md](../../docs/schema/05-cbm-tree-structure.md)
 */

/** SLD 顶层文档 */
export interface SldDocument {
  /** SVG 版本（如 `DLT1`） */
  version: string;
  /** 软件（如 `GRevitTools`） */
  soft: string;
  /** 修订号（如 `2023`） */
  revision: string;
  /** SVG width */
  width: number;
  /** SVG height */
  height: number;
  /** SVG viewBox（[minX, minY, width, height]） */
  viewBox: [number, number, number, number];
  /** 提取后的 CSS 文本（已从 `<script>` 块抽出，CSP 兼容） */
  css: string;
  /** symbol 定义（id → symbol 元素 outerHTML，保留原始定义） */
  symbols: Map<string, string>;
  /** 顶层图形元素列表（含背景层、Bay、ConductingEquipment 等） */
  groups: SldGroup[];
  /** gridId → SLD 节点索引（仅含 gridId 非空的节点） */
  gridIdIndex: Map<string, SldNode>;
  /** 安全化处理后的 SVG outerHTML（用于 inline 嵌入） */
  safeSvgOuterHTML: string;
}

/** SLD 节点公共字段 */
export interface SldNode {
  /** SVG 元素类型（g/use/line/circle/path 等） */
  tag: string;
  /** id 属性 */
  id: string;
  /** gridId 属性（仅 `<g>` 才有） */
  gridId: string;
  /** type 属性（Bay/ConductingEquipment/Drawing 等） */
  type: string;
  /** 在 SVG 中的层级路径 */
  path: string;
  /** 子节点 */
  children: SldNode[];
  /** 原始属性表 */
  attributes: Record<string, string>;
}

/** SLD 顶层 `<g>` 元素 */
export interface SldGroup extends SldNode {
  tag: 'g';
  /** use 实例列表（指向 symbol） */
  uses: SldUse[];
  /** 直接子 `<g>` 列表 */
  subGroups: SldGroup[];
}

/** SLD `<use>` 元素 */
export interface SldUse extends SldNode {
  tag: 'use';
  /** 引用的 symbol id（不含 `#` 前缀） */
  symbolId: string;
  /** x 偏移 */
  x: number | null;
  /** y 偏移 */
  y: number | null;
}

/**
 * 解析 SLD SVG 文本。
 *
 * 处理步骤：
 * 1. DOMParser 解析 SVG
 * 2. 抽出 `<defs>` 内的 `<script type="text/css">` CDATA 内容 → 单一 CSS 字符串
 * 3. 删除原始 `<script>` 块（CSP 兼容）
 * 4. 收集 `<symbol id="UUID">` 定义 → 保留 outerHTML
 * 5. 遍历顶层 `<g>` 节点，构建 gridId 索引
 * 6. 重新序列化 safeSvgOuterHTML（已剔除 script 块的 SVG）
 *
 * @param text SLD SVG 文本
 * @param sourcePath 文件路径（用于错误消息）
 * @returns 解析后的 SldDocument；若 SVG 无效返回空文档
 */
export function parseSld(text: string, sourcePath: string = ''): SldDocument {
  const emptyDoc: SldDocument = {
    version: '',
    soft: '',
    revision: '',
    width: 0,
    height: 0,
    viewBox: [0, 0, 0, 0],
    css: '',
    symbols: new Map(),
    groups: [],
    gridIdIndex: new Map(),
    safeSvgOuterHTML: '',
  };

  if (!text || !text.trim()) return emptyDoc;

  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'image/svg+xml');
  const parseError = xml.querySelector('parsererror');
  if (parseError) {
    console.warn(`[SLD] SVG 解析失败: ${sourcePath}`, parseError.textContent);
    return emptyDoc;
  }

  const svg = xml.documentElement;
  if (svg.tagName.toLowerCase() !== 'svg') {
    console.warn(`[SLD] 根元素非 svg: ${svg.tagName}, source=${sourcePath}`);
    return emptyDoc;
  }

  const version = svg.getAttribute('version') || '';
  const soft = svg.getAttribute('soft') || '';
  const revision = svg.getAttribute('reversion') || svg.getAttribute('revision') || '';
  const width = parseFloat(svg.getAttribute('width') || '0') || 0;
  const height = parseFloat(svg.getAttribute('height') || '0') || 0;
  const viewBox = parseViewBox(svg.getAttribute('viewBox'));

  // 1. 抽出 <script type="text/css"> CDATA 内容，删除原始 <script> 块
  let css = '';
  const defsEl = findChildElement(svg, 'defs');
  if (defsEl) {
    for (const scriptEl of findChildElements(defsEl, 'script')) {
      const type = scriptEl.getAttribute('type') || '';
      if (type === 'text/css' || type === 'application/ecmascript') {
        css += scriptEl.textContent || '';
        scriptEl.remove();
      }
    }
  }

  // 2. 收集 <symbol id="UUID"> 定义
  const symbols = new Map<string, string>();
  if (defsEl) {
    for (const symEl of findChildElements(defsEl, 'symbol')) {
      const id = symEl.getAttribute('id') || '';
      if (id) symbols.set(id, symEl.outerHTML);
    }
  }

  // 3. 遍历顶层 <g> 节点，构建 gridId 索引
  const gridIdIndex = new Map<string, SldNode>();
  const groups: SldGroup[] = [];
  for (const child of Array.from(svg.children)) {
    if (child.tagName.toLowerCase() === 'g') {
      const g = parseGroup(child as SVGGElement, gridIdIndex, '');
      groups.push(g);
    }
  }

  return {
    version,
    soft,
    revision,
    width,
    height,
    viewBox,
    css,
    symbols,
    groups,
    gridIdIndex,
    safeSvgOuterHTML: svg.outerHTML,
  };
}

/** 解析 viewBox 字符串 "0 0 351.2542 182.5214" */
function parseViewBox(s: string | null): [number, number, number, number] {
  if (!s) return [0, 0, 0, 0];
  const parts = s.split(/[\s,]+/).map((p) => parseFloat(p)).filter((n) => Number.isFinite(n));
  if (parts.length < 4) return [0, 0, 0, 0];
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts[3] || 0];
}

function findChildElement(parent: Element, tagName: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (child.tagName.toLowerCase() === tagName.toLowerCase()) return child;
  }
  return null;
}

function findChildElements(parent: Element, tagName: string): Element[] {
  return Array.from(parent.children).filter((c) => c.tagName.toLowerCase() === tagName.toLowerCase());
}

function extractAttributes(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    attrs[attr.name] = attr.value;
  }
  return attrs;
}

function parseGroup(el: Element, gridIdIndex: Map<string, SldNode>, parentPath: string): SldGroup {
  const attrs = extractAttributes(el);
  const id = attrs.id || '';
  const gridId = attrs.gridId || '';
  const type = attrs.type || '';
  const path = parentPath ? `${parentPath}/${id || type || 'g'}` : (id || type || 'g');

  const node: SldGroup = {
    tag: 'g',
    id,
    gridId,
    type,
    path,
    children: [],
    attributes: attrs,
    uses: [],
    subGroups: [],
  };
  if (gridId) gridIdIndex.set(gridId, node);

  for (const child of Array.from(el.children)) {
    const lowerTag = child.tagName.toLowerCase();
    if (lowerTag === 'use') {
      const use = parseUse(child, path);
      node.uses.push(use);
      node.children.push(use);
    } else if (lowerTag === 'g') {
      const sub = parseGroup(child, gridIdIndex, path);
      node.subGroups.push(sub);
      node.children.push(sub);
    } else {
      // 其他 SVG 元素（line/circle/path 等）保留为通用节点
      const generic: SldNode = {
        tag: child.tagName.toLowerCase(),
        id: child.getAttribute('id') || '',
        gridId: child.getAttribute('gridId') || '',
        type: child.getAttribute('type') || '',
        path: `${path}/${child.tagName}`,
        children: [],
        attributes: extractAttributes(child),
      };
      node.children.push(generic);
      if (generic.gridId) gridIdIndex.set(generic.gridId, generic);
    }
  }
  return node;
}

function parseUse(el: Element, parentPath: string): SldUse {
  const attrs = extractAttributes(el);
  const href = attrs['xlink:href'] || attrs['href'] || '';
  const symbolId = href.replace(/^#/, '');

  const xStr = attrs.x || '';
  const yStr = attrs.y || '';
  const x = xStr ? parseFloat(xStr) : null;
  const y = yStr ? parseFloat(yStr) : null;

  return {
    tag: 'use',
    id: attrs.id || '',
    gridId: attrs.gridId || '',
    type: attrs.type || '',
    path: `${parentPath}/use:${symbolId}`,
    children: [],
    attributes: attrs,
    symbolId,
    x: Number.isFinite(x as number) ? (x as number) : null,
    y: Number.isFinite(y as number) ? (y as number) : null,
  };
}
