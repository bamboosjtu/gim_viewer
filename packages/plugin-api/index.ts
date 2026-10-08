/** Neutral extension contracts. Business system records belong in the provider. */
export interface PluginMetadata { id: string; name: string; version: string; capabilities: ('read-project' | 'external-data')[] }
export interface ProjectContext { id: string; name: string; sourceSha256: string; towerIds: readonly string[]; lineIds: readonly string[] }
export interface ExternalFeature { id: string; objectId?: string; label: string; coordinate?: [number, number]; properties: Record<string, string> }
export interface ExternalProjectData {
  features: ExternalFeature[];
  badges: { objectId: string; label: string; tone: 'info' | 'warning' }[];
  inspectorSections: { objectId: string; title: string; values: Record<string, string> }[];
  findings: { severity: 'INFO' | 'WARNING' | 'ERROR'; message: string }[];
}
export interface ExternalDataProvider {
  metadata: PluginMetadata;
  matchProject(context: ProjectContext): boolean;
  load(context: ProjectContext, signal: AbortSignal): Promise<ExternalProjectData>;
  dispose(): void | Promise<void>;
}
