import { defineConfig } from 'vitest/config';

// design: migration §0 — D4：live 层跑真实模型，手动或定时执行。
export default defineConfig({
  test: {
    include: ['test/live/**/*.live.ts'],
    exclude: ['legacy/**', 'node_modules/**', 'dist/**'],
    testTimeout: 4 * 60 * 60_000, // 一个场景一小时以上是常态（网关引擎的 solid 用了 80 分钟）
    fileParallelism: false,
  },
});
