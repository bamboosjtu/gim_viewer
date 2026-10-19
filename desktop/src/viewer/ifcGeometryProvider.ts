/** Identity of an IFC object; representation ownership is tracked separately. */
export interface IfcPreviewObject {
  key: string;
  modelId: string;
  sourcePath: string;
  expressId: number;
  globalId: string;
  ifcType: string;
  name: string;
  provider: 'ifc-preview';
}
