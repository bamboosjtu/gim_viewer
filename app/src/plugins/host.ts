import type { ExternalDataProvider, ExternalProjectData, ProjectContext } from '@gim/plugin-api';
/** Host owns lifecycle and cancellation; providers never receive map or database handles. */
export class PluginHost {
  private providers = new Map<string, ExternalDataProvider>();
  private controller?: AbortController;
  register(provider: ExternalDataProvider) { if (this.providers.has(provider.metadata.id)) throw new Error('插件 ID 重复'); this.providers.set(provider.metadata.id, provider); }
  async load(context: ProjectContext): Promise<ExternalProjectData[]> {
    this.controller?.abort(); const controller = new AbortController(); this.controller = controller;
    const data = await Promise.all([...this.providers.values()].filter(p => p.matchProject(context) && p.metadata.capabilities.includes('external-data')).map(p => p.load(context, controller.signal)));
    return controller.signal.aborted ? [] : data;
  }
  async dispose() { this.controller?.abort(); await Promise.all([...this.providers.values()].map(p => p.dispose())); this.providers.clear(); }
}
