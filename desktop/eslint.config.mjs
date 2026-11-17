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
},...tseslint.configs.recommendedTypeChecked.map(config=>({...config,files:adopted})),{files:adopted,ignores:['src/utils/logger.ts'],rules:{'no-console':'error'}});
