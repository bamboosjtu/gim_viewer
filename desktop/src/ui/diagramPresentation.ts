import type { DiagramPresentation } from '../services/diagramPresentationPort.js';
let active: object | undefined;
export const diagramPresentation: DiagramPresentation = {
  async render(state, current) {
    const view = await import('./sldView.js');
    if (current()) view.renderSldView(state);
  },
  async onSelect(select, current) {
    const view = await import('./sldView.js');
    if (!current()) return () => {};
    const owned = {};
    active = owned;
    view.setSldGridIdClickHandler(select);
    return () => {
      if (active === owned) {
        active = undefined;
        view.setSldGridIdClickHandler(null);
      }
    };
  },
};
