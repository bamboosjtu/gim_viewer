import desktop from './desktop/eslint.config.mjs';
// Keep the desktop's rule/adoption source; resolve file globs at workspace scope.
const path=pattern=>pattern.startsWith('../')?pattern.slice(3):pattern.startsWith('**/')?pattern:'desktop/'+pattern;
export default desktop.map(config=>({...config,
 ...(config.files?{files:config.files.map(path)}:{}),
 ...(config.ignores?{ignores:config.ignores.map(pattern=>['node_modules/**','dist/**'].includes(pattern)?'**/'+pattern:path(pattern))}:{}),
 ...(config.languageOptions?.parserOptions?.project?{languageOptions:{...config.languageOptions,parserOptions:{...config.languageOptions.parserOptions,project:['./tsconfig.json','../packages/gim-sdk/tsconfig.json','../packages/gim-sdk/tsconfig.test.json']}}}:{}),
}));
