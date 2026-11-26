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
  approximate?: boolean;
  door?: import('./doorMotion.js').DoorMotionDescriptor;
  moveLeaf?: (transform: Matrix4, signal: AbortSignal) => Promise<() => void>;
  load: (signal: AbortSignal) => Promise<PatrolPart[]>;
}
export interface PatrolDirectory {
  sources: PatrolSource[];
  unknown: string[];
}
export type CoverageState = 'complete' | 'estimated' | 'pending' | 'partial' | 'unknown';
export interface NavigationCoverage {
  tileId: string;
  ground: CoverageState;
  obstacles: CoverageState;
  expectedSources: string[];
  estimatedSources: string[];
  processedSources: string[];
  failedSources: string[];
  geometryRevision: string;
  complete: boolean;
}
export interface PatrolPose {
  estimated?: boolean;
  limitedCoverage?: boolean;
  feet: Vector3;
  yaw: number;
  pitch: number;
  sourceId: string;
}
export type StepResult =
  | { feet: Vector3; sourceId: string; estimated?: boolean; limitedCoverage?: boolean }
  | { reason: string };
export interface NavigationQueryPort {
  prepare(point: Vector3, signal: AbortSignal, from?: Vector3): Promise<void>;
  prefetchAhead?(from: Vector3, stride: Vector3, signal: AbortSignal): void;
  step(from: Vector3, to: Vector3): StepResult;
}
