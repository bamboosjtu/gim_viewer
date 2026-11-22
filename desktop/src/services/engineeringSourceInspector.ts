import { reportBackgroundError } from '../utils/backgroundErrors.js';
import { selectionPresentation } from './selectionPresentationPort.js';
import type { AppState, SelectionRequest } from '../app/state.js';
import { engineeringSourceRecord } from './engineeringViewService.js';
import { selectEngineeringTarget } from './engineeringSelection.js';
import { sourceInspectorPresentation } from './sourceInspectorPresentationPort.js';
import { getEngineeringEvidenceSnapshot } from './engineeringService.js';

/** Reads a source document on explicit request; never opens an IFC STEP
 * definition tree or promotes a document to an engineering entity.
 */
export async function inspectEngineeringDocument(
  state: AppState,
  path: string,
  cbmOccurrenceId?: string,
  existing?: SelectionRequest,
): Promise<void> {
  const sources = state.engineering.sources;
  if (!sources) return;
  const inventory = new Set([
    ...state.substationEntryPaths,
    ...sources.graph.documents.map((doc) => doc.path),
    ...sources.graph.ifcPaths,
  ]);
  if (!inventory.has(path)) return;
  const request =
      existing ??
      state.selection.beginSelection({
        kind: 'engineering-source',
        key: cbmOccurrenceId ?? `document:${path}`,
      }),
    guard = state.selection.selectionGuard(request);
  if (!guard.isCurrent()) return;
  await selectionPresentation().sourceTree(state, guard.isCurrent);
  if (!guard.isCurrent()) return;

  let doc = sources.graph.documents.find((doc) => doc.path === path);
  const isIfc = /\.ifc$/i.test(path);
  if (!doc && !isIfc && /\.(?:cbm|dev|fam|phm|mod|sch|std)$/i.test(path)) {
    let bytes: Uint8Array;
    try {
      const file = state.currentFiles?.get(path);
      if (file) {
        if (file.size > 16 * 1024 * 1024) throw Error('来源文本超过单次查看上限');
        bytes = new Uint8Array(await file.arrayBuffer());
      } else {
        const projectId = state.currentProjectId;
        if (projectId == null) throw Error('来源文件不可用');
        if ((state.substationEntrySizes.get(path) ?? 0) > 16 * 1024 * 1024)
          throw Error('来源文本超过单次查看上限');
        const { readCachedEntry } = await import('../infrastructure/native/projectFiles.js');
        bytes = await readCachedEntry(projectId, path, guard.isCurrent);
      }
      if (!guard.isCurrent()) return;
      if (bytes.length > 16 * 1024 * 1024) throw Error('来源文本超过单次查看上限');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        text = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
      }
      const rawLines = text.split(/\r?\n/);
      doc = {
        path,
        rawLines,
        fields: rawLines.flatMap((rawLine, index) => {
          const at = rawLine.indexOf('=');
          return at > 0
            ? [
                {
                  path,
                  line: index + 1,
                  keys: [rawLine.slice(0, at).trim()],
                  value: rawLine.slice(at + 1).trim(),
                  rawLine,
                },
              ]
            : [];
        }),
      };
    } catch (error) {
      if (guard.isCurrent())
        await sourceInspectorPresentation().error(path, String(error), guard.isCurrent);
      return;
    }
  }
  if (!guard.isCurrent()) return;
  const candidateIds = new Set<string>();
  const occurrenceIds = new Set(
    cbmOccurrenceId
      ? [cbmOccurrenceId]
      : sources.graph.cbmOccurrences
          .filter((node) => node.documentPath === path)
          .map((node) => node.id),
  );
  if (occurrenceIds.size) {
    for (const row of sources.graph.attributeRecords ?? [])
      if (row.attributeContextId && occurrenceIds.has(row.attributeContextId))
        candidateIds.add(row.id);
    for (const row of sources.graph.records)
      if (
        row.devOccurrence &&
        occurrenceIds.has(row.devOccurrence.cbmOccurrenceId) &&
        row.devOccurrence.rootSourceId === row.id
      )
        candidateIds.add(row.id);
    sources.graph.aliases
      .filter((alias) => occurrenceIds.has(alias.sourceId))
      .forEach((alias) => alias.candidates.forEach((id) => candidateIds.add(id)));
    sources.ifcMatches
      .filter((match) => occurrenceIds.has(match.cbmOccurrenceId))
      .forEach((match) => match.ifcSourceIds.forEach((id) => candidateIds.add(id)));
  }
  const references = sources.graph.references.filter((reference) => reference.owner === path);
  const ifcModel = sources.models.find((model) => model.path === path);
  let inventoryNote = '尚未取得',
    parsedNote = '尚未取得';
  try {
    const evidence = await getEngineeringEvidenceSnapshot(state, [path]);
    inventoryNote = `${evidence.inventoryTotals?.entries ?? evidence.entries.length} 个条目`;
    parsedNote = `${evidence.inventoryTotals?.parsedComplete ?? 0} 个条目属性已解析，其他范围按需读取`;
  } catch {
    /* Source documents remain inspectable without an active evidence port. */
  }
  if (!guard.isCurrent()) return;
  const recognition = state.engineering.snapshot?.recognitionCoverage;
  const rows: [string, string][] = [
    ['文件', path],
    ['浏览对象', isIfc ? 'IFC 交付文件' : '来源文档'],
    ['来源清单', inventoryNote],
    ['属性解析范围', parsedNote],
    [
      '识别处理范围',
      recognition
        ? `${recognition.processed} / ${recognition.inputSourceIds.length} 个输入来源`
        : '尚未完成',
    ],
    ...(doc ? ([['原始行数', String(doc.rawLines.length)]] as [string, string][]) : []),
    ...(isIfc
      ? ([
          [
            '外露对象与特征',
            String(sources.ifcRecords.filter((row) => row.sources.includes(path)).length),
          ],
          ['读取状态', ifcModel?.error ?? (ifcModel ? '已解析外露接口' : '尚未完成')],
        ] as [string, string][])
      : []),
  ];
  await sourceInspectorPresentation().document({
    path,
    doc,
    isIfc,
    rows,
    references,
    candidateCount: candidateIds.size,
    candidates: [...candidateIds].slice(0, 100).map((id) => ({
      label: engineeringSourceRecord(state, id)?.name ?? '关联来源',
      choose: () => {
        if (guard.isCurrent())
          void selectEngineeringTarget(state, { kind: 'engineering-source', key: id }).catch(
            reportBackgroundError,
          );
      },
    })),
    current: guard.isCurrent,
    onDocument: (path) => {
      if (guard.isCurrent())
        void inspectEngineeringDocument(state, path).catch(reportBackgroundError);
    },
  });
  if (state.initialized) {
    const [{ getViewerRuntimeWithUI }, { commitSelectionHighlight }] = await Promise.all([
      import('./viewerUIBinding.js'),
      import('../viewer/highlight.js'),
    ]);
    if (guard.isCurrent()) {
      const { ctx } = await getViewerRuntimeWithUI(state, () => {});
      if (guard.isCurrent()) await commitSelectionHighlight(ctx, state, guard);
    }
  }
}

/** IFC spatial containers are provenance context, never extra engineering
 * entities. Their delivered hierarchy and outward members remain inspectable. */
export async function inspectEngineeringContext(
  state: AppState,
  key: string,
  existing?: SelectionRequest,
): Promise<void> {
  const sources = state.engineering.sources,
    node = sources?.spatialNodes.find((node) => node.key === key);
  if (!sources || !node) return;
  const request =
      existing ??
      state.selection.beginSelection({ kind: 'engineering-source', key: `context:${key}` }),
    guard = state.selection.selectionGuard(request);
  if (!guard.isCurrent()) return;
  await selectionPresentation().sourceTree(state, guard.isCurrent);
  if (!guard.isCurrent()) return;

  const children = new Map<string, string[]>();
  for (const context of sources.spatialNodes)
    if (context.parentKey) {
      const rows = children.get(context.parentKey) ?? [];
      rows.push(context.key);
      children.set(context.parentKey, rows);
    }
  const subtree = new Set<string>(),
    queue = [node.key];
  while (queue.length) {
    const next = queue.pop()!;
    if (subtree.has(next)) continue;
    subtree.add(next);
    for (const child of children.get(next) ?? []) queue.push(child);
  }
  const members = sources.ifcRecords.filter((row) =>
    row.context.some((context) => subtree.has(context)),
  );
  const parent = sources.spatialNodes.find((context) => context.key === node.parentKey);
  await sourceInspectorPresentation().context({
    node,
    parentName: parent?.name,
    childCount: children.get(node.key)?.length ?? 0,
    memberCount: members.length,
    members: members.slice(0, 100).map((member) => ({
      label: member.name,
      choose: () => {
        if (guard.isCurrent())
          void selectEngineeringTarget(state, { kind: 'engineering-source', key: member.id }).catch(
            reportBackgroundError,
          );
      },
    })),
    current: guard.isCurrent,
    onDocument: () => {
      if (guard.isCurrent())
        void inspectEngineeringDocument(state, node.sourcePath).catch(reportBackgroundError);
    },
  });
  if (state.initialized) {
    const [{ getViewerRuntimeWithUI }, { commitSelectionHighlight }] = await Promise.all([
      import('./viewerUIBinding.js'),
      import('../viewer/highlight.js'),
    ]);
    if (guard.isCurrent()) {
      const { ctx } = await getViewerRuntimeWithUI(state, () => {});
      if (guard.isCurrent()) await commitSelectionHighlight(ctx, state, guard);
    }
  }
}
