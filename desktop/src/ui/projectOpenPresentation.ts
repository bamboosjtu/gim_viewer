import type { ProjectOpenPresentation } from '../services/projectOpenPresentationPort.js';
import { btnLoadGim, btnLoadLocal, gimFileInput, fileInput } from './dom.js';
import { chooseBrowserGimFile, chooseBrowserFiles } from './browserGimChooser.js';
export const projectOpenPresentation: ProjectOpenPresentation = {
  chooseGim: () => chooseBrowserGimFile(gimFileInput),
  chooseIfc: () => chooseBrowserFiles(fileInput),
  setBusy(kind, busy) {
    const button = kind === 'gim' ? btnLoadGim : btnLoadLocal;
    if (button) button.disabled = busy;
  },
  resetInput(kind) {
    const input = kind === 'gim' ? gimFileInput : fileInput;
    if (input) input.value = '';
  },
};
