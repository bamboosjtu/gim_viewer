import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import * as ts from 'typescript';
import sourceVocabulary from '../catalog/sourceVocabulary.json';
import { ENGINEERING_EVIDENCE_FIELDS } from '../../shared/recognitionFieldPolicy.js';

/** Every inline label list that feeds the shared evidence reader: the string
 * arrays passed to `values([...])`, the named field lists the reader consumes
 * (identifiers ending in Fields/Keys plus their `push(...)` literals), and the
 * data-driven keyword dictionary fields. A label outside recognitionFields.json
 * can never be read from a record, so this closure is what makes the shared
 * field fingerprint a meaningful cache contract. */
function inlineRecognitionLabels(): string[] {
  const labels = new Set<string>();
  const add = (list: readonly string[]): void => { for (const label of list) labels.add(label); };
  const stringList = (node: ts.Node): readonly string[] | null => {
    if (!ts.isArrayLiteralExpression(node) || !node.elements.length) return null;
    const texts: string[] = [];
    for (const element of node.elements) {
      if (!ts.isStringLiteral(element)) return null;
      texts.push(element.text);
    }
    return texts;
  };
  const namedFieldList = (name: string): boolean => /(?:Fields|Keys)$/.test(name);
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../recognizeSource.ts'), 'utf8');
  const ast = ts.createSourceFile('recognizeSource.ts', source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && namedFieldList(node.name.text)) {
      const list = node.initializer ? stringList(node.initializer) : null;
      if (list) add(list);
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression
        : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
          && node.expression.name.text === 'push' && namedFieldList(node.expression.expression.text)
          ? node.expression.expression : undefined;
      if (callee) {
        if (ts.isPropertyAccessExpression(node.expression)) {
          const pushed: string[] = [];
          for (const argument of node.arguments) {
            if (!ts.isStringLiteral(argument)) continue;
            pushed.push(argument.text);
          }
          if (pushed.length === node.arguments.length) add(pushed);
        } else if (callee.text === 'values') {
          for (const argument of node.arguments) {
            const list = stringList(argument);
            if (list) add(list);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...labels];
}

it('keeps every inline recognition label inside the shared field whitelist', () => {
  // The evidence reader matches property keys after toUpperCase(), so the
  // whitelist itself has to be stored in normalized form.
  expect(ENGINEERING_EVIDENCE_FIELDS.filter(field => field !== field.toUpperCase()),
    'whitelist entries must already be uppercase').toEqual([]);
  const whitelist = new Set(ENGINEERING_EVIDENCE_FIELDS);
  const labels = [...inlineRecognitionLabels(), ...sourceVocabulary.keywordDictionary.fields];
  expect(labels.length, 'inline label extraction found nothing to check').toBeGreaterThan(40);
  expect(labels.filter(label => !whitelist.has(label.toUpperCase())),
    'labels that recognitionFields.json must cover').toEqual([]);
});
