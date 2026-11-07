// @vitest-environment node
import { expect, it } from 'vitest';
import { nearestTower, nearestWire } from '../lineMapHitTesting.js';
import type { RuntimeWire } from '../lineMapGeometry.js';
import type { TowerMarker } from '../../gim/lineMapData.js';

it('uses the current projection for tower hits and the drawn sag curve for wire hits', () => {
  const a = { tower: { towerNumber: 'A' } as TowerMarker, x: 10, y: 10 };
  const b = { tower: { towerNumber: 'B' } as TowerMarker, x: 20, y: 10 };
  expect(nearestTower([a,b], row => row, 19, 10, 6)).toBe(b.tower);
  expect(nearestTower([a,b], row => ({ x: row.x + 100, y: row.y }), 19, 10, 6)).toBeNull();

  const wire = { start: { lng: 10, lat: 10 }, end: { lng: 110, lat: 10 },
    useCatenary: true, wire: { wireType: 'CONDUCTOR', spanMeters: 100 } } as RuntimeWire;
  const project = (point: RuntimeWire['start']) => ({ x: point.lng, y: point.lat });
  expect(nearestWire([wire], layer => layer === 'conductor', project, 200, 100, 60, 13, 2)).toBe(wire.wire);
  expect(nearestWire([wire], () => false, project, 200, 100, 60, 13, 2)).toBeNull();
});
