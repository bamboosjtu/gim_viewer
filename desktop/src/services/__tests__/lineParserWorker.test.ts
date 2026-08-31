import { describe, expect, it } from 'vitest';
import { parseLineInWorker } from '../lineParserWorkerClient.js';
import { buildLineGimGraphFromTexts } from '../../gim/lineCbmParserCore.js';
import { createLineParserCache, parseLineAttributesFromCache } from '../../gim/lineAttrParserCore.js';
import type { LineParserWorkerFile } from '../lineParserWorker.js';

const SESSION = { generation: 1, projectId: 11, sourceSha256: 'fixture-sha', geometryToken: 1 };

function textFile(path: string, text: string): LineParserWorkerFile {
  return { path, bytes: new TextEncoder().encode(text).buffer };
}

function fixtureFiles(): LineParserWorkerFile[] {
  return [
    textFile('CBM/project.cbm', 'SUBSYSTEM=F1.CBM\n'),
    textFile('cbm/F1.cbm', 'ENTITYNAME=F1System\nSECTIONS.NUM=1\nSECTION0=F2.cbm\n'),
    textFile('CBM/F2.CBM', 'ENTITYNAME=F2System\nSTRAINSECTIONS.NUM=1\nSTRAINSECTION0=F3.cbm\n'),
    textFile('Cbm/F3.cbm', 'ENTITYNAME=F3System\nGROUPS.NUM=1\nGROUP0=F4.cbm\n'),
    textFile('CBM/F4.cbm', 'ENTITYNAME=F4System\nTOWERS.NUM=1\nTOWER0=TOWER01.CBM\n'),
    textFile('cbm/Tower01.cbm', 'ENTITYNAME=Tower_Device\nBASEFAMILY=Tower.fam\nOBJECTMODELPOINTER=Tower.dev\n'),
    textFile('FAM/Tower.fam', '塔型=TYPE=耐张塔\n呼高=HEIGHT=30\n转角=ANGLE=12.5\n'),
    textFile('DEV/Tower.dev', 'SYMBOLNAME=Tower\n'),
  ];
}

describe('Line Parser Worker v1', () => {
  it('同步回退与共享 cache 产出图和属性', async () => {
    const files = fixtureFiles();
    const result = await parseLineInWorker(files, SESSION);
    expect(result.timings.worker).toBe(false);
    expect(result.graph.root?.children[0]?.entityName).toBe('F1System');
    expect(result.graph.stats.Tower_Device).toBe(1);
    expect(result.attributes.famPayloads.map((item) => item.prop_key)).toEqual(['TYPE', 'HEIGHT', 'ANGLE']);
    expect(result.attributes.devPayloads).toHaveLength(1);
  });

  it('同一文本 cache 解析结果与核心函数一致，并兼容路径大小写', () => {
    const bytes = fixtureFiles();
    const textFiles = bytes.map((file) => ({ path: file.path, text: new TextDecoder().decode(file.bytes) }));
    const cache = createLineParserCache(textFiles);
    const graph = buildLineGimGraphFromTexts(textFiles, cache);
    const attrs = parseLineAttributesFromCache(graph, cache);
    expect(graph.root?.children[0]?.children[0]?.children[0]?.children[0]?.children[0]?.entityName).toBe('Tower_Device');
    expect(attrs.unmatchedRefs).toEqual([]);
    expect(cache.resolveOriginalPath('fam/tower.FAM')).toBe('FAM/Tower.fam');
  });
});
