import type { FamSourceProperty } from '../gim/famParser.js';
import { classifySubstationNode, compareSubstationNames as compareFunctionalNames, projectSubstationSystemNames, type BusinessCategory } from '../gim/substationBusiness.js';
import { setBusinessDeviceCount } from './shell/statusBar.js';
import type { AppState } from '../app/state.js';
import { normalizeEntityName } from '../gim/entityName.js';
import { substationDevIdentity } from '../gim/substationEvidence.js';
import type { CbmNode } from '../gim/types.js';
import { getNodeDisplayName } from '../shared/displayName.js';
import type { SearchItem } from './searchBox.js';

/** 功能系统树中 F4/部件的业务角色。 */
export type FunctionalRole = BusinessCategory | 'mixed';

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
  sourceNodes: CbmNode[];
  ownerPath?: string;
  role: FunctionalRole;
  parts: FunctionalPartProjection[];
  classification: ReturnType<typeof classifySubstationNode>;
}

export interface FunctionalSystemProjection {
  key: string;
  node: CbmNode;
  title: string;
  domainKey: string;
  groupPath: string[];
  implicit: boolean;
  sourceNodes: CbmNode[];
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

const ROLE_LABELS: Record<FunctionalRole, string> = {
  component: '构件',
  device: '设备',
  mixed: '构件 / 设备',
  other: '未分类对象',
  conductor: '线形导体', grounding: '接地防雷', structure: '构架', appliance: '建筑器具', placeholder: '占位残留',
};

const ROLE_ORDER: FunctionalRole[] = ['device', 'component', 'conductor', 'grounding', 'structure', 'appliance', 'placeholder', 'mixed', 'other'];

/**
 * 从 CbmNode 构建功能系统域投影。
 *
 * 按任意层级的 SYSTEMNAME 与装配子树投影；物理实体类型不决定业务角色。
 * 所有对象保留真实 path，来源别名只在唯一证据成立时合并。
 */
const functionalIndexes = new WeakMap<CbmNode, {index:FunctionalDomainIndex; fam:ReadonlyMap<string,readonly FamSourceProperty[]> | undefined; size:number}>();
export function buildFunctionalDomainIndex(root: CbmNode, fam?: ReadonlyMap<string,readonly FamSourceProperty[]>): FunctionalDomainIndex {
  const cached = functionalIndexes.get(root); if (cached && cached.fam === fam && cached.size === (fam?.size ?? 0)) return cached.index;
  const sourcePath = (path: string) => path.replace(/\\/g,'/').toLowerCase();
  const famByPath = new Map([...(fam ?? [])].map(([path,rows]) => [sourcePath(path),rows]));
  const domainByKey = new Map<string, FunctionalDomainProjection>();
  const systemByKey = new Map<string, FunctionalSystemProjection>();
  const targetByKey = new Map<string, FunctionalSearchTarget>();
  const parentByKey = new Map<string, string>();
  const domainOrder: FunctionalDomainProjection[] = [];
  const visited = new WeakSet<CbmNode>();
  const assetPaths = new Set<string>();
  targetByKey.set(FUNCTIONAL_ROOT_KEY, {key:FUNCTIONAL_ROOT_KEY,rowKey:FUNCTIONAL_ROOT_KEY,kind:'root'});

  const systemFor = (names: string[], source: CbmNode, container = false): FunctionalSystemProjection => {
    names = projectSubstationSystemNames(names);
    const first = names[0], normalized = first ? normalizeDomain(first) : null;
    const domainKey = normalized ? `functional:domain:${encodeURIComponent(normalized.key)}` : 'functional:domain:unclassified';
    let domain = domainByKey.get(domainKey);
    if (!domain) {
      domain = {key:domainKey,title:first ?? '未归类系统',inferred:false,systems:[],disciplineCodes:[],disciplineLabels:[],sourceCodes:[]};
      domainByKey.set(domainKey,domain);domainOrder.push(domain);
    }
    const key = functionalSystemKey(JSON.stringify([domainKey,...names.slice(1)]));
    let system = systemByKey.get(key);
    if (!system) {
      system = {key,node:source,title:names.length > 1 ? names[names.length-1] : '未分组对象',domainKey,
        groupPath:names.slice(1,-1),implicit:names.length<=1,sourceNodes:[],disciplineCodes:[],disciplineLabels:[],assets:[]};
      systemByKey.set(key,system);domain.systems.push(system);
    }
    if (container && !system.sourceNodes.includes(source)) system.sourceNodes.push(source);
    return system;
  };
  const visit = (node: CbmNode, inherited: string[], owner?: FunctionalAssetProjection | FunctionalPartProjection): void => {
    if (visited.has(node)) return; visited.add(node);
    const classification = classifySubstationNode(node,famByPath.get(sourcePath(node.famPath)));
    const role = classification.category;
    const hasSource = Boolean(node.devPath.trim() || node.ifcFile.trim() || node.ifcGuid.trim());
    const namedContainer = !hasSource && !isPartNode(node)
      && (node.systemNames.length >= 2 || /(?:系统|间隔|区域|工程)$/.test(node.name.trim()));
    const asset = !namedContainer && (hasSource || role !== 'other' || isPartNode(node));
    // SYSTEMNAME is source evidence at any physical depth. Classification codes do not manufacture names.
    let names = inherited;
    const explicit = node.systemNames.map(cleanToken).filter((name): name is string => name !== null).filter(name =>
      !asset || /(?:系统|间隔|区域|工程)$/.test(name) || classifySubstationNode({...node,name,devSymbolName:'',classifyName:''}).category === 'other');
    if (explicit.length) names = inherited.length && explicit[0] !== inherited[0] ? [...inherited,...explicit] : explicit;
    else if (!asset && node !== root && /系统|间隔|建筑|构筑/.test(node.name) && !node.name.includes('（含')) {
      const labels = extractFunctionalNames(node);
      if (labels.length) names = inherited.length && labels[0] !== inherited[0] ? [...inherited,...labels] : labels;
    }
    if (!asset && node !== root && (explicit.length || node.classifyName && !node.children.length)) systemFor(names,node,true);
    let nextOwner = owner;
    if (asset && !assetPaths.has(node.path)) {
      assetPaths.add(node.path);
      if (owner && role !== 'device') {
        const part: FunctionalPartProjection = {key:functionalPartKey(node.path),node,sourceNodes:[node],children:[]};
        if ('parts' in owner) owner.parts.push(part); else owner.children.push(part);
        nextOwner = part;
      } else {
        const projected: FunctionalAssetProjection = {node,sourceNodes:[node],ownerPath:owner?.node.path,role,parts:[],classification};
        systemFor(names,node).assets.push(projected); nextOwner = projected;
      }
    }
    for (const child of node.children) visit(child,names,nextOwner);
  };
  visit(root,[]);
  mergeSemanticAssets([...systemByKey.values()]);
  for (const domain of domainOrder) for (const system of domain.systems) {
    let parent = domain.key;
    system.groupPath.forEach((_title,i) => {
      const key = functionalBranchKey(domain.key,system.groupPath.slice(0,i+1),systemByKey);
      registerTarget(targetByKey,{key,rowKey:key,kind:'system'});parentByKey.set(key,parent); parent=key;
    });
    parentByKey.set(system.key,parent);
    registerTarget(targetByKey,{key:system.key,rowKey:system.implicit ? domain.key : system.key,kind:'system',node:system.node});
    for (const source of system.sourceNodes) registerTarget(targetByKey,{key:source.path,rowKey:system.implicit ? domain.key : system.key,kind:'system',node:source});
    for (const projected of system.assets) projected.parts = mergeSemanticParts(projected.parts);
    const roleGroups = getRoleGroups(system.assets);
    for (const [role,assets] of roleGroups) {
      const roleKey = functionalRoleKey(system.key,role);
      if (roleGroups.size > 1) parentByKey.set(roleKey,system.implicit ? domain.key : system.key);
      for (const asset of assets) {
        // A real object's selection identity takes precedence over an assembly grouping label.
        for (const source of asset.sourceNodes) targetByKey.set(source.path,{key:source.path,rowKey:asset.node.path,kind:'asset',node:source});
        parentByKey.set(asset.node.path,roleGroups.size > 1 ? roleKey : system.implicit ? domain.key : system.key);
        registerPartTargets(asset.parts,asset.node.path,targetByKey,parentByKey);
      }
    }
  }

  const sortedDomains = domainOrder.slice().sort(compareDomains);
  for (const domain of sortedDomains) domain.systems.sort((a,b) => compareFunctionalNames(a.groupPath[0] ?? a.title,b.groupPath[0] ?? b.title)
    || compareFunctionalNames(a.title,b.title));
  for (const domain of sortedDomains) {
    registerTarget(targetByKey, {
      key: domain.key,
      rowKey: domain.key,
      kind: 'domain',
    });
    parentByKey.set(domain.key, FUNCTIONAL_ROOT_KEY);
  }

  // 让唯一的“未归类系统”始终出现在末尾，并且最多只有一个。
  const index: FunctionalDomainIndex = {
    root,
    rootKey: FUNCTIONAL_ROOT_KEY,
    domains: sortedDomains,
    domainByKey,
    systemByKey,
    targetByKey,
    parentByKey,
  };
  functionalIndexes.set(root,{index,fam,size:fam?.size ?? 0});
  return index;
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
          '功能组',
          `对象 ${system.assets.length}`,
          discipline,
          system.node.classifyName ? `来源码 ${system.node.classifyName}` : undefined,
        ].filter(Boolean).join(' · '),
      });
      for (const source of system.sourceNodes) push({key:source.path,title:system.title,
        subtitle:`来源路径 · ${functionalDomainLabel(domain)}`});
      for (const asset of system.assets) {
        const title = getNodeDisplayName(asset.node, state.ifcGuidToName, state.currentIfcEntries) || ROLE_LABELS[asset.role];
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
        for (const source of asset.sourceNodes) if (source.path!==asset.node.path) push({key:source.path,title,
          subtitle:`设备来源别名 · ${system.title} · ${source.path}`});
        for (const part of flattenPartProjections(asset.parts)) {
        const partTitle = getNodeDisplayName(part.node, state.ifcGuidToName, state.currentIfcEntries) || '部件';
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
  setBusinessDeviceCount(index.domains.reduce((sum,domain) => sum + domain.systems.reduce((count,system) =>
    count + system.assets.filter(asset => asset.role === 'device').length,0),0));
  renderFunctionalNode(
    parentEl,
    index.rootKey,
    state.projectName || '变电工程',
    '◎',
    `${index.domains.length} 个功能系统域 · ${totalSystems} 个系统 · 对象 ${totalAssets}`,
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
        renderGroups(domain,domain.systems,0,childrenEl);
      },
      undefined,
      false,
      `${domainBranchCount(domain)} 个系统`,
    );
  }

  function renderGroups(domain: FunctionalDomainProjection, systems: FunctionalSystemProjection[], depth: number, host: HTMLElement): void {
    const groups = new Map<string,FunctionalSystemProjection[]>();
    for (const system of systems) {
      if (system.implicit) { renderSystemContents(system,host);continue; }
      const title=[...system.groupPath,system.title][depth];
      if (!title) continue;
      const rows=groups.get(title) ?? [];rows.push(system);groups.set(title,rows);
    }
    for (const [title,rows] of [...groups].sort(([a],[b]) => compareFunctionalNames(a,b))) {
      const direct = rows.find(row => row.groupPath.length === depth);
      const children = rows.filter(row => row.groupPath.length > depth);
      if (!children.length && direct) { renderSystem(direct,host);continue; }
      const path = [...rows[0].groupPath,rows[0].title].slice(0,depth+1);
      renderFunctionalNode(host,functionalBranchKey(domain.key,path,index.systemByKey),title,'▦',
        '按来源功能归属合并；包含间隔与尚未分配间隔的对象',true,el => {
          renderGroups(domain,children,depth+1,el);
          if (direct?.assets.length) renderSystemContents(direct,el);
        },direct ? () => onNodeClick(direct.node) : undefined,false,
        `${new Set(children.map(row => [...row.groupPath,row.title][depth+1])).size} 个功能组`);
    }
  }

  function renderSystem(system: FunctionalSystemProjection, host: HTMLElement): void {
    if (system.implicit) { renderSystemContents(system,host);return; }
    const componentCount = system.assets.filter((asset) => asset.role === 'component' || asset.role === 'mixed').length;
    const deviceCount = system.assets.filter((asset) => asset.role === 'device' || asset.role === 'mixed').length;
    const subtitle = [
      `对象 ${system.assets.length}`,
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
      childrenEl => renderSystemContents(system,childrenEl),
      () => onNodeClick(system.node),
      false,
      `${system.assets.length} 个对象`,
    );
  }

  function renderSystemContents(system: FunctionalSystemProjection, childrenEl: HTMLElement): void {
    const roleGroups=getRoleGroups(system.assets);

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
  }

  function renderAsset(asset: FunctionalAssetProjection, host: HTMLElement): void {
    const node = asset.node;
    const title = getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries) || ROLE_LABELS[asset.role];
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
      `${ROLE_LABELS[asset.role]}${asset.classification.conflict ? ' · 分类证据冲突' : ''} · ${source}${state.deviceUnknownBounds.has(node.path) ? ' · 完整范围未确定，自动加载可支持几何' : ''}`,
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
      false,
      state.deviceUnknownBounds.has(node.path) ? '范围未确定' : '',
    );
  }

  function renderPart(part: FunctionalPartProjection, host: HTMLElement): void {
    const title = getNodeDisplayName(part.node, state.ifcGuidToName, state.currentIfcEntries) || '部件';
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

function extractFunctionalNames(node: CbmNode): string[] {
  // Parser-added child summaries do not turn an exporter classification code
  // into a functional domain name. Keep that readable hint on the system row.
  if (node.rawProperties && node.systemNames.length === 0
      && node.name.split('（含')[0] === node.classifyName) return [];
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
  // 1PT、1EM PT、10S 等是合法间隔名。纯数字、星号编码已在上方排除。
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

function isPartNode(node: CbmNode): boolean {
  const entity = normalizeEntityName(node.entityName);
  return entity === 'PARTINDEX' || entity === 'DEV_SUBDEVICE';
}

/** Only a unique PARTINDEX/DEV_SUBDEVICE pair under the same owner is an alias.
 * Repeated references of either kind remain separate; never zip by array order. */
function mergeSemanticParts(parts: FunctionalPartProjection[]): FunctionalPartProjection[] {
  const groups = new Map<string,FunctionalPartProjection[]>();
  for (const part of parts) { const key=partIdentity(part.node);const rows=groups.get(key) ?? [];rows.push(part);groups.set(key,rows); }
  const result: FunctionalPartProjection[] = [];
  for (const rows of groups.values()) {
    const pair = rows.length === 2 && rows.some(p=>normalizeEntityName(p.node.entityName)==='PARTINDEX')
      && rows.some(p=>normalizeEntityName(p.node.entityName)==='DEV_SUBDEVICE');
    if (pair) {
      const first = rows.find(p=>normalizeEntityName(p.node.entityName)==='PARTINDEX')!;
      const second = rows.find(p=>p!==first)!;
      first.sourceNodes.push(...second.sourceNodes);first.children.push(...second.children);
      first.children=mergeSemanticParts(first.children);result.push(first);
    } else for (const row of rows) { row.children=mergeSemanticParts(row.children);result.push(row); }
  }
  return result;
}

/** Independently functional units can also have PARTINDEX/DEV_SUBDEVICE
 * aliases. Coalesce only a unique pair under the same semantic owner; repeated
 * placements and ambiguous same-kind references remain distinct. */
function mergeSemanticAssets(systems: FunctionalSystemProjection[]): void {
  const owners = new Map<string,string>();
  const canonical = (path:string):string => {
    const seen = new Set<string>();
    while (owners.has(path) && !seen.has(path)) { seen.add(path);path=owners.get(path)!; }
    return path;
  };
  const noteParts = (parts:FunctionalPartProjection[]):void => {
    for (const part of parts) { for (const source of part.sourceNodes) if (source.path!==part.node.path) owners.set(source.path,part.node.path);noteParts(part.children); }
  };
  for (const system of systems) for (const asset of system.assets) { asset.parts=mergeSemanticParts(asset.parts);noteParts(asset.parts); }
  let changed:boolean;
  do {
    changed=false;
    for (const system of systems) {
      const candidates = new Map<string,FunctionalAssetProjection[]>();
      for (const asset of system.assets) {
        const dev = substationDevIdentity(asset.node.devPath);
        if (!asset.ownerPath || !dev || asset.sourceNodes.length!==1 || !isPartNode(asset.node)) continue;
        const key=JSON.stringify([canonical(asset.ownerPath),dev]);
        const rows=candidates.get(key) ?? [];rows.push(asset);candidates.set(key,rows);
      }
      const removed=new Set<FunctionalAssetProjection>();
      for (const rows of candidates.values()) {
        if (rows.length!==2 || !rows.some(row=>normalizeEntityName(row.node.entityName)==='PARTINDEX')
          || !rows.some(row=>normalizeEntityName(row.node.entityName)==='DEV_SUBDEVICE')) continue;
        const first=rows.find(row=>normalizeEntityName(row.node.entityName)==='PARTINDEX')!,second=rows.find(row=>row!==first)!;
        first.sourceNodes.push(...second.sourceNodes);first.parts=mergeSemanticParts([...first.parts,...second.parts]);
        first.classification={...first.classification,conflict:first.classification.conflict||second.classification.conflict,
          evidence:[...new Set([...first.classification.evidence,...second.classification.evidence])],
          famEvidence:[...new Set([...first.classification.famEvidence,...second.classification.famEvidence])]};
        noteParts(first.parts);owners.set(second.node.path,first.node.path);removed.add(second);changed=true;
      }
      if (removed.size) system.assets=system.assets.filter(asset=>!removed.has(asset));
    }
  } while (changed);
}
function functionalGroupKey(domain: string, labels: string[]): string { return `functional:group:${encodeURIComponent(JSON.stringify([domain,...labels]))}`; }
function functionalBranchKey(domain: string, labels: string[], systems: Map<string,FunctionalSystemProjection>): string {
  const direct = functionalSystemKey(JSON.stringify([domain,...labels]));
  return systems.has(direct) ? direct : functionalGroupKey(domain,labels);
}
function domainBranchCount(domain: FunctionalDomainProjection): number {
  return new Set(domain.systems.filter(system => !system.implicit).map(system => system.groupPath[0] ?? system.title)).size;
}

function partIdentity(node: CbmNode): string {
  const devPath = substationDevIdentity(node.devPath);
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
    `${domainBranchCount(domain)} 个系统`,
    `对象 ${f4}`,
    discipline,
    source,
  ].filter(Boolean).join(' · ');
}

function formatDiscipline(labels: string[], codes: string[]): string | undefined {
  if (labels.length > 0) return `专业 ${labels.join('/')}`;
  if (codes.length > 0) return `专业码 ${codes.join('/')}`;
  return undefined;
}
