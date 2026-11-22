import tseslint from 'typescript-eslint';
import {architectureModules as adopted, scriptTestFiles} from './scripts/format-architecture.mjs';
const adoptedTypescript = adopted.filter(path => /\.[cm]?ts$/.test(path));
const adoptedScripts = adopted.filter(path => /\.[cm]?js$/.test(path));
const tsconfigRootDir = import.meta.dirname;
const asyncRules = {
  '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
  '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
};
export default tseslint.config({
  ignores: ['node_modules/**', 'dist/**', 'public/**', '.tmp/**'],
}, {
  files: [
    'src/**/*.{ts,mts,cts}', 'bridge/**/*.{ts,mts,cts}',
    '../app/src/**/*.{test,spec}.{ts,mts,cts}', '../app/src/**/__tests__/**/*.{ts,mts,cts}',
    '../app/tests/**/*.{ts,mts,cts}',
    '../packages/{gim-sdk,measurement-core,powerline-core}/src/**/*.{ts,mts,cts}',
    ...adoptedTypescript,
  ],
  languageOptions: { parser: tseslint.parser, parserOptions: {
    project: ['./tsconfig.json', '../packages/gim-sdk/tsconfig.json',
      '../packages/gim-sdk/tsconfig.test.json', '../app/tsconfig.json', './tsconfig.lint.json'],
    tsconfigRootDir,
  } },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: asyncRules,
},{
  files: ['../packages/gim-sdk/src/**/*.ts'],
  ignores: ['../packages/gim-sdk/src/**/__tests__/**'],
  rules: {
    'no-console': 'error',
    'no-restricted-globals': ['error', ...['self', 'fetch', 'caches', 'indexedDB', 'importScripts', 'navigator', 'window', 'document']],
    'no-restricted-properties': ['error', ...['self', 'fetch', 'caches', 'indexedDB', 'importScripts', 'navigator', 'window', 'document']
      .map(property => ({object: 'globalThis', property, message: 'Supply host access outside the pure SDK.'}))],
  },
},...tseslint.configs.recommendedTypeChecked.map(config=>({...config,files:adoptedTypescript})),
{files:adoptedTypescript,ignores:['src/utils/logger.ts'],rules:{'no-console':'error'}},
{
  files: adoptedScripts,
  languageOptions: { parser: tseslint.parser, parserOptions: { project: './tsconfig.lint.json', tsconfigRootDir } },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: { ...asyncRules, 'no-unreachable': 'error', 'no-unused-vars': 'error' },
}, {
  files: [`../${scriptTestFiles}`],
  languageOptions: { parser: tseslint.parser, parserOptions: { project: './tsconfig.lint.json', tsconfigRootDir } },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    ...asyncRules,
    '@typescript-eslint/no-floating-promises': ['error', {
      ignoreVoid: false,
      allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] }],
    }],
  },
});
