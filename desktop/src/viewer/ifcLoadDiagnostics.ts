/**
 * IFC/Fragments load provenance used only by the performance diagnostics.
 *
 * The Fragments `onItemSet` event is emitted outside the call site that starts
 * an IFC or fragment load.  Keep a short-lived runtime-model lookup so the
 * event can be attributed to the correct entry and load source without
 * changing the load order or ownership rules.
 */

export type IfcLoadDiagnosticSource = 'fragments-cache' | 'ifc';

export interface IfcLoadDiagnostic {
  entryPath: string;
  source: IfcLoadDiagnosticSource;
  sessionId: number;
}

const pendingLoads = new Map<string, IfcLoadDiagnostic>();

export function registerIfcLoadDiagnostic(
  runtimeModelId: string,
  diagnostic: IfcLoadDiagnostic,
): void {
  pendingLoads.set(runtimeModelId, { ...diagnostic });
}

export function takeIfcLoadDiagnostic(runtimeModelId: string): IfcLoadDiagnostic | undefined {
  const diagnostic = pendingLoads.get(runtimeModelId);
  pendingLoads.delete(runtimeModelId);
  return diagnostic;
}
