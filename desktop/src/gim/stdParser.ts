/**
 * Desktop DOM adapter for the STD parser.
 * The topology grammar lives in `@gim/gim-sdk/parser`; this module only
 * supplies the browser XML parser.
 */
import {
  parseStd as parseStdWithAdapter,
  type StdDocument,
  type XmlParseAdapter,
} from '@gim/gim-sdk/parser';

export type {
  StdBay,
  StdConductingEquipment,
  StdDocument,
  StdGroup,
  StdNode,
  StdParameter,
  StdSubEquipment,
  StdSubstation,
  StdVoltageLevel,
} from '@gim/gim-sdk/parser';

const parseXml: XmlParseAdapter = (text, mime) =>
  new DOMParser().parseFromString(text, mime as DOMParserSupportedType);

export function parseStd(text: string, sourcePath = ''): StdDocument {
  return parseStdWithAdapter(text, sourcePath, parseXml);
}
