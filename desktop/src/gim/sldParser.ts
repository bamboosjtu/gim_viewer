/**
 * Desktop DOM adapter for the SLD parser.
 * SVG grammar and sanitization live in `@gim/gim-sdk/parser`; this module only
 * supplies the browser XML parser.
 */
import {
  parseSld as parseSldWithAdapter,
  type SldDocument,
  type XmlParseAdapter,
} from '@gim/gim-sdk/parser';

export type { SldDocument, SldGroup, SldNode, SldUse } from '@gim/gim-sdk/parser';

const parseXml: XmlParseAdapter = (text, mime) =>
  new DOMParser().parseFromString(text, mime as DOMParserSupportedType);

export function parseSld(text: string, sourcePath = ''): SldDocument {
  return parseSldWithAdapter(text, sourcePath, parseXml);
}
