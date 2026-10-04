import { describe, expect, it } from 'vitest';
import { parseFileDevRelation } from '../fileDevParser.js';
import { buildCbmTree } from '../cbmParser.js';
import { discoverIfcFromCBM } from '../gimIndexer.js';
import { buildSubstationAliasIndex, buildSubstationIfcEvidence, discoverSubstationGlSidecars, inspectSubstationCapabilities, findSubstationSourceDocuments } from '../substationEvidence.js';
import { hydrateSubstationGeometryGraph } from '../geometry/substationSourceGraph.js';
import { discoverGeometriesFromNode } from '../../services/modGeometryDiscovery.js';
import { parseFamSectionsWithDiagnostics, resolveSubstationBusinessIdentity } from '../famParser.js';
import { buildGimIndexPayload, buildGeometryRefsPayload } from '../../services/gimIndexPersistenceService.js';
import { restoreGimIndexToState } from '../../services/gimIndexRestoreService.js';
import { AppState } from '../../app/state.js';
import { loadXmlModFromText } from '../../viewer/xmlModLoader.js';
import { parseXmlMod } from '../geometry/xmlModParser.js';
import { getNodeDisplayName } from '../../shared/displayName.js';

const identity = '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';
function translate(x: number): string {
  const matrix = identity.split(',');
  matrix[12] = String(x);
  return matrix.join(',');
}
function filesOf(raw: Record<string, string>): Map<string, File> {
  return new Map(Object.entries(raw).map(([path, text]) => [path, {
    name: path, size: new TextEncoder().encode(text).length,
    text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as File]));
}
const xml = (primitive: string) => `<Device><Entities><Entity ID="1" Visible="tRuE">${primitive}</Entity></Entities></Device>`;
const cube = xml('<Cuboid L="100" W="100" H="100"/>');

describe('Substation source evidence and normalized projections', () => {
  it.each(['file-level', 'component-guid', 'hybrid'] as const)('separates IFC discovery and association in %s mode', async (mode) => {
    const files = filesOf({
      'CBM/project.cbm': `ENTITYNAME=F1System\nSUBSYSTEM=device.cbm\n${mode !== 'component-guid' ? 'IFC.NUM=1\nIFC0=model.ifc' : ''}`,
      'CBM/device.cbm': `ENTITYNAME=F4System\n${mode !== 'file-level' ? 'IFCFILE=model.ifc\nIFCGUID=direct-guid' : ''}`,
      'CBM/model.ifc': 'ISO-10303-21;',
    });
    const tree = await buildCbmTree(files);
    const entries = await discoverIfcFromCBM(files);
    expect(entries.map((e) => e.path)).toEqual(['CBM/model.ifc']);
    const summary = await inspectSubstationCapabilities(files, tree, entries);
    expect(summary.ifc.linkMode).toBe(mode);
    const links = buildSubstationIfcEvidence(tree, entries);
    expect(links.filter((l) => l.evidence === 'direct-guid')).toHaveLength(mode === 'file-level' ? 0 : 1);
    expect(links.filter((l) => l.evidence === 'source-file')).toHaveLength(mode === 'component-guid' ? 0 : 1);
    expect(links.filter((l) => l.evidence === 'source-file').every((l) => l.confidence === 'resolved-file' && !l.guid)).toBe(true);
    expect(links.filter((l) => l.evidence === 'direct-guid').every((l) => l.confidence === 'declared-reference')).toBe(true);
    expect(tree!.children[0].ifcGuid).toBe(mode === 'file-level' ? '' : 'direct-guid');
  });

  it('joins reversed PARTINDEX references by DEV identity and retains assembly placement', async () => {
    const files = filesOf({
      'CBM/project.cbm': 'ENTITYNAME=F4System\nOBJECTMODELPOINTER=parent.dev\nSUBDEVICES.NUM=2\nSUBDEVICE0=part-b.cbm\nSUBDEVICE1=part-a.cbm',
      'CBM/part-a.cbm': 'ENTITYNAME=PartIndex\nOBJECTMODELPOINTER=DEV/A.dev',
      'CBM/part-b.cbm': 'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=b.dev\nBASEFAMILYPOINTER=part.fam',
      'CBM/part.fam': '[Properties]\nNAME=Specific part name',
      'DEV/parent.dev': `SUBDEVICES.NUM=2\nSUBDEVICE0=a.dev\nTRANSFORMMATRIX0=${translate(100)}\nSUBDEVICE1=B.dev\nTRANSFORMMATRIX1=${translate(200)}`,
      'DEV/a.dev': 'SOLIDMODELS.NUM=0', 'DEV/b.dev': 'SOLIDMODELS.NUM=0\nSYMBOLNAME=Generic type',
    });
    const tree = await buildCbmTree(files);
    const aliases = buildSubstationAliasIndex(tree);
    expect(aliases.partToChildDev.get('CBM/part-b.cbm')).toBe('b.dev');
    expect(aliases.partToOccurrences.get('CBM/part-b.cbm')?.[0].transformMatrix).toContain('200,0,0,1');
    expect(aliases.partToOccurrences.get('CBM/part-a.cbm')?.[0].transformMatrix).toContain('100,0,0,1');
    expect(tree!.children.filter((n) => n.entityName === 'PARTINDEX')).toHaveLength(2);
    expect(getNodeDisplayName(tree!.children.find((n) => n.path === 'CBM/part-b.cbm')!, new Map())).toBe('Specific part name');
  });

  it('hydrates nested PHM and cycles in cache fallback without assuming cardinality or STL', async () => {
    const files = filesOf({
      'CBM/project.cbm': 'ENTITYNAME=F4System\nOBJECTMODELPOINTER=root.dev',
      'DEV/root.dev': 'SOLIDMODELS.NUM=2\nSOLIDMODEL0=first.phm\nSOLIDMODEL1=other.phm',
      'PHM/first.phm': `SOLIDMODELS.NUM=2\nSOLIDMODEL0=nested.phm\nTRANSFORMMATRIX0=${translate(10)}\nSOLIDMODEL1=missing.phm`,
      'PHM/nested.phm': `SOLIDMODELS.NUM=2\nSOLIDMODEL0=first.phm\nSOLIDMODEL1=leaf.mod\nTRANSFORMMATRIX1=${translate(20)}\nCOLOR1=20,30,40,100`,
      'PHM/other.phm': 'SOLIDMODELS.NUM=0', 'MOD/leaf.mod': cube,
    });
    const hydrated = await hydrateSubstationGeometryGraph(['root.dev'], async (paths) =>
      new Map(paths.filter((p) => files.has(p)).map((p) => [p, files.get(p)!])));
    expect(hydrated.has('MOD/leaf.mod')).toBe(true);
    const tree = await buildCbmTree(files);
    const cold = await discoverGeometriesFromNode(tree!, files);
    const warm = await discoverGeometriesFromNode(tree!, hydrated);
    expect(warm).toEqual(cold);
    expect(warm.mods).toHaveLength(1);
    expect(warm.mods[0].placementTransformMatrix[12]).toBe(30);
    expect(warm.mods[0].phmColor).toEqual({ r: 20, g: 30, b: 40, a: 100 });
    const summary = await inspectSubstationCapabilities(files, tree, []);
    expect(summary.geometry).toMatchObject({ dev: 1, phm: 3, mod: 1, stl: 0, nestedPhm: true });
    expect(summary.logicalModel).toBe('absent');
    const refs = await buildGeometryRefsPayload(1, files);
    expect(refs.phm_solid_models.some((edge) => edge.solid_model_path === 'nested.phm')).toBe(true);
  });

  it('discovers UUID GL sidecars separately from explicit geometry references', async () => {
    const uuid = '12345678-1234-1234-1234-123456789abc';
    const files = filesOf({
      'CBM/project.cbm': `ENTITYNAME=F4System\nOBJECTMODELPOINTER=${uuid}.dev`,
      [`DEV/${uuid}.dev`]: 'SOLIDMODELS.NUM=0',
      [`MOD/${uuid.toUpperCase()}.gl`]: xml('<GimGeCableConcentration ConnectGuid="unknown"/>'),
      'MOD/unrelated.gl': cube,
    });
    const tree = await buildCbmTree(files);
    const sidecars = discoverSubstationGlSidecars(files.keys(), tree);
    expect(sidecars).toHaveLength(1);
    expect(sidecars[0].semanticPaths).toEqual(['CBM/project.cbm']);
    expect(await discoverGeometriesFromNode(tree!, files)).toEqual({ mods: [], stls: [] });
    expect((await inspectSubstationCapabilities(files, tree, [])).geometry.glSidecars).toBe(1);
  });

  it('preserves FAM provenance and candidate identities through cold/persist/warm paths', async () => {
    const files = filesOf({
      'CBM/project.cbm': 'ENTITYNAME=F2System\nSYSCLASSIFYNAME=U\nSYSTEMNAME1=NULL1\nBASEFAMILYPOINTER=name.fam\nBASEFAMILY2=ids.fam',
      'CBM/name.fam': '[设计参数]\nNAME=主变区域',
      'CBM/ids.fam': '[工程属性]\n设备编码=deviceCode=ABC\n=实物ID=physical-id',
    });
    const tree = await buildCbmTree(files);
    expect(tree!.name).toBe('主变区域');
    expect(tree!.classifyName).toBe('U');
    const payload = await buildGimIndexPayload(1, files, [], tree, []);
    expect(payload.fam_properties).toHaveLength(3);
    const state = new AppState();
    restoreGimIndexToState(state, {
      ...payload, entries: payload.entries, cbm_nodes: payload.cbm_nodes, ifc_models: [],
      file_dev_entries: [], dev_properties: [], fam_properties: payload.fam_properties,
    } as unknown as Parameters<typeof restoreGimIndexToState>[1]);
    expect(state.currentCbmTree?.rawProperties).toEqual(tree?.rawProperties);
    const properties = [...state.cachedFamSourceProperties.values()].flat();
    expect(properties.find((p) => p.label === '设备编码')).toMatchObject({
      sourcePath: 'CBM/ids.fam', rawKey: 'deviceCode', rawValue: 'ABC', rawLine: '设备编码=deviceCode=ABC',
    });
    expect(resolveSubstationBusinessIdentity(properties)).toMatchObject({ value: 'ABC', kind: '设备编码', source: { key: 'deviceCode', path: 'CBM/ids.fam' } });
    expect(state.substationCapabilities?.familyRefs).toMatchObject({ baseFamilyPointer: true, indexedBaseFamilies: true });
  });

  it('retains source documents and IFC-only relation rows independently through cache restore', async () => {
    const files = filesOf({
      'CBM/project.cbm': 'ENTITYNAME=F4System\nSYSTEMNAME5=Actual readable system',
      'CBM/FileDevRelation.cbm': 'FILES.NUM=2\nFILE0.NAME=design.DGN\nFILE0.DEVS.NUM=1\nFILE0.DEV0=project.cbm\nFILE1.NAME=model\nFILE1.IFC=model.ifc',
      'CBM/model.ifc': 'ISO-10303-21;',
    });
    const tree = await buildCbmTree(files);
    expect(tree!.systemNames).toEqual(['Actual readable system']);
    const relations = await parseFileDevRelation(files);
    expect(relations[0]).toMatchObject({ sourceDesignFile: 'design.DGN', ifcFile: '', modelId: '' });
    const entries = await discoverIfcFromCBM(files);
    const payload = await buildGimIndexPayload(1, files, entries, tree, relations);
    expect(payload.file_dev_entries).toHaveLength(2);
    const state = new AppState();
    restoreGimIndexToState(state, payload as unknown as Parameters<typeof restoreGimIndexToState>[1]);
    expect(state.fileDevRelations).toEqual(relations);
    expect(findSubstationSourceDocuments(state.currentCbmTree!, state.currentCbmTree, state.fileDevRelations)).toEqual(['design.DGN']);
    expect(state.currentCbmTree?.ifcGuid).toBe('');
  });

  it('accepts empty FAM and optional logical-model placeholders', async () => {
    expect(parseFamSectionsWithDiagnostics('\r\n').properties).toEqual([]);
    expect(resolveSubstationBusinessIdentity([])).toBeNull();
    const files = filesOf({ 'CBM/project.cbm': 'ENTITYNAME=LOGICALMODEL\nLOGICALMODELS.NUM=0' });
    expect((await inspectSubstationCapabilities(files, await buildCbmTree(files), [])).logicalModel).toBe('placeholder');
  });

  it('keeps actual SYSTEMNAME and restores DEV metadata; accepts custom readable FAM fields', async () => {
    const files = filesOf({
      'CBM/project.cbm': 'ENTITYNAME=F4System\nSYSTEMNAME1=Actual device name\nOBJECTMODELPOINTER=root.dev\nSUBSYSTEM=custom.cbm',
      'CBM/custom.cbm': 'ENTITYNAME=F3System\nBASEFAMILYPOINTER=custom.fam',
      'CBM/custom.fam': '[Custom properties]\nShowName=Actual system',
      'DEV/root.dev': 'SYMBOLNAME=Generic type\nTYPE=OTHERS\nSOLIDMODELS.NUM=0',
    });
    const tree = await buildCbmTree(files);
    expect(tree!.name).toBe('Actual device name');
    expect(getNodeDisplayName(tree!, new Map())).toBe('Actual device name');
    expect(getNodeDisplayName({ ...tree!, rawProperties: undefined, systemNames: [] }, new Map())).toBe('Generic type');
    expect(tree!.children[0].name).toBe('Actual system');
    const payload = await buildGimIndexPayload(1, files, [], tree, []);
    const state = new AppState();
    restoreGimIndexToState(state, payload as unknown as Parameters<typeof restoreGimIndexToState>[1]);
    expect(state.currentCbmTree).toMatchObject({ name: tree!.name, systemNames: tree!.systemNames, devSymbolName: 'Generic type', devType: 'OTHERS' });
    expect(getNodeDisplayName(state.currentCbmTree!, new Map())).toBe('Actual device name');
  });

  it.each(['Insulator', 'ConePorcelainBushing', 'SquareGasket', 'CircularFixedPlate', 'BendingCylindrical', 'GimGeCableConcentration', 'FuturePrimitive'])('retains unknown %s without losing sibling geometry', (type) => {
    const text = `<Device><Entities><Entity ID="1" Visible="TRUE"><${type} FutureAttr="value"/></Entity><Entity ID="2" Visible="True"><Cuboid L="10" W="10" H="10"/></Entity></Entities></Device>`;
    const doc = parseXmlMod(text, 'MOD/mixed.mod');
    expect(doc.entities[0].primitive).toMatchObject({ type: 'Unsupported', sourceType: type, raw: { FutureAttr: 'value' } });
    expect(doc.entities[0].visible).toBe(true);
    expect(loadXmlModFromText(text, 'MOD/mixed.mod').children).toHaveLength(1);
  });

  it('rejects unknown Boolean operation as unsupported instead of evaluating subtraction', () => {
    const doc = parseXmlMod(xml('<Boolean Type="xor" Entity1="1" Entity2="2"/>'), 'MOD/boolean.mod');
    expect(doc.entities[0].primitive).toEqual({ type: 'Unsupported', sourceType: 'Boolean', raw: { Type: 'xor', Entity1: '1', Entity2: '2' } });
    expect(loadXmlModFromText(xml('<Boolean Type="xor" Entity1="1" Entity2="2"/>'), 'MOD/boolean.mod').children).toHaveLength(0);
  });
});
