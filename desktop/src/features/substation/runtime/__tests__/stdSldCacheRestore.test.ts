import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../../../../app/state.js';
import { commitStdSldResult, type StdSldParseResult } from '../../../../services/stdSldService.js';
import { buildAndCommitSubstationStdSld } from '../substationDocumentRuntime.js';
import { bindDiagramPresentation } from '../../../../services/diagramPresentationPort.js';
import { buildCbmTree } from '../../../../gim/cbmParser.js';
import { perfCurrentSession } from '../../../../utils/perfTimings.js';

const { batchRead } = vi.hoisted(() => ({ batchRead: vi.fn() }));
vi.mock('../../../../infrastructure/native/projectFiles.js', () => ({ batchReadCachedFiles: batchRead }));

function result(overrides: Partial<StdSldParseResult> = {}): StdSldParseResult {
  return {
    schEntries: [
      { index: 0, filename: 'zjx.std', path: 'CBM/zjx.std', type: 'std', name: 'zjx' },
      { index: 1, filename: 'zjx.sld', path: 'CBM/zjx.sld', type: 'sld', name: 'zjx' },
    ],
    stdDoc: { substation: {} } as StdSldParseResult['stdDoc'],
    sldDoc: {
      safeSvgOuterHTML: '<svg/>',
      groups: [{}],
    } as StdSldParseResult['sldDoc'],
    index: {} as StdSldParseResult['index'],
    ...overrides,
  } as StdSldParseResult;
}

describe('STD/SLD cold and warm publication', () => {
  it.each([
    ['empty', '<STD/>'],
    ['unsupported', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['failed', '<STD>'],
    [null, null],
  ])('publishes the valid SLD when the accompanying STD is %s', async (status, stdText) => {
    const sldText =
      '<svg xmlns="http://www.w3.org/2000/svg"><g gridId="bay"><circle r="1"/></g></svg>';
    const files = new Map([
      ['Cbm/project.cbm', new File(['SCH=Diagrams/entry.sch'], 'project.cbm')],
      [
        'Diagrams/entry.sch',
        new File(['SCH.NUM=2\nSCH0=topology.std\nSCH1=main.sld'], 'entry.sch'),
      ],
      ['Diagrams/main.sld', new File([sldText], 'main.sld')],
    ]);
    const documents = new Map([['Diagrams/main.sld', new TextEncoder().encode(sldText)]]);
    if (stdText !== null) {
      files.set('Diagrams/topology.std', new File([stdText], 'topology.std'));
      documents.set('Diagrams/topology.std', new TextEncoder().encode(stdText));
    }
    batchRead.mockReset().mockResolvedValue(documents);
    bindDiagramPresentation({
      render: vi.fn().mockResolvedValue(undefined),
      onSelect: vi.fn().mockResolvedValue(() => {}),
    });
    const state = new AppState();
    state.currentProjectId = 42;
    state.currentCbmTree = await buildCbmTree(files);
    const session = state.captureProjectSession();
    const open = (mode: 'cold' | 'warm') =>
      buildAndCommitSubstationStdSld(state, files, session, perfCurrentSession(), vi.fn(), mode);

    expect(await open('cold')).toBe(true);
    const coldSld = state.currentSldDoc;
    expect(coldSld?.gridIdIndex.has('bay')).toBe(true);
    expect(await open('warm')).toBe(true);
    expect(state.currentStdDoc?.status ?? null).toBe(status);
    expect(state.currentSldDoc).toEqual(coldSld);
    expect(batchRead).toHaveBeenCalledWith(42, [
      ...(stdText !== null ? ['Diagrams/topology.std'] : []),
      'Diagrams/main.sld',
    ]);
  });
});

describe('commitStdSldResult', () => {
  it('只做同步提交，null 结果会清空三项文档状态', () => {
    const state = new AppState();
    const parsed = result();

    commitStdSldResult(state, parsed);
    expect(state.currentStdDoc).toBe(parsed.stdDoc);
    expect(state.currentSldDoc).toBe(parsed.sldDoc);
    expect(state.currentStdSldIndex).toBe(parsed.index);

    commitStdSldResult(state, null);
    expect(state.currentStdDoc).toBeNull();
    expect(state.currentSldDoc).toBeNull();
    expect(state.currentStdSldIndex).toBeNull();
  });
});
