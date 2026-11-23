import type { SourceInspectorPresentation } from '../services/presentation/sourceInspectorPresentationPort.js';
import { escHtml } from '../shared/html.js';
import { openPropsDrawerUI, renderInspectorTabs, sectionHtml } from './propsDrawer.js';
export const sourceInspectorPresentation: SourceInspectorPresentation = {
  error(path, error, current) {
    if (!current()) return;
    openPropsDrawerUI();
    renderInspectorTabs(`<div class="props-header">${escHtml(path)}</div>`, {
      overview: sectionHtml('来源', [
        ['文件', path],
        ['状态', error],
      ]),
      params: '',
      relations: '',
      source: '',
    });
  },
  document({
    path,
    doc,
    isIfc,
    rows,
    references,
    candidates: candidateChoices,
    candidateCount = candidateChoices.length,
    current,
    onDocument,
  }) {
    if (!current()) return;
    openPropsDrawerUI();
    const render = (page = 0, active = 'overview') => {
      if (!current()) return;
      const start = page * 200,
        lines = doc?.rawLines ?? [],
        last = Math.max(0, Math.ceil(lines.length / 200) - 1);
      renderInspectorTabs(
        `<div class="props-header">${escHtml(path.split('/').pop()!)}</div>`,
        {
          overview: sectionHtml('来源文档', rows),
          params: doc
            ? sectionHtml(
                '原始字段',
                doc.fields
                  .filter((field) => (field.line ?? 0) > start && (field.line ?? 0) <= start + 200)
                  .map((field) => [field.keys.join(' / '), field.value]),
              )
            : sectionHtml('来源范围', [
                [
                  '说明',
                  isIfc
                    ? '只展示交付的外露对象与特征，内部类型作为属性和证据按需查看。'
                    : '通过引用关系查看该来源。',
                ],
              ]),
          relations:
            sectionHtml(
              '引用状态',
              references.map((reference) => [
                reference.field,
                `${reference.value} · ${reference.status === 'resolved' ? '已找到' : reference.status === 'ambiguous' ? '存在多个候选' : '未找到'}`,
              ]),
            ) +
            references
              .map((reference, i) =>
                reference.target
                  ? `<button type="button" class="prop-ref-link" data-engineering-document-ref="${i}">${escHtml(reference.target)}</button>`
                  : '',
              )
              .join(''),
          source: doc
            ? `<p class="props-note">原始行 ${start + 1}–${Math.min(start + 200, lines.length)} / ${lines.length}</p><pre>${escHtml(lines.slice(start, start + 200).join('\n'))}</pre>`
            : sectionHtml('来源', [['文件', path]]),
        },
        active,
      );
      const controls = `<div class="props-actions"><button type="button" class="prop-ref-link" data-source-page="${Math.max(0, page - 1)}" ${page === 0 ? 'disabled' : ''}>上一页</button><button type="button" class="prop-ref-link" data-source-page="${Math.min(last, page + 1)}" ${page === last ? 'disabled' : ''}>下一页</button></div>`;
      if (doc && lines.length > 200)
        for (const pane of ['params', 'source'])
          document
            .querySelector(`[data-itab-pane="${pane}"]`)
            ?.insertAdjacentHTML('beforeend', controls);
      const candidates = candidateChoices.slice(0, 100);
      document
        .querySelector('[data-itab-pane="overview"]')
        ?.insertAdjacentHTML(
          'beforeend',
          candidates
            .map(
              (id, i) =>
                `<button class="prop-ref-link" data-source-candidate="${i}">${escHtml(id.label)}</button>`,
            )
            .join(''),
        );
      if (candidateCount > 100)
        document
          .querySelector('[data-itab-pane="overview"]')
          ?.insertAdjacentHTML(
            'beforeend',
            '<p class="props-note">全部实例可在来源视图逐项查看。</p>',
          );
      document
        .querySelectorAll<HTMLElement>('[data-source-page]')
        .forEach((button) =>
          button.addEventListener('click', () =>
            render(
              Number(button.dataset.sourcePage),
              button.closest('[data-itab-pane]')?.getAttribute('data-itab-pane') ?? 'source',
            ),
          ),
        );
      document.querySelectorAll<HTMLElement>('[data-source-candidate]').forEach((button) =>
        button.addEventListener('click', () => {
          if (current()) candidates[Number(button.dataset.sourceCandidate)]?.choose();
        }),
      );
      document.querySelectorAll<HTMLElement>('[data-engineering-document-ref]').forEach((button) =>
        button.addEventListener('click', () => {
          const reference = references[Number(button.dataset.engineeringDocumentRef)];
          if (current() && reference.target) onDocument(reference.target);
        }),
      );
    };
    render();
  },
  context({
    node,
    parentName,
    childCount,
    members,
    memberCount = members.length,
    current,
    onDocument,
  }) {
    if (!current()) return;
    openPropsDrawerUI();
    renderInspectorTabs(`<div class="props-header">${escHtml(node.name)}</div>`, {
      overview: sectionHtml('空间来源', [
        ['浏览对象', 'IFC 交付空间容器'],
        ['类型', node.ifcType],
        ['外露对象与特征（含下级）', String(memberCount)],
      ]),
      params: sectionHtml('原始身份', [
        ['名称', node.name],
        ['GlobalId', node.globalId],
        ['ExpressId', String(node.expressId)],
      ]),
      relations: sectionHtml('来源关系', [
        ['上级容器', parentName ?? '文件根级'],
        ['下级容器', String(childCount)],
      ]),
      source:
        sectionHtml('文件', [['路径', node.sourcePath]]) +
        '<button class="prop-ref-link" id="engineering-context-document">查看交付文件</button>' +
        members
          .slice(0, 100)
          .map(
            (member, index) =>
              `<button class="prop-ref-link" data-context-member="${index}">${escHtml(member.label)}</button>`,
          )
          .join('') +
        (memberCount > 100 ? '<p class="props-note">全部对象可在来源树展开或搜索。</p>' : ''),
    });
    document.getElementById('engineering-context-document')?.addEventListener('click', () => {
      if (current()) onDocument();
    });
    document.querySelectorAll<HTMLElement>('[data-context-member]').forEach((button) =>
      button.addEventListener('click', () => {
        if (current()) members[Number(button.dataset.contextMember)]?.choose();
      }),
    );
  },
};
