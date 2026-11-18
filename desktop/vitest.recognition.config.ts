import {defineConfig} from 'vitest/config';

/** Recognition DTOs and source adapters only; no viewer, mesh, WASM or rendering. */
export default defineConfig({resolve:{conditions:['gim-source']},test:{environment:'node',poolOptions:{forks:{minForks:1,maxForks:2}},include:[
  '../packages/gim-sdk/src/engineering/__tests__/classification.test.ts',
  '../packages/gim-sdk/src/engineering/__tests__/normalize.test.ts',
  '../packages/gim-sdk/src/engineering/__tests__/ownership.test.ts',
  '../packages/gim-sdk/src/gim/engineering/__tests__/sourceComposition.test.ts',
  '../packages/gim-sdk/src/gim/engineering/__tests__/engineeringModel.test.ts',
  '../packages/gim-sdk/src/engineering/__tests__/standardCatalog.test.ts',
  '../packages/gim-sdk/src/engineering/__tests__/componentVocabulary.test.ts',
  '../packages/gim-sdk/src/engineering/__tests__/recognizeSource.test.ts',
  '../packages/gim-sdk/src/gim/engineering/__tests__/confirmedSemantics.test.ts',
  '../packages/gim-sdk/src/engineering/__tests__/standardRecognition.test.ts',
  '../packages/gim-sdk/src/engineering/__tests__/recognition*.test.ts',
]}});
