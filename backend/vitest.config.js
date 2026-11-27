import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    fileParallelism: false, // all test files share one test database
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
