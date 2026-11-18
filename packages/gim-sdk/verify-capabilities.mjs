import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const capabilities = ['source','semantic','geometry','engineering','projection','source-adapter'];
const recognitionInputs = new Set([
  'classify.ts','normalize.ts','recoverMembership.ts','recognizeSource.ts',
  'catalogClassification.ts','policyFingerprints.ts','standardCatalog.ts','recognitionPolicy.json',
  'compositionPolicy.json','sourceCompatibilityPolicy.json','sourceVocabulary.json','proxyCategories.json',
]);

export function assertCapabilityInputs(capability, inputs) {
  const forbidden = inputs.filter(input => {
    const file = input.replaceAll('\\', '/');
    if (capability === 'source') {
      return file.startsWith('src/engineering/')
        || /^src\/gim\/engineering\/(?:geometry|physicalOccurrences|navigation|projection|semanticAdapter|objectEvidence)/.test(file)
        || file === 'src/shared/representationAddresses.ts';
    }
    if (['geometry','engineering','projection'].includes(capability)) {
      return recognitionInputs.has(file.split('/').at(-1))
        || file === 'src/gim/engineering/semanticAdapter.ts'
        || file === 'src/gim/engineering/objectEvidence.ts';
    }
    return false;
  });
  if(forbidden.length)throw Error(`${capability} runtime closure imports ${forbidden.join(', ')}`);
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
