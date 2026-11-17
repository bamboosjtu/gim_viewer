import type { FamSourceProperty } from '../gim/famParser.js';
import type { LineFamPropertyRecord, LineDevPropertyRecord } from '@desktop/database.js';
export class ProjectPropertyCache {
  cachedFamSourceProperties = new Map<string, FamSourceProperty[]>();
  cachedIfcPaths = new Map<string, string>();
  cachedFamProperties = new Map<string, Map<string, Map<string, string>>>();
  cachedDevProperties = new Map<string, Record<string, string>>();
  cachedLineFamProperties = new Map<string, Map<string, LineFamPropertyRecord[]>>();
  cachedLineFamDisplayKeys = new Map<string, Map<string, string | null>>();
  cachedLineDevProperties = new Map<string, Map<string, LineDevPropertyRecord[]>>();
  reset(): void {
    this.cachedFamSourceProperties.clear();
    this.cachedIfcPaths.clear();
    this.cachedFamProperties.clear();
    this.cachedDevProperties.clear();
    this.cachedLineFamProperties.clear();
    this.cachedLineFamDisplayKeys.clear();
    this.cachedLineDevProperties.clear();
  }
}
