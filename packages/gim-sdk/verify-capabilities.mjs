import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const capabilities = ['source','semantic','geometry','engineering','projection','source-adapter'];
// Transitional modules sharing legacy directories are classified explicitly.
// New files inherit their directory role, and unknown paths are rejected.
const roles = new Map(Object.entries({
  'src/gim/engineering/geometry.ts': 'geometry',
  'src/gim/engineering/geometryOccurrences.ts': 'geometry',
  'src/gim/engineering/physicalOccurrences.ts': 'geometry',
  'src/gim/engineering/objectEvidence.ts': 'source-adapter',
  'src/gim/engineering/semanticAdapter.ts': 'source-adapter',
  'src/gim/engineering/sourceRecordSelectors.ts': 'shared',
  'src/shared/representationAddresses.ts': 'geometry',
  'src/engineering/fusion.ts': 'engineering',
  'src/engineering/representations.ts': 'engineering',
  'src/engineering/query.ts': 'projection',
  'src/engineering/catalogLabels.ts': 'directory',
  'src/engineering/catalog.json': 'directory',
  'src/engineering/standardCatalog.json': 'directory',
  ...Object.fromEntries(['composition','compositionTemplate','inventoryTemplate'].map(name => [
    `src/engineering/${name}.ts`, 'projection',
  ])),
  ...Object.fromEntries(['projection','navigation','sourceProjection','inventory','compositionContexts','sourceTitles'].map(name => [
    `src/gim/engineering/${name}.ts`, 'projection',
  ])),
}));

const allowed = {
  source: ['source','format','shared'],
  semantic: ['semantic','directory','shared'],
  geometry: ['geometry','format','shared'],
  engineering: ['engineering','geometry','shared'],
  projection: ['projection','directory','shared'],
  'source-adapter': ['source-adapter','source','format','shared','semantic','directory'],
};

function inputRole(input) {
  const path = input.replaceAll('\\','/');
  if (roles.has(path)) return roles.get(path);
  if (path.startsWith('src/shared/')) return 'shared';
  if (path.startsWith('src/engineering/')) return 'semantic';
  if (path.startsWith('src/gim/engineering/')) return 'source';
  if (path.startsWith('src/gim/') || /(?:^|\/)powerline-core\/src\//.test(path)) return 'format';
  return undefined;
}

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
