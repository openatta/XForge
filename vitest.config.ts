import { defineConfig } from 'vitest/config';

// design: migration §0 — D4 四层测试；live 层在 vitest.live.config.ts，不进合并门。
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts', 'test/product/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
