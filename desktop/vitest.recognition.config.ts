import {defineConfig} from 'vitest/config';

/** Recognition DTOs and source adapters only; no viewer, mesh, WASM or rendering. */
export default defineConfig({test:{environment:'node',poolOptions:{forks:{minForks:1,maxForks:2}},include:[
  'src/engineering/__tests__/classification.test.ts',
  'src/engineering/__tests__/normalize.test.ts',
  'src/engineering/__tests__/standardCatalog.test.ts',
  'src/gim/engineering/__tests__/componentVocabulary.test.ts',
  'src/gim/engineering/__tests__/sourceEvidence.test.ts',
  'src/gim/engineering/__tests__/recognitionFieldIndex.test.ts',
  'src/engineering/__tests__/standardRecognition.test.ts',
  'src/engineering/__tests__/recognition*.test.ts',
]}});
