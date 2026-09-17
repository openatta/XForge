#!/usr/bin/env node
// design: cli §4 — 执法入口独立于主 CLI（migration D7）：只引入 dist/enforce。
import { enforceMain } from '../dist/enforce/index.js';

process.exitCode = await enforceMain(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
});
