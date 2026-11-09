// 驛傳（Ekiden）fork 自有的 jest 測試。與上游 test/ 分開，不混在一起。
// 測試檔是 ES module（*.test.mjs），直接 import shinkansen/fork/ 底下的模組。
// 執行：npm run test:fork（= node --experimental-vm-modules … jest --config fork-tests/jest.config.cjs）
/** @type {import('jest').Config} */
module.exports = {
  rootDir: '..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/fork-tests/unit/**/*.test.mjs'],
  transform: {},
  testTimeout: 20000,
};
