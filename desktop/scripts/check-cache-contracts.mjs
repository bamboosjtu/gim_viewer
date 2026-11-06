import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const document = readFileSync(resolve(repo, 'docs/architecture/caches.md'), 'utf8');
const failures = [];
for (const row of document.split('\n').filter(line => line.startsWith('|'))) {
  const versions = [...row.matchAll(/`([^`]+)`/g)].map(match => match[1]).filter(value => /-v\d|wholes-\d/.test(value));
  if (!versions.length) continue;
  const sources = [...row.matchAll(/\]\(([^)]+)\)/g)].map(match => resolve(repo, 'docs/architecture', match[1]));
  const contents = sources.map(path => ({ path, text: readFileSync(path, 'utf8') }));
  for (const version of versions) {
    if (!contents.some(source => source.text.includes(version))) failures.push(`No authority declares ${version}`);
    const prefix = version.replace(/\d.*$/, '');
    for (const source of contents) {
      const literals = [...source.text.matchAll(/(?:const|let|static)\s+\w+[^=\r\n]*=\s*['"]([^'"\r\n]+)['"]/g)].map(match => match[1]);
      for (const literal of literals.filter(value => value.startsWith(prefix))) {
        if (literal !== version) failures.push(`${source.path}: ${literal} differs from documented ${version}`);
      }
    }
  }
}
if (failures.length) throw Error(failures.join('\n'));
console.log('Cache domain versions match documented authorities.');
