/** IFC resource/type definitions stay accessible through their product's
 * attributes, but are never outward physical product occurrences. */
export function isIfcInternalDefinitionType(type:string):boolean {
  return /(?:TYPE|STYLE|PROPERTIES|PROFILEDEF)$|^IFC(?:MATERIAL|PROPERTY|QUANTITY|SHAPE|REPRESENTATION|BOOLEAN|CARTESIAN|DIRECTION|LOCALPLACEMENT|AXIS[12]PLACEMENT|PROFILE|EXTRUDED|REL)/.test(type.toUpperCase());
}
