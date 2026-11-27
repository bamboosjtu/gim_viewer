import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { parseXmlModRoot, type MatrixLayout, type XmlModNode } from '@gim/gim-sdk/parser';
import { invalidXml, projectXmlMod } from './xmlModDocument.js';

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  processEntities: true,
  ignoreDeclaration: true,
});

function nodes(rows: Array<Record<string, unknown>>): XmlModNode[] {
  return rows.flatMap((row) => {
    const tagName = Object.keys(row).find(
      (key) => key !== ':@' && !key.startsWith('#') && !key.startsWith('?'),
    );
    if (!tagName) return [];
    return [
      {
        tagName,
        attrs: (row[':@'] ?? {}) as Record<string, string>,
        children: nodes((row[tagName] ?? []) as Array<Record<string, unknown>>),
      },
    ];
  });
}

/** No DOM or UI globals; external entity declarations are not accepted. */
export function readWorkerXmlMod(
  text: string,
  path: string,
  matrixLayout: MatrixLayout,
  timings?: Record<string, number>,
) {
  if (/<!DOCTYPE\b/i.test(text)) throw invalidXml(path, 'DOCTYPE is not supported');
  const validationStarted = performance.now();
  const valid = XMLValidator.validate(text);
  if (timings)
    timings.validateMs = (timings.validateMs ?? 0) + performance.now() - validationStarted;
  if (valid !== true) throw invalidXml(path, valid.err.msg);
  const parseStarted = performance.now();
  const roots = nodes(parser.parse(text) as Array<Record<string, unknown>>);
  if (roots.length !== 1) throw invalidXml(path, 'Expected one XML root');
  const doc = parseXmlModRoot(roots[0], { sourcePath: path, matrixLayout });
  if (timings) timings.parseMs = (timings.parseMs ?? 0) + performance.now() - parseStarted;
  return doc;
}

export function parseWorkerXmlMod(text: string, path: string, timings?: Record<string, number>) {
  return projectXmlMod(readWorkerXmlMod(text, path, 'project-column-major', timings));
}
