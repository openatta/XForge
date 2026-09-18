#!/usr/bin/env node
// design: cli §1.2 — 一次调用一个进程：解析参数、算、落盘、输出、退出。
import { main } from '../dist/cli/index.js';

// 交互与否在这里判，不在命令里判：TTY 是边界的事实，判断只做一次（cli §5.4）。
const tty = Boolean(process.stdin.isTTY && process.stderr.isTTY);

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  interactive: tty && !process.env.CI,
  // 0 是「不知道多宽」，不是「零列宽」—— 用它去截行会把整块列表截成一个字。
  columns: process.stderr.columns || 80,
});
