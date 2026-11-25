import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    reporters: process.env.JUNIT_OUT ? ['default', ['junit', { outputFile: process.env.JUNIT_OUT }]] : ['default'],
  },
});
