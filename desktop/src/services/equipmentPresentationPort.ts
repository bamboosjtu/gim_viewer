import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';

export interface EquipmentPresentationPort {
  navigation(input: {
    name: string;
    tree: CbmNode;
    onSelect(node: CbmNode): void;
    signal: AbortSignal;
  }): () => void;
  deviceStatus(text: string, detail?: string): void;
}
let create: ((state: AppState) => EquipmentPresentationPort) | undefined;
/** Bound once by the application composition root; the port exposes no UI modules or DOM. */
export function bindEquipmentPresentation(
  factory: (state: AppState) => EquipmentPresentationPort,
): void {
  create = factory;
}
export function equipmentPresentationFor(state: AppState): EquipmentPresentationPort {
  if (!create) throw new Error('Equipment presentation port missing');
  return create(state);
}
