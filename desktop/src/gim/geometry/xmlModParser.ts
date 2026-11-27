/**
 * Desktop DOM adapter for the substation XML MOD parser.
 *
 * The format grammar lives in `@gim/gim-sdk/parser`; this module only adapts
 * the platform DOM and keeps the existing desktop export surface.
 */
import { parseXmlModRoot, type MatrixLayout, type XmlModNode } from '@gim/gim-sdk/parser';
import { invalidXml, projectXmlMod, type XmlModDocument } from './xmlModDocument.js';

export type { XmlModDocument } from './xmlModDocument.js';
export type { XmlModNode } from '@gim/gim-sdk/parser';
export { parseXmlModRoot } from '@gim/gim-sdk/parser';

export function readDomXmlMod(text: string, modPath: string, matrixLayout: MatrixLayout) {
  if (/<!DOCTYPE\b/i.test(text)) throw invalidXml(modPath, 'DOCTYPE is not supported');
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const errorNode = doc.querySelector('parsererror');
  if (errorNode) {
    throw invalidXml(modPath, errorNode.textContent?.slice(0, 200) ?? '');
  }
  return parseXmlModRoot(toXmlModNode(doc.documentElement), { sourcePath: modPath, matrixLayout });
}

export function parseXmlMod(text: string, modPath: string): XmlModDocument {
  return projectXmlMod(readDomXmlMod(text, modPath, 'project-column-major'));
}

function toXmlModNode(node: Element): XmlModNode {
  return {
    tagName: node.tagName,
    attrs: Object.fromEntries(Array.from(node.attributes, (a) => [a.name, a.value])),
    children: Array.from(node.children, toXmlModNode),
  };
}
