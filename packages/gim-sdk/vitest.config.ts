import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{conditions:['gim-source']},test:{environment:'node',globals:true,
 include:['src/**/__tests__/**/*.test.ts'],
 coverage:{provider:'v8',reporter:['text-summary','json-summary','json','html'],reportsDirectory:'../../output/coverage/sdk',
 include:['src/**/*.ts'],exclude:['src/**/__tests__/**','src/**/*.d.ts'],thresholds:process.env.GIM_COMBINED_COVERAGE?undefined:{
 'src/engineering/**':{statements:95,lines:95,functions:95,branches:90},
 'src/gim/**':{statements:90,lines:90,functions:90,branches:80},
 }},poolOptions:{forks:{minForks:1,maxForks:2}}}});
