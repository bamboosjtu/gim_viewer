import type { ViewerPresentation } from '../services/presentation/viewerPresentationPort.js';
import {
  openPropsDrawer,
  setupPropsDrawer,
  showIfcElementProperties,
  showIfcRegionalProperties,
} from './propsDrawer.js';
import { addModelToUI, removeModelFromUI } from './modelList.js';
export const viewerPresentation: ViewerPresentation = {
  bindProperties: setupPropsDrawer,
  openProperties: (ctx) => openPropsDrawer(ctx, true),
  showElement: showIfcElementProperties,
  showRegional: showIfcRegionalProperties,
  addModel: addModelToUI,
  removeModel: removeModelFromUI,
};
