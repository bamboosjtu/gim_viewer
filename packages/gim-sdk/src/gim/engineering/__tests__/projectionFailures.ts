import {vi} from 'vitest';
import * as composition from '../../../engineering/composition.js';
import * as source from '../sourceProjection.js';
import * as inventory from '../inventory.js';

/** Inject one stage failure in the actual SDK navigation pipeline. */
export function failNextProjection(stage: 'composition' | 'source' | 'inventory' | 'inventory-search') {
  const fail = () => { throw Error('projection failure'); };
  switch (stage) {
    case 'composition': return vi.spyOn(composition, 'projectEngineeringComposition').mockImplementationOnce(fail);
    case 'source': return vi.spyOn(source, 'projectEngineeringSource').mockImplementationOnce(fail);
    case 'inventory': return vi.spyOn(inventory, 'projectEngineeringInventory').mockImplementationOnce(fail);
    case 'inventory-search': return vi.spyOn(inventory, 'projectInventorySearch').mockImplementationOnce(fail);
  }
}
