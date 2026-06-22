import type { AppState } from '../app/state.js';
import { normalizeEntityName } from '../gim/entityName.js';
import type { CbmNode } from '../gim/types.js';
import { getNodeDisplayName } from '../shared/displayName.js';
import type { SearchItem } from './searchBox.js';

/** 功能系统树中 F4/部件的业务角色。 */
export type FunctionalRole = 'component' | 'device' | 'mixed' | 'other';

export interface FunctionalPartProjection {
  /** 投影行的稳定键；仍指向一个真实 CbmNode。 */
  key: string;
  node: CbmNode;
  /** PARTINDEX 与 DEV_SUBDEVICE 的同一语义部件来源。 */
  sourceNodes: CbmNode[];
  children: FunctionalPartProjection[];
}

export interface FunctionalAssetProjection {
  node: CbmNode;
  role: FunctionalRole;
  parts: FunctionalPartProjection[];
}

export interface FunctionalSystemProjection {
  key: string;
  node: CbmNode;
  title: string;
  domainKey: string;
  disciplineCodes: string[];
  disciplineLabels: string[];
  assets: FunctionalAssetProjection[];
}

export interface FunctionalDomainProjection {
  key: string;
  title: string;
  inferred: boolean;
  systems: FunctionalSystemProjection[];
  disciplineCodes: string[];
  disciplineLabels: string[];
  /** F2 原始码，包含无法映射为 U/A/S/G 的来源证据。 */
  sourceCodes: string[];
}

export interface FunctionalSearchTarget {
  key: string;
  rowKey: string;
  kind: 'root' | 'domain' | 'system' | 'asset' | 'part';
  node?: CbmNode;
}

/** 功能系统投影索引。所有行都能反查真实 CbmNode 或其稳定投影键。 */
export interface FunctionalDomainIndex {
  root: CbmNode;
  rootKey: string;
  domains: FunctionalDomainProjection[];
  domainByKey: Map<string, FunctionalDomainProjection>;
  systemByKey: Map<string, FunctionalSystemProjection>;
  targetByKey: Map<string, FunctionalSearchTarget>;
  /** 投影行到父投影行的关系，供搜索只展开命中祖先链。 */
  parentByKey: Map<string, string>;
}

const FUNCTIONAL_ROOT_KEY = 'functional:project-root';

const DISCIPLINES: Record<string, { label: string; fullLabel: string }> = {
  U: { label: '建筑', fullLabel: '建筑工程' },
  A: { label: '安装', fullLabel: '安装工程' },
  S: { label: '暖通', fullLabel: '暖通工程' },
  G: { label: '给排水', fullLabel: '给排水工程' },
};

const ROLE_LABELS: Record<FunctionalRole, string> = {
  component: '构件',
  device: '设备',
  mixed: '构件 / 设备',
  other: '其他对象',
};

const ROLE_ORDER: FunctionalRole[] = ['component', 'device', 'mixed', 'other'];

/**
 * 从 CbmNode 构建功能系统域投影。
 *
 * F2 只作为专业上下文，F3 的第一个可靠 SYSTEMNAME 才决定域；
 * F4/PARTINDEX/DEV_SUBDEVICE 保留真实 path，避免视角切换复制对象。
 */
export function buildFunctionalDomainIndex(root: CbmNode): FunctionalDomainIndex {
  const domainByKey = new Map<string, FunctionalDomainProjection>();
  const systemByKey = new Map<string, FunctionalSystemProjection>();
  const targetByKey = new Map<string, FunctionalSearchTarget>();
  const parentByKey = new Map<string, string>();
  const seenSystemPaths = new Set<string>();
  const domainOrder: FunctionalDomainProjection[] = [];

  targetByKey.set(FUNCTIONAL_ROOT_KEY, {
    key: FUNCTIONAL_ROOT_KEY,
    rowKey: FUNCTIONAL_ROOT_KEY,
    kind: 'root',
  });

  const visit = (node: CbmNode, discipline: DisciplineContext | null): void => {
    const entity = normalizeEntityName(node.entityName);
    let nextDiscipline = discipline;
    if (entity === 'F2System') nextDiscipline = readDiscipline(node.classifyName);

    if (entity === 'F3System' && !seenSystemPaths.has(node.path)) {
      seenSystemPaths.add(node.path);
      const domainInfo = deriveDomain(node);
      let domain = domainByKey.get(domainInfo.key);
      if (!domain) {
        domain = {
          key: domainInfo.key,
          title: domainInfo.title,
          inferred: domainInfo.inferred,
          systems: [],
          disciplineCodes: [],
          disciplineLabels: [],
          sourceCodes: [],
        };
        domainByKey.set(domain.key, domain);
        domainOrder.push(domain);
      } else if (domain.inferred && !domainInfo.inferred) {
        // 同域后续出现可靠名称时取消“推断”标记。
        domain.inferred = false;
        domain.title = domainInfo.title;
      }

      const systemKey = functionalSystemKey(node.path);
      const system: FunctionalSystemProjection = {
        key: systemKey,
        node,
        title: deriveSystemTitle(node, domain.systems.length + 1),
        domainKey: domain.key,
        disciplineCodes: nextDiscipline?.codes.slice() ?? [],
        disciplineLabels: nextDiscipline?.labels.slice() ?? [],
        assets: collectAssetNodes(node).map((asset) => ({
          node: asset,
          role: roleForNode(asset),
          parts: buildPartProjections(asset.children.filter(isPartNode)),
        })),
      };
      domain.systems.push(system);
      addAll(domain.disciplineCodes, system.disciplineCodes);
      addAll(domain.disciplineLabels, system.disciplineLabels);
      if (nextDiscipline) addAll(domain.sourceCodes, nextDiscipline.sourceCodes);
      systemByKey.set(system.key, system);

      registerTarget(targetByKey, {
        key: system.key,
        rowKey: system.key,
        kind: 'system',
        node,
      });
      registerTarget(targetByKey, {
        key: node.path,
        rowKey: system.key,
        kind: 'system',
        node,
      });
      parentByKey.set(system.key, domain.key);

      const roleGroups = getRoleGroups(system.assets);
      for (const [role, assets] of roleGroups) {
        const roleKey = functionalRoleKey(system.key, role);
        if (roleGroups.size > 1) parentByKey.set(roleKey, system.key);
        for (const asset of assets) {
          const assetPath = asset.node.path;
          registerTarget(targetByKey, {
            key: assetPath,
            rowKey: assetPath,
            kind: 'asset',
            node: asset.node,
          });
          parentByKey.set(assetPath, roleGroups.size > 1 ? roleKey : system.key);
          registerPartTargets(asset.parts, assetPath, targetByKey, parentByKey);
        }
      }
    }

    for (const child of node.children) visit(child, nextDiscipline);
  };

  visit(root, null);

  const sortedDomains = domainOrder.slice().sort(compareDomains);
  for (const domain of sortedDomains) {
    registerTarget(targetByKey, {
      key: domain.key,
      rowKey: domain.key,
      kind: 'domain',
    });
    parentByKey.set(domain.key, FUNCTIONAL_ROOT_KEY);
  }

  // 让唯一的“未归类系统”始终出现在末尾，并且最多只有一个。
  return {
    root,
    rootKey: FUNCTIONAL_ROOT_KEY,
    domains: sortedDomains,
    domainByKey,
    systemByKey,
    targetByKey,
    parentByKey,
  };
}

/** 构建功能系统视角搜索索引。可搜索域、F3、F4、部件及来源路径。 */
export function buildFunctionalSearchIndex(
  state: AppState,
  index: FunctionalDomainIndex,
): SearchItem[] {
  const items: SearchItem[] = [];
  const seen = new Set<string>();
  const push = (item: SearchItem): void => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };

  for (const domain of index.domains) {
    push({
      key: domain.key,
      title: functionalDomainLabel(domain),
      subtitle: domainSubtitle(domain),
    });
    for (const system of domain.systems) {
      const discipline = formatDiscipline(system.disciplineLabels, system.disciplineCodes);
      push({
        key: system.key,
        title: system.title,
        subtitle: [
          functionalDomainLabel(domain),
          'F3 系统',
          `F4 ${system.assets.length}`,
          discipline,
          system.node.classifyName ? `来源码 ${system.node.classifyName}` : undefined,
        ].filter(Boolean).join(' · '),
      });
      // 允许直接按真实 F3 路径命中，同时仍回到同一行。
      push({
        key: system.node.path,
        title: system.title,
        subtitle: `F3 路径 · ${functionalDomainLabel(domain)}`,
      });
      for (const asset of system.assets) {
        const title = getNodeDisplayName(asset.node, state.ifcGuidToName) || ROLE_LABELS[asset.role];
        push({
          key: asset.node.path,
          title,
          subtitle: [
            ROLE_LABELS[asset.role],
            system.title,
            functionalDomainLabel(domain),
            asset.node.entityName,
            asset.node.ifcFile ? `IFC ${asset.node.ifcFile}` : undefined,
            asset.node.devPath ? `DEV ${asset.node.devPath}` : undefined,
            asset.node.devType || undefined,
          ].filter(Boolean).join(' · '),
        });
        for (const part of flattenPartProjections(asset.parts)) {
          const partTitle = getNodeDisplayName(part.node, state.ifcGuidToName) || '部件';
          const sourceLabel = part.sourceNodes.map((source) => normalizeEntityName(source.entityName))
            .filter((value, pos, all) => all.indexOf(value) === pos)
            .join('/');
          push({
            key: part.key,
            title: partTitle,
            subtitle: [
              '部件',
              sourceLabel,
              system.title,
              functionalDomainLabel(domain),
              part.node.devPath ? `DEV ${part.node.devPath}` : undefined,
            ].filter(Boolean).join(' · '),
          });
          for (const source of part.sourceNodes) {
            if (source.path === part.node.path) continue;
            push({
              key: source.path,
              title: partTitle,
              subtitle: `部件来源 · ${sourceLabel} · ${system.title}`,
            });
          }
        }
      }
    }
  }
  return items;
}

/** 搜索命中后，只展开功能树中从工程根到目标行的祖先链。 */
export function revealFunctionalSearchTarget(
  index: FunctionalDomainIndex,
  key: string,
): string | null {
  const target = index.targetByKey.get(key);
  if (!target) return null;
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = target.rowKey;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = index.parentByKey.get(current);
  }
  chain.push(index.rootKey);
  chain.reverse();
  for (const rowKey of chain) ensureFunctionalRowExpanded(rowKey);
  return target.rowKey;
}

/** 渲染变电“功能系统”视角；不会创建第二份 CbmNode。 */
export function renderSubstationFunctionalTree(
  state: AppState,
  index: FunctionalDomainIndex,
  parentEl: HTMLElement,
  onNodeClick: (node: CbmNode) => void,
): void {
  const totalSystems = index.domains.reduce((sum, domain) => sum + domain.systems.length, 0);
  const totalAssets = index.domains.reduce(
    (sum, domain) => sum + domain.systems.reduce((inner, system) => inner + system.assets.length, 0),
    0,
  );
  renderFunctionalNode(
    parentEl,
    index.rootKey,
    state.projectName || '变电工程',
    '◎',
    `${index.domains.length} 个功能系统域 · ${totalSystems} 个系统 · F4 ${totalAssets}`,
    index.domains.length > 0,
    (childrenEl) => {
      for (const domain of index.domains) renderDomain(domain, childrenEl);
    },
    undefined,
    true,
    `${index.domains.length} 个域`,
  );

  function renderDomain(domain: FunctionalDomainProjection, host: HTMLElement): void {
    renderFunctionalNode(
      host,
      domain.key,
      functionalDomainLabel(domain),
      '▦',
      domainSubtitle(domain),
      domain.systems.length > 0,
      (childrenEl) => {
        for (const system of domain.systems) renderSystem(system, childrenEl);
      },
      undefined,
      false,
      `${domain.systems.length} 个系统`,
    );
  }

  function renderSystem(system: FunctionalSystemProjection, host: HTMLElement): void {
    const roleGroups = getRoleGroups(system.assets);
    const componentCount = system.assets.filter((asset) => asset.role === 'component' || asset.role === 'mixed').length;
    const deviceCount = system.assets.filter((asset) => asset.role === 'device' || asset.role === 'mixed').length;
    const subtitle = [
      `F4 ${system.assets.length}`,
      componentCount > 0 ? `构件 ${componentCount}` : undefined,
      deviceCount > 0 ? `设备 ${deviceCount}` : undefined,
      formatDiscipline(system.disciplineLabels, system.disciplineCodes),
    ].filter(Boolean).join(' · ');
    renderFunctionalNode(
      host,
      system.key,
      system.title,
      '≋',
      subtitle,
      system.assets.length > 0,
      (childrenEl) => {
        if (roleGroups.size > 1) {
          for (const [role, assets] of roleGroups) {
            renderFunctionalNode(
              childrenEl,
              functionalRoleKey(system.key, role),
              ROLE_LABELS[role],
              role === 'component' ? '◇' : role === 'device' ? '◆' : role === 'mixed' ? '◈' : '□',
              `${system.title} · 角色投影；对象仍使用原始 CBM path`,
              assets.length > 0,
              (roleEl) => {
                for (const asset of assets) renderAsset(asset, roleEl);
              },
              undefined,
              false,
              String(assets.length),
            );
          }
        } else {
          for (const asset of system.assets) renderAsset(asset, childrenEl);
        }
      },
      () => onNodeClick(system.node),
      false,
      `${system.assets.length} 个对象`,
    );
  }

  function renderAsset(asset: FunctionalAssetProjection, host: HTMLElement): void {
    const node = asset.node;
    const title = getNodeDisplayName(node, state.ifcGuidToName) || ROLE_LABELS[asset.role];
    const source = [
      normalizeEntityName(node.entityName),
      node.ifcFile ? `IFC ${node.ifcFile}` : undefined,
      node.devPath ? `DEV ${node.devPath}` : undefined,
      node.devType || undefined,
    ].filter(Boolean).join(' · ');
    renderFunctionalNode(
      host,
      node.path,
      title,
      asset.role === 'component' ? '◇' : asset.role === 'device' ? '◆' : asset.role === 'mixed' ? '◈' : '□',
      `${ROLE_LABELS[asset.role]} · ${source}`,
      asset.parts.length > 0,
      (childrenEl) => {
        const partsKey = functionalPartsKey(node.path);
        renderFunctionalNode(
          childrenEl,
          partsKey,
          '部件',
          '•',
          'PARTINDEX 与 DEV_SUBDEVICE 合并为一个语义节点；不重复生成几何',
          asset.parts.length > 0,
          (partsEl) => {
            for (const part of asset.parts) renderPart(part, partsEl);
          },
          undefined,
          false,
          String(asset.parts.length),
        );
      },
      () => onNodeClick(node),
    );
  }

  function renderPart(part: FunctionalPartProjection, host: HTMLElement): void {
    const title = getNodeDisplayName(part.node, state.ifcGuidToName) || '部件';
    const sourceLabel = part.sourceNodes.map((source) => normalizeEntityName(source.entityName))
      .filter((value, pos, all) => all.indexOf(value) === pos).join('/');
    renderFunctionalNode(
      host,
      part.key,
      title,
      '•',
      `部件 · 来源 ${sourceLabel || 'CBM'}${part.node.devPath ? ` · DEV ${part.node.devPath}` : ''}`,
      part.children.length > 0,
      (childrenEl) => {
        for (const child of part.children) renderPart(child, childrenEl);
      },
      () => onNodeClick(part.node),
    );
  }
}

function renderFunctionalNode(
  parentEl: HTMLElement,
  key: string,
  labelText: string,
  iconText: string,
  subtitle: string,
  hasChildren: boolean,
  renderChildren: (childrenEl: HTMLElement) => void,
  onSelect?: () => void,
  initiallyExpanded = false,
  badgeText = '',
): void {
  const nodeEl = document.createElement('div');
  nodeEl.className = 'tree-node functional-tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row functional-tree-row';
  row.dataset.nodePath = key;
  row.setAttribute('role', 'treeitem');
  row.tabIndex = 0;
  const toggle = document.createElement(hasChildren ? 'button' : 'span');
  toggle.className = `tree-toggle ${hasChildren ? '' : 'leaf'}`;
  toggle.textContent = '▶';
  if (hasChildren) {
    (toggle as HTMLButtonElement).type = 'button';
    (toggle as HTMLButtonElement).dataset.toggleKey = key;
    (toggle as HTMLButtonElement).setAttribute('aria-label', `展开或折叠 ${labelText}`);
    row.setAttribute('aria-expanded', 'false');
  }
  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = iconText;
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = labelText || '未命名对象';
  label.title = subtitle;
  row.title = [labelText, subtitle].filter(Boolean).join(' · ');
  row.append(toggle, icon, label);
  // 树行只显示业务相关的短计数；完整来源、实体类型、路径等细节仍在 tooltip、搜索和属性面板中。
  if (badgeText.trim()) {
    const badge = document.createElement('span');
    badge.className = 'functional-badge';
    badge.textContent = badgeText;
    badge.title = subtitle;
    badge.setAttribute('aria-label', subtitle);
    row.appendChild(badge);
  }
  const childrenEl = document.createElement('div');
  childrenEl.className = 'tree-children';
  nodeEl.append(row, childrenEl);

  let expanded = false;
  let rendered = false;
  const setExpanded = (next: boolean): void => {
    if (!hasChildren) return;
    expanded = next;
    toggle.classList.toggle('expanded', expanded);
    childrenEl.classList.toggle('expanded', expanded);
    row.setAttribute('aria-expanded', String(expanded));
    if (expanded && !rendered) {
      renderChildren(childrenEl);
      rendered = true;
    }
  };
  if (hasChildren) {
    (toggle as HTMLButtonElement).addEventListener('click', (event) => {
      event.stopPropagation();
      setExpanded(!expanded);
    });
  }
  row.addEventListener('click', () => {
    document.querySelectorAll('.tree-row.selected').forEach((item) => item.classList.remove('selected'));
    row.classList.add('selected');
    onSelect?.();
  });
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      row.click();
    } else if (event.key === 'ArrowRight' && hasChildren && !expanded) {
      event.preventDefault();
      setExpanded(true);
    } else if (event.key === 'ArrowLeft' && hasChildren && expanded) {
      event.preventDefault();
      setExpanded(false);
    }
  });
  parentEl.appendChild(nodeEl);
  if (initiallyExpanded) setExpanded(true);
}

function ensureFunctionalRowExpanded(key: string): void {
  const escaped = typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(key)
    : key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const row = document.querySelector<HTMLElement>(`.tree-row[data-node-path="${escaped}"]`);
  if (!row) return;
  const toggle = row.querySelector<HTMLButtonElement>('.tree-toggle[data-toggle-key]');
  if (!toggle || toggle.classList.contains('expanded')) return;
  toggle.click();
}

function deriveDomain(node: CbmNode): { key: string; title: string; inferred: boolean } {
  const names = extractFunctionalNames(node);
  const first = names[0];
  if (first) {
    const normalized = normalizeDomain(first);
    return { key: `functional:domain:${encodeURIComponent(normalized.key)}`, title: first, inferred: false };
  }
  const inferred = inferDomainFromClassification(node.classifyName || node.name);
  if (inferred) {
    return {
      key: `functional:domain:${encodeURIComponent(inferred.key)}`,
      title: inferred.title,
      inferred: true,
    };
  }
  return {
    key: 'functional:domain:unclassified',
    title: '未归类系统',
    inferred: false,
  };
}

function deriveSystemTitle(node: CbmNode, ordinal: number): string {
  const names = extractFunctionalNames(node);
  if (names.length > 0) return names.join(' / ');
  const fallback = cleanToken(node.name);
  if (fallback) return fallback;
  return `未命名系统 ${String(ordinal).padStart(2, '0')}`;
}

function extractFunctionalNames(node: CbmNode): string[] {
  const raw = node.systemNames.length > 0
    ? node.systemNames
    : node.name.split(/\s*\/\s*/g);
  const result: string[] = [];
  for (const value of raw) {
    const clean = cleanToken(value);
    if (!clean || result.includes(clean)) continue;
    result.push(clean);
  }
  return result;
}

function cleanToken(value: string): string | null {
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  if (text === '-' || text === '$' || text === '其它' || text === '其他' || text === '&其他') return null;
  if (/^null\d*$/i.test(text) || /^other(?:s)?$/i.test(text)) return null;
  if (/^(?:null\d*)(?:[_/\- ]+(?:null\d*))*$/i.test(text)) return null;
  if (text.startsWith('&')) return null;
  if (/^\d+$/.test(text)) return null;
  // 带 * 的纯编码（如 0AEC*006、0****001）不作为业务系统名。
  if (/^[0-9a-z_*./-]+$/i.test(text) && text.includes('*')) return null;
  // 数字开头且没有中文通常是分类/序号，不把它提升为功能域。
  if (/^\d/.test(text) && !/[\u3400-\u9fff]/.test(text)) return null;
  return text;
}

function normalizeDomain(value: string): { key: string; title: string } {
  const text = value.trim().replace(/\s+/g, ' ');
  if (/(?:交流|直流)?电气系统$/.test(text)) return { key: 'electrical', title: text };
  if (/^(?:建筑工程|建筑物(?:系统)?|建筑)$/.test(text)) return { key: 'building', title: text };
  if (/^(?:构筑物(?:系统)?|构筑物)$/.test(text)) return { key: 'structure', title: text };
  if (/^(?:暖通|空调)(?:工程|系统)?$/.test(text)) return { key: 'hvac', title: text };
  if (/^(?:给排水|排水|消防)(?:工程|系统)?$/.test(text)) return { key: 'plumbing', title: text };
  return { key: text.toLocaleLowerCase(), title: text };
}

function inferDomainFromClassification(value: string): { key: string; title: string } | null {
  const text = value.trim();
  if (!text || text.startsWith('&')) return null;
  if (/电气/.test(text)) return { key: 'electrical', title: '电气系统' };
  if (/建筑/.test(text)) return { key: 'building', title: '建筑物系统' };
  if (/构筑/.test(text)) return { key: 'structure', title: '构筑物系统' };
  if (/暖通|空调/.test(text)) return { key: 'hvac', title: '暖通系统' };
  if (/给排水|排水|消防/.test(text)) return { key: 'plumbing', title: '给排水系统' };
  return null;
}

function readDiscipline(value: string): DisciplineContext | null {
  const raw = value.trim();
  if (!raw) return null;
  const code = raw.toUpperCase();
  const known = DISCIPLINES[code];
  if (known) return { codes: [code], labels: [known.label], sourceCodes: [raw] };
  return { codes: [], labels: [], sourceCodes: [raw] };
}

interface DisciplineContext {
  codes: string[];
  labels: string[];
  sourceCodes: string[];
}

function collectAssetNodes(system: CbmNode): CbmNode[] {
  const result: CbmNode[] = [];
  const seen = new Set<string>();
  const walk = (node: CbmNode): void => {
    for (const child of node.children) {
      const entity = normalizeEntityName(child.entityName);
      if (entity === 'F3System') continue;
      if (entity === 'F4System' || entity === 'PARTINDEX' || entity === 'DEV_SUBDEVICE') {
        if (!seen.has(child.path)) {
          seen.add(child.path);
          result.push(child);
        }
        continue;
      }
      walk(child);
    }
  };
  walk(system);
  return result;
}

function isPartNode(node: CbmNode): boolean {
  const entity = normalizeEntityName(node.entityName);
  return entity === 'PARTINDEX' || entity === 'DEV_SUBDEVICE';
}

function roleForNode(node: CbmNode): FunctionalRole {
  const hasIfc = Boolean(node.ifcFile.trim() || node.ifcGuid.trim());
  const hasDev = Boolean(node.devPath.trim());
  if (hasIfc && hasDev) return 'mixed';
  if (hasIfc) return 'component';
  if (hasDev) return 'device';
  return 'other';
}

function buildPartProjections(nodes: CbmNode[]): FunctionalPartProjection[] {
  const result: FunctionalPartProjection[] = [];
  const byIdentity = new Map<string, FunctionalPartProjection>();
  for (const node of nodes) {
    const identity = partIdentity(node);
    let projection = byIdentity.get(identity);
    if (!projection) {
      projection = {
        key: functionalPartKey(node.path),
        node,
        sourceNodes: [node],
        children: buildPartProjections(node.children.filter(isPartNode)),
      };
      byIdentity.set(identity, projection);
      result.push(projection);
    } else {
      projection.sourceNodes.push(node);
      mergePartChildren(projection.children, buildPartProjections(node.children.filter(isPartNode)));
    }
  }
  return result;
}

function mergePartChildren(target: FunctionalPartProjection[], additions: FunctionalPartProjection[]): void {
  const byIdentity = new Map(target.map((part) => [partIdentity(part.node), part]));
  for (const addition of additions) {
    const existing = byIdentity.get(partIdentity(addition.node));
    if (!existing) {
      target.push(addition);
      byIdentity.set(partIdentity(addition.node), addition);
    } else {
      existing.sourceNodes.push(...addition.sourceNodes);
      mergePartChildren(existing.children, addition.children);
    }
  }
}

function partIdentity(node: CbmNode): string {
  const devPath = node.devPath.trim().replace(/\\/g, '/').toLowerCase();
  return devPath ? `dev:${devPath}` : `path:${node.path}`;
}

function flattenPartProjections(parts: FunctionalPartProjection[]): FunctionalPartProjection[] {
  const result: FunctionalPartProjection[] = [];
  const walk = (part: FunctionalPartProjection): void => {
    result.push(part);
    for (const child of part.children) walk(child);
  };
  for (const part of parts) walk(part);
  return result;
}

function registerPartTargets(
  parts: FunctionalPartProjection[],
  parentKey: string,
  targetByKey: Map<string, FunctionalSearchTarget>,
  parentByKey: Map<string, string>,
  wrapInPartsGroup = true,
): void {
  if (parts.length === 0) return;
  const childParentKey = wrapInPartsGroup ? functionalPartsKey(parentKey) : parentKey;
  if (wrapInPartsGroup) parentByKey.set(childParentKey, parentKey);
  for (const part of parts) {
    registerTarget(targetByKey, { key: part.key, rowKey: part.key, kind: 'part', node: part.node });
    parentByKey.set(part.key, childParentKey);
    for (const source of part.sourceNodes) {
      registerTarget(targetByKey, { key: source.path, rowKey: part.key, kind: 'part', node: part.node });
    }
    registerPartTargets(part.children, part.key, targetByKey, parentByKey, false);
  }
}

function registerTarget(targetByKey: Map<string, FunctionalSearchTarget>, target: FunctionalSearchTarget): void {
  if (!targetByKey.has(target.key)) targetByKey.set(target.key, target);
}

function getRoleGroups(
  assets: FunctionalAssetProjection[],
): Map<FunctionalRole, FunctionalAssetProjection[]> {
  const groups = new Map<FunctionalRole, FunctionalAssetProjection[]>();
  for (const role of ROLE_ORDER) {
    const matching = assets.filter((asset) => asset.role === role);
    if (matching.length > 0) groups.set(role, matching);
  }
  return groups;
}

function addAll(target: string[], values: string[]): void {
  for (const value of values) if (value && !target.includes(value)) target.push(value);
}

function compareDomains(a: FunctionalDomainProjection, b: FunctionalDomainProjection): number {
  const priority = (domain: FunctionalDomainProjection): number => {
    if (domain.key.endsWith('electrical')) return 0;
    if (domain.key.endsWith('building')) return 1;
    if (domain.key.endsWith('structure')) return 2;
    if (domain.key.endsWith('hvac')) return 3;
    if (domain.key.endsWith('plumbing')) return 4;
    if (domain.key.endsWith('unclassified')) return 99;
    return 10;
  };
  return priority(a) - priority(b);
}

function functionalSystemKey(path: string): string {
  return `functional:system:${encodeURIComponent(path)}`;
}

function functionalRoleKey(systemKey: string, role: FunctionalRole): string {
  return `functional:role:${encodeURIComponent(systemKey)}:${role}`;
}

function functionalPartsKey(assetPath: string): string {
  return `functional:parts:${encodeURIComponent(assetPath)}`;
}

function functionalPartKey(path: string): string {
  return `functional:part:${encodeURIComponent(path)}`;
}

function functionalDomainLabel(domain: FunctionalDomainProjection): string {
  return `${domain.title}${domain.inferred ? '（推断）' : ''}`;
}

function domainSubtitle(domain: FunctionalDomainProjection): string {
  const f4 = domain.systems.reduce((sum, system) => sum + system.assets.length, 0);
  const discipline = formatDiscipline(domain.disciplineLabels, domain.disciplineCodes);
  const source = domain.sourceCodes.length > 0
    ? `来源码 ${domain.sourceCodes.slice(0, 5).join('/')}${domain.sourceCodes.length > 5 ? '等' : ''}`
    : undefined;
  return [
    `${domain.systems.length} 个系统`,
    `F4 ${f4}`,
    discipline,
    source,
  ].filter(Boolean).join(' · ');
}

function formatDiscipline(labels: string[], codes: string[]): string | undefined {
  if (labels.length > 0) return `专业 ${labels.join('/')}`;
  if (codes.length > 0) return `专业码 ${codes.join('/')}`;
  return undefined;
}
