import tseslint from 'typescript-eslint';
const adopted=['src/utils/logger.ts','src/shared/projectViewState.ts','src/services/ifcSelectionProjection.ts','src/services/*PresentationPort.ts'];
export default tseslint.config({
  ignores: ['node_modules/**', 'dist/**', 'public/**', '.tmp/**', '**/__tests__/**', '**/*.test.ts'],
}, {
  files: ['src/**/*.ts', 'bridge/**/*.ts'],
  languageOptions: { parser: tseslint.parser, parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname } },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
  },
},...tseslint.configs.recommendedTypeChecked.map(config=>({...config,files:adopted})));
