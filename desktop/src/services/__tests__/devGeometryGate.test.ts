import { it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { buildCbmTree } from '../../gim/cbmParser.js';
import { buildGimIndexPayload } from '../gimIndexPersistenceService.js';
import { restoreGimIndexToState } from '../gimIndexRestoreService.js';
import { collectCbmDeviceInstances } from '../modAutoLoadService.js';
import { discoverGeometriesFromDevPath } from '../modGeometryDiscovery.js';
import { parseWorkerXmlMod } from '../../gim/geometry/xmlModWorkerParser.js';
import { loadXmlModFromFiles, applyPlacementTransformToSceneUnits } from '../../viewer/xmlModLoader.js';
import { buildDevSourceBounds } from '../devSpatialCatalog.js';
import { chooseDeviceLod, deviceViewMetrics } from '../../viewer/devLodPolicy.js';
import type { GimIndexResult } from '@desktop/database.js';

it('LOD uses box distance, hysteresis, offscreen selection and a long object crossing the frustum', () => {
  expect(chooseDeviceLod(0, true, 100, 39)).toBe(0);
  expect(chooseDeviceLod(0, true, 100, 40)).toBe(1);
  expect(chooseDeviceLod(1, true, 100, 31)).toBe(1);
  expect(chooseDeviceLod(1, true, 100, 29)).toBe(0);
  expect(chooseDeviceLod(1, true, 29, 120)).toBe(2);
  expect(chooseDeviceLod(2, true, 34, 95)).toBe(2);
  expect(chooseDeviceLod(2, true, 36, 120)).toBe(1);
  expect(chooseDeviceLod(0, false, 1000, 0, true)).toBe(2);
  expect(chooseDeviceLod(2, false, 0, 100)).toBeNull();
  const camera = new THREE.PerspectiveCamera(60, 1, .1, 500);
  const box = new THREE.Box3(new THREE.Vector3(-100, -1, -20), new THREE.Vector3(1, 1, -10));
  const view = deviceViewMetrics(box, camera, 1000, 1000);
  expect(view.visible).toBe(true); expect(view.distance).toBe(10); expect(view.pixels).toBeGreaterThan(120);
});

it.skipIf(process.env.GIM_VERIFY_SUBSTATION01 !== '1')('substation01 core geometry and cold/warm occurrence fingerprint', async () => {
  const root = resolve('../demo/demo-substation'), files = new Map<string, File>();
  const walk = (dir: string, prefix = '') => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name), path = prefix ? `${prefix}/${name}` : name, stat = statSync(full);
      if (stat.isDirectory()) walk(full, path);
      else files.set(path, { name, size: stat.size, text: async () => readFileSync(full, 'utf8'),
        arrayBuffer: async () => new Uint8Array(readFileSync(full)).buffer } as File);
    }
  };
  walk(root); console.log("gate files", files.size);
  const tree = await buildCbmTree(files), cold = new AppState(); cold.currentCbmTree = tree;
  console.log("gate tree");
  const payload = await buildGimIndexPayload(1, files, [], tree, []);
  console.log("gate payload");
  const warm = new AppState();
  restoreGimIndexToState(warm, { ...payload, fam_properties: payload.fam_properties ?? [], dev_properties: payload.dev_properties ?? [] } as unknown as GimIndexResult);
  const shape = (state: AppState) => collectCbmDeviceInstances(state.currentCbmTree).map(n => ({ path: n.path, devPath: n.devPath, matrix: n.transformMatrix }));
  console.log("gate restore");
  expect(shape(warm)).toEqual(shape(cold));
  console.log("gate occurrence");
  const dev = 'DEV/fccd70eb-42de-4987-9a65-1ffb3b040b4e.dev';
  const discovered = await discoverGeometriesFromDevPath(dev, files, new THREE.Matrix4().toArray(), new Set(), 0, { instances: 0 });
  const group = new THREE.Group(), counts: Record<string, number> = {};
  for (const edge of discovered.mods) {
    const doc = parseWorkerXmlMod(await files.get(edge.modPath)!.text(), edge.modPath);
    for (const entity of doc.entities) if (entity.visible) counts[entity.primitive.type] = (counts[entity.primitive.type] ?? 0) + 1;
    const part = await loadXmlModFromFiles(edge.modPath, files, edge.phmColor, edge.phmColorMaxA, { strict: true, parseXml: parseWorkerXmlMod });
    applyPlacementTransformToSceneUnits(part!, edge.placementTransformMatrix); group.add(part!);
  }
  expect(counts).toEqual({ Cuboid: 85, StretchedBody: 111, Cylinder: 282, Ring: 19, TruncatedCone: 6, Sphere: 2, PorcelainBushing: 11, TerminalBlock: 11 });
  const box = new THREE.Box3().setFromObject(group, true), reference = [-4.760, -3.982, -.015, 4.760, 3.982, 7.425512638];
  [...box.min.toArray(), ...box.max.toArray()].forEach((v, i) => expect(Math.abs(v - reference[i])).toBeLessThan(.01));
  const bounds = await buildDevSourceBounds(dev, files, parseWorkerXmlMod);
  expect(bounds.boundsQuality).toBe('conservative');
  expect(bounds.primitiveCounts).toEqual(counts);
  const output = resolve('../output/dev-lod-validation'); mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'geometry-static.json'), JSON.stringify({ primitiveCounts: counts, localBounds: [...box.min.toArray(), ...box.max.toArray()],
    catalog: bounds, occurrenceCount: shape(cold).length, coldWarmOccurrenceEqual: true }, null, 2));
}, 600000);
