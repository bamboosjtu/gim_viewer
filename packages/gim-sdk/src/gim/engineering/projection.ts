/** Read-only projections of established semantic facts and source evidence. */
export {
  projectEngineeringNavigation,
  ENGINEERING_NAVIGATION_VERSION,
} from "./navigation.js";
export type {
  EngineeringNavigationData,
  EngineeringSourceNode,
} from "./navigation.js";
export { engineeringQuery, EngineeringQuery } from "../../engineering/query.js";
export type {
  SemanticTree,
  SemanticTreeNode,
} from "../../engineering/query.js";

export {
  catalogLocation,
  componentDefinition,
  ENGINEERING_CATALOG_VERSION,
  ENGINEERING_CATEGORIES,
  ENGINEERING_CATEGORY_LABELS,
  categoryLabel,
  recognitionCategory,
  classificationReasonLabel,
  MODEL_CATALOG_CATEGORIES,
  directoryDefinition,
  COMPONENT_CATALOG,
  componentLabel,
  catalogPathLabel,
} from "../../engineering/catalogLabels.js";

export {
  projectEngineeringComposition,
  finalizeEngineeringComposition,
  type CompositionGroup,
  type CompositionAssignment,
  type CompositionDeclaration,
  type CompositionNode,
  type EngineeringComposition,
  ENGINEERING_COMPOSITION_VERSION,
} from "../../engineering/composition.js";

export {
  supportTitle,
  canonicalBuildingName,
  isRoomBuildingName,
  isStandaloneBuildingName,
  buildingPaths,
  assignEngineeringComposition,
  declaredEngineeringComposition,
  type CompositionContextEvidence,
} from "../../engineering/compositionTemplate.js";

export {
  inventoryNameTemplate,
  projectInventoryTemplate,
  INVENTORY_TEMPLATE_VERSION,
  INVENTORY_TEMPLATE,
  type InventoryNode,
  type EngineeringInventory,
} from "../../engineering/inventoryTemplate.js";

export * from "./compositionContexts.js";

export * from "./sourceProjection.js";
