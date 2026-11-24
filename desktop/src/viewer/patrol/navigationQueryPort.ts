import type { Box3, Matrix4, Vector3 } from 'three';

export const patrolProfile = Object.freeze({
  version: 1,
  eyeHeight: 1.68,
  height: 1.78,
  radius: 0.27,
  stepUp: 0.3,
  stepDown: 0.3,
  maxSlopeDegrees: 38,
  walk: 1.45,
  fast: 2.8,
});
import type { PatrolPart } from '../../shared/patrolSpatialAsset.js';
export type { PatrolPart } from '../../shared/patrolSpatialAsset.js';
export interface PatrolSource {
  id: string;
  assetKey: string;
  bounds: Box3;
  matrix: Matrix4;
  support: boolean;
  estimatedSteelSections?: number;
  door?: import('./doorMotion.js').DoorMotionDescriptor;
  moveLeaf?: (transform: Matrix4, signal: AbortSignal) => Promise<() => void>;
  load: (signal: AbortSignal) => Promise<PatrolPart[]>;
}
export interface PatrolDirectory {
  sources: PatrolSource[];
  unknown: string[];
}
export interface NavigationCoverage {
  tileId: string;
  ground: 'complete' | 'pending' | 'partial' | 'unknown';
  obstacles: 'complete' | 'pending' | 'partial' | 'unknown';
  expectedSources: string[];
  processedSources: string[];
  failedSources: string[];
  geometryRevision: string;
  complete: boolean;
}
export type StepResult = { feet: Vector3; sourceId: string } | { reason: string };
export interface NavigationQueryPort {
  prepare(point: Vector3, signal: AbortSignal): Promise<void>;
  step(from: Vector3, to: Vector3): StepResult;
}
