import type { LinePresentation } from '../features/powerline/presentation/linePresentationPort.js';
export const linePresentation: LinePresentation = {
  async present(state, prepare, message, options, current) {
    const view = await import('./lineProjectView.js');
    if (!current()) return;
    const projection = prepare();
    if (!current()) return;
    try {
      return view.renderLineProjectPanels(state, projection, message, options);
    } catch (error) {
      if (current()) view.destroyLineMapView();
      throw error;
    }
  },
};
