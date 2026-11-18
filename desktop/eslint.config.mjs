import tseslint from 'typescript-eslint';
import {architectureModules as adopted} from './scripts/format-architecture.mjs';
export default tseslint.config({
  ignores: ['node_modules/**', 'dist/**', 'public/**', '.tmp/**', '**/__tests__/**', '**/*.test.ts'],
}, {
  files: ['src/**/*.ts', 'bridge/**/*.ts', '../packages/gim-sdk/src/**/*.ts'],
  languageOptions: { parser: tseslint.parser, parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname } },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
  },
},{
  files: ['../packages/gim-sdk/src/**/*.ts'],
  rules: {
    'no-console': 'error',
    'no-restricted-globals': ['error', ...['self', 'fetch', 'caches', 'indexedDB', 'importScripts', 'navigator', 'window', 'document']],
    'no-restricted-properties': ['error', ...['self', 'fetch', 'caches', 'indexedDB', 'importScripts', 'navigator', 'window', 'document']
      .map(property => ({object: 'globalThis', property, message: 'Supply host access outside the pure SDK.'}))],
  },
},...tseslint.configs.recommendedTypeChecked.map(config=>({...config,files:adopted})),{files:adopted,ignores:['src/utils/logger.ts'],rules:{'no-console':'error'}});
