import type { LinePresentation } from '../services/linePresentationPort.js';
export const linePresentation: LinePresentation = {
  async present(state, graph, message, options, current) {
    const view = await import('./lineProjectView.js');
    if (current()) return view.renderLineProjectPanels(state, graph, message, options);
  },
};
