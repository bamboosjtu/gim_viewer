import { it, expect } from 'vitest';
import { buildGimIndexPayload, buildGeometryRefsPayload } from '../gimIndexPersistenceService.js';
import { restoreGimIndexToState } from '../gimIndexRestoreService.js';
import { parseFamSectionsWithDiagnostics } from '../../gim/famParser.js';
import { buildCbmTree } from '../../gim/cbmParser.js';
import { AppState } from '../../app/state.js';
import { sqliteRoundTrip } from './sqliteHarness.js';

it('retains every physical FAM row through production SQLite save/query/restore', async () => {
  const text = '[设计参数]\n材质=Material=铝\n材质=Material=铝\n材质=Material=铜\n空值=Empty=\n[工程属性]\n材质=Material=钢\n[设计参数]\n材质=Material=银\n';
  const files = new Map([
    ['CBM/project.cbm', new File(['ENTITYNAME=F4System\nOBJECTMODELPOINTER=root.dev'], 'project.cbm')],
    ['DEV/root.dev', new File(['BASEFAMILY=raw.fam\nBASEFAMILY1=empty.fam\nSOLIDMODELS.NUM=0'], 'root.dev')],
    ['DEV/raw.fam', new File([text], 'raw.fam')],
    ['DEV/empty.fam', new File([''], 'empty.fam')],
    ['CBM/model.ifc', new File([''], 'model.ifc')],
    ['CBM/later.ifc', new File([''], 'later.ifc')],
  ]);
  const tree = await buildCbmTree(files);
  // Hash-like identities need not sort in original load order. The first IFC
  // establishes the shared coordinate anchor, so SQLite must preserve order.
  const ifcs = [{ modelId: 'z-first', name: 'model', path: 'CBM/model.ifc' },
    { modelId: 'a-second', name: 'later', path: 'CBM/later.ifc' }];
  const index = await buildGimIndexPayload(1, files, ifcs, tree, []);
  const refs = await buildGeometryRefsPayload(1, files);
  const [warm, migrated] = sqliteRoundTrip([{ index, refs },{ index, refs, migrate:true }]);
  expect(migrated.index.fam_properties.map((p) => p.raw_property_json)).toEqual(warm.index.fam_properties.map((p) => p.raw_property_json));
  const state = new AppState();
  restoreGimIndexToState(state, warm.index);
  expect(state.currentIfcEntries).toEqual(ifcs);
  expect(migrated.index.ifc_models.map(m => m.model_id)).toEqual(ifcs.map(m => m.modelId));
  const parsed = parseFamSectionsWithDiagnostics(text, 'DEV/raw.fam');
  expect(state.cachedFamSourceProperties.get('DEV/raw.fam')).toEqual(parsed.properties);
  expect(warm.index.fam_properties.map((p) => p.source_line)).toEqual([2,3,4,5,7,9]);
  expect(state.cachedFamProperties.get('DEV/raw.fam')).toEqual(parsed.sections);
  expect(state.cachedFamProperties.get('DEV/raw.fam')?.get('设计参数')?.get('材质')).toBe('银');
  expect(warm.index.fam_properties.filter((p) => p.prop_value === '铝')).toHaveLength(2);
  expect(warm.index.entries.some((e) => e.entry_path === 'DEV/empty.fam')).toBe(true);
  expect(warm.index.fam_properties.some((p) => p.source_path === 'DEV/empty.fam')).toBe(false);
  expect(state.cachedFamSourceProperties.get('DEV/empty.fam')).toEqual([]);
  expect(warm.version).toBe('gim-substation-parser-v25');
}, 180_000);
