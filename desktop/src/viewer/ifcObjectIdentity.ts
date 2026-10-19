/** Identity of an IFC object; representation ownership is tracked separately. */
export interface IfcObjectIdentity {
  key: string;
  modelId: string;
  sourcePath: string;
  expressId: number;
  globalId: string;
  ifcType: string;
  name: string;
  provider: string;
}
