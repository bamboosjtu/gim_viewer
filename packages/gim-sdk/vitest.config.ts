import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{conditions:['gim-source']},test:{environment:'node',globals:true,
 include:['src/**/__tests__/**/*.test.ts'],
 coverage:{provider:'v8',reporter:['text-summary','json-summary','json','html'],reportsDirectory:'../../output/coverage/sdk',
 include:['src/**/*.ts'],exclude:['src/**/__tests__/**','src/**/*.d.ts'],thresholds:process.env.GIM_COMBINED_COVERAGE?undefined:{
 'src/source/**':{statements:90,lines:90,functions:90,branches:80},
 'src/semantic/**':{statements:95,lines:95,functions:95,branches:90},
 'src/geometry/**':{statements:90,lines:90,functions:90,branches:80},
 'src/engineering/**':{statements:90,lines:90,functions:90,branches:80},
 'src/projection/**':{statements:90,lines:90,functions:90,branches:80},
 'src/adapters/**':{statements:90,lines:90,functions:90,branches:80},
 'src/shared/**':{statements:90,lines:90,functions:90,branches:80},
 }},poolOptions:{forks:{minForks:1,maxForks:2}}}});
