/**
 * Source-facing FAM compatibility entry.
 *
 * The physical FAM parser now lives in `../parser/fam.ts`. This module keeps
 * the established source export surface and deliberately retains only the
 * source-layer business-identity interpretation next to it.
 */
export {
  parseFamDocument,
  parseFamSections,
  parseFamSectionsWithDiagnostics,
  type FamDocument,
  type FamParseDiagnostics,
  type FamSourceProperty,
} from "../parser/fam.js";
export { resolveSubstationBusinessIdentity } from "./famBusinessIdentity.js";
