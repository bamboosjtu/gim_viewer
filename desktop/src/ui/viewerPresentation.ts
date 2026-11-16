import type {ViewerPresentation} from '../services/viewerPresentationPort.js';
import {setupPropsDrawer,showIfcElementProperties,showIfcRegionalProperties} from './propsDrawer.js';
import {addModelToUI,removeModelFromUI} from './modelList.js';
export const viewerPresentation:ViewerPresentation={
  bindProperties:setupPropsDrawer,
  showElement:showIfcElementProperties,
  showRegional:showIfcRegionalProperties,
  addModel:addModelToUI,
  removeModel:removeModelFromUI,
};
