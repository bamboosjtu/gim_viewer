import { extractGimHeader, type GimHeaderInfo } from '../gim/gimExtractor.js';

/** Runtime is selected from the source package, never from a cache row. */
export type GimRuntimeType = 'transmission_line' | 'substation';
export type GimSourceKind = GimRuntimeType | 'unknown';
export type GimContentProjectType = GimSourceKind | 'hybrid';

export interface GimSourceIdentity {
  path?: string;
  size?: number;
  modifiedMs?: number;
  sha256?: string | null;
}

export interface GimSourceDescriptor extends GimSourceIdentity {
  fileName: string;
  magic: string;
  header: GimHeaderInfo | null;
  projectId?: string;
  projectName?: string;
  runtimeType: GimSourceKind;
}

/** Map the package magic to the only two supported runtime domains. */
export function runtimeTypeFromMagic(magic: string): GimSourceKind {
  if (magic === 'GIMPKGT') return 'transmission_line';
  if (magic === 'GIMPKGS') return 'substation';
  return 'unknown';
}

/**
 * Resolve the Runtime boundary after content validation.
 * A recognized source magic always wins; hybrid remains a diagnostic state and
 * falls back to the existing Substation Runtime only when magic is unknown.
 */
export function resolveGimRuntimeType(
  sourceType: GimSourceKind,
  contentType: GimContentProjectType,
): GimSourceKind {
  if (sourceType !== 'unknown') return sourceType;
  if (contentType === 'transmission_line') return 'transmission_line';
  if (contentType === 'substation' || contentType === 'hybrid') return 'substation';
  return 'unknown';
}

/** Read the fixed-width magic without requiring an archive signature. */
export function readGimMagic(bytes: Uint8Array): string {
  if (bytes.length < 6) return '';
  const prefix = String.fromCharCode(...bytes.slice(0, 7));
  if (prefix.startsWith('GIMPKGT') || prefix.startsWith('GIMPKGS')) return prefix.slice(0, 7);
  return String.fromCharCode(...bytes.slice(0, 6));
}

function buildDescriptor(
  fileName: string,
  bytes: ArrayBuffer,
  identity: GimSourceIdentity = {},
): GimSourceDescriptor {
  const raw = new Uint8Array(bytes);
  const header = extractGimHeader(bytes);
  const magic = header?.magic || readGimMagic(raw);
  const runtimeType = runtimeTypeFromMagic(magic);
  return {
    ...identity,
    fileName,
    magic,
    header,
    projectId: header?.projectId,
    projectName: header?.projectName,
    runtimeType,
  };
}

/** Inspect a complete browser-side source buffer. */
export function inspectGimSourceBuffer(
  fileName: string,
  bytes: ArrayBuffer,
  identity: GimSourceIdentity = {},
): GimSourceDescriptor {
  return buildDescriptor(fileName, bytes, identity);
}

/**
 * Inspect the bounded source prefix used by the native Tauri path.
 *
 * The current GIM header/archive search is bounded to 1 MiB, so the same
 * prefix is sufficient for project metadata in the normal native path. If a
 * malformed source has no discoverable archive offset, the fixed magic still
 * gives us the routing signal and the content detector remains the fallback.
 */
export function inspectGimSourceHead(
  fileName: string,
  head: ArrayBuffer,
  identity: GimSourceIdentity = {},
): GimSourceDescriptor {
  return buildDescriptor(fileName, head, identity);
}
