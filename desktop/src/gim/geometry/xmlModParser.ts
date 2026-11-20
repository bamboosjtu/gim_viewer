/**
 * Desktop DOM adapter for the substation XML MOD parser.
 *
 * The format grammar lives in `@gim/gim-sdk/parser`; this module only adapts
 * the platform DOM and keeps the existing desktop export surface.
 */
import { parseXmlModRoot, type XmlModDocument, type XmlModNode } from '@gim/gim-sdk/parser';
import { mapXmlModPrimitive } from './xmlModPrimitiveAdapter.js';

export type { XmlModDocument, XmlModNode } from '@gim/gim-sdk/parser';
export { parseXmlModRoot } from '@gim/gim-sdk/parser';

export function parseXmlMod(text: string, modPath: string): XmlModDocument {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const errorNode = doc.querySelector('parsererror');
  if (errorNode) {
    throw new Error(`XML parse error in ${modPath}: ${errorNode.textContent?.slice(0, 200) ?? ''}`);
  }
  return parseXmlModRoot(toXmlModNode(doc.documentElement), modPath, mapXmlModPrimitive);
}

function toXmlModNode(node: Element): XmlModNode {
  return {
    tagName: node.tagName,
    attrs: Object.fromEntries(Array.from(node.attributes, (a) => [a.name, a.value])),
    children: Array.from(node.children, toXmlModNode),
  };
}
