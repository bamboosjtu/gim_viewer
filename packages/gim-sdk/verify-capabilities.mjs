import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const capabilities = ['source','semantic','geometry','engineering','projection','source-adapter'];

// Directory ownership decides a module's role; every input path must resolve
// through these prefixes and unknown paths fail closed.
function inputRole(input) {
  const path = input.replaceAll('\\','/');
  if (path.startsWith('src/source/')) return 'source';
  if (path.startsWith('src/semantic/catalog/')) return 'directory';
  if (path.startsWith('src/semantic/')) return 'semantic';
  if (path.startsWith('src/geometry/')) return 'geometry';
  if (path.startsWith('src/engineering/')) return 'engineering';
  if (path.startsWith('src/projection/')) return 'projection';
  if (path.startsWith('src/adapters/')) return 'source-adapter';
  if (path.startsWith('src/shared/')) return 'shared';
  if (path.startsWith('src/') || /(?:^|\/)powerline-core\/src\//.test(path)) return 'format';
  return undefined;
}

const allowed = {
  source: ['source','format','shared'],
  semantic: ['semantic','directory','shared'],
  // Geometry has always consumed the shared source-document readers; the tree
  // migration renames their role from 'format' to 'source', so the allowance
  // follows the files instead of inventing a new violation.
  geometry: ['geometry','source','format','shared'],
  engineering: ['engineering','geometry','shared'],
  projection: ['projection','directory','shared'],
  'source-adapter': ['source-adapter','source','format','shared','semantic','directory'],
};

export function assertCapabilityInputs(capability, inputs) {
  const permitted = allowed[capability] ?? [];
  const forbidden = inputs.filter(input => !permitted.includes(inputRole(input)));
  if (forbidden.length) throw Error(`${capability} runtime closure imports ${forbidden.join(', ')}`);
}

export async function verifyCapabilities() {
  return Object.fromEntries(await Promise.all(capabilities.map(async capability => {
    const result = await build({
      absWorkingDir:root,
      entryPoints:[manifest.exports['./'+capability]['gim-source']],
      bundle:true,
      write:false,
      metafile:true,
      format:'esm',
      platform:'neutral',
    });
    const inputs=Object.keys(result.metafile.inputs);
    assertCapabilityInputs(capability, inputs);
    return [capability, {inputs:inputs.length, bytes:result.outputFiles[0].contents.length}];
  })));
}
