#!/usr/bin/env node
// design: cli §1.2 — 一次调用一个进程：解析参数、算、落盘、输出、退出。
import { main } from '../dist/cli/index.js';

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
