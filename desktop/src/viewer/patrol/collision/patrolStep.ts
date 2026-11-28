import { Box3, Vector3 } from 'three';
import { patrolProfile as profile, type StepResult } from '../navigationQueryPort.js';
import {
  bodyHits,
  supportedInterval,
  supportHeight,
  visitTriangles,
  type PlacedAsset,
} from './patrolGeometry.js';
import { TreadContacts } from './treadContacts.js';

export function solvePatrolStep(
  rows: ReadonlyMap<string, PlacedAsset>,
  box: Box3,
  from: Vector3,
  to: Vector3,
): StepResult {
  let floor = -Infinity,
    sourceId = '';
  let footprintFloor = -Infinity,
    footprintSource = '';
  const intervals: [number, number][] = [];
  const treads = new Map<string, TreadContacts>();
  const evidenceBox = box.clone().expandByVector(new Vector3(profile.radius, profile.radius, 0));
  for (const row of rows.values()) {
    if (!row.support) continue;
    const contacts = new TreadContacts();
    treads.set(row.id, contacts);
    visitTriangles(row, evidenceBox, (t, index) => {
      const interval = supportedInterval(t, from, to);
      if (interval) intervals.push(interval);
      const height = supportHeight(t, to);
      contacts.observe(t, index, !!interval || height !== undefined, from, to);
      if (height !== undefined && height > floor) {
        floor = height;
        sourceId = row.id;
      }
      return false;
    });
    contacts.connect();
    if (contacts.targetFloor > footprintFloor) {
      footprintFloor = contacts.targetFloor;
      footprintSource = row.id;
    }
  }
  if (!sourceId) return { reason: '无连续落脚面' };
  intervals.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  for (const [start, end] of intervals) {
    if (start > covered + 1e-8) break;
    covered = Math.max(covered, end);
  }
  if (covered < 1 - 1e-8) return { reason: '无连续落脚面' };
  const testBody = (feet: Vector3) => {
    for (const row of rows.values()) {
      const tread = treads.get(row.id);
      let overhead = false;
      let contactNormal: Vector3 | undefined;
      if (
        visitTriangles(row, box, (t, index) => {
          if (tread?.faces.has(index) || !bodyHits(t, from, feet) || tread?.allowsContact(t))
            return false;
          contactNormal = t.getNormal(new Vector3());
          overhead =
            Math.min(t.a.z, t.b.z, t.c.z) >=
            Math.max(from.z, feet.z) + profile.eyeHeight - profile.radius;
          return true;
        })
      )
        return { reason: overhead ? '头顶净空不足' : '前方受阻', blockerId: row.id, contactNormal };
    }
    return undefined;
  };
  const feet = to.clone().setZ(floor),
    blocked = testBody(feet);
  if (!blocked) return { feet, sourceId };
  // A premature lift can hit the underside of the next landing. Prefer the centre-supported route.
  // Only retry a reached tread of the obstructing support, sweeping the full capsule again.
  if (footprintFloor > floor && blocked.blockerId === footprintSource) {
    const lifted = to.clone().setZ(footprintFloor);
    if (!testBody(lifted)) return { feet: lifted, sourceId: footprintSource };
  }
  return blocked;
}
