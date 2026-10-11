import {defineConfig} from 'vitest/config';
import base from './vitest.config.js';
export default defineConfig({...base,test:{...base.test,environment:'node',include:['src/viewer/__tests__/ifcPreview.sample.test.ts'],exclude:[],poolOptions:{forks:{singleFork:true}}}});
