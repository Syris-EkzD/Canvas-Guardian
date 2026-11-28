const { defineConfig, globalIgnores } = require('eslint/config');
const expo = require('eslint-config-expo/flat');
module.exports = defineConfig([
  globalIgnores(['.expo/**', 'android/**', 'dist/**', 'expo-env.d.ts']),
  expo,
  { files: ['tests/*.test.jsx'], languageOptions: { globals: { jest: 'readonly', test: 'readonly', expect: 'readonly', beforeEach: 'readonly' } } },
]);
