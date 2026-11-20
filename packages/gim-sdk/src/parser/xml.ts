import type { ParseDiagnostic, ParseStatus } from "./types.js";

/**
 * Host XML adapter contract for DOM-based formats (STD/SLD).
 *
 * The parser layer owns the document grammar but must not import DOMParser or
 * DOM globals. A host supplies a minimal, read-mostly XML element adapter;
 * the browser/desktop adapter is the only place that creates DOM nodes.
 */

export interface XmlAttribute {
  name: string;
  value: string;
}

export interface XmlElement {
  tagName: string;
  textContent: string | null;
  outerHTML: string;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  remove(): void;
  readonly attributes: ArrayLike<XmlAttribute>;
  readonly children: ArrayLike<XmlElement>;
  querySelector(selector: string): XmlElement | null;
  querySelectorAll(selector: string): ArrayLike<XmlElement>;
}

export interface XmlDocument {
  documentElement: XmlElement;
  querySelector(selector: string): XmlElement | null;
}

export type XmlParseAdapter = (text: string, mime: string) => XmlDocument;

export interface DocumentParseInfo {
  status: ParseStatus;
  diagnostics: readonly ParseDiagnostic[];
}
