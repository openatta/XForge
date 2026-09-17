// design: live-test D13 — 标准 live 矩阵：引擎 A 跑 3 条流程 × 4 种治理组合 = 12 场（solid 用带植入故障的 solid-rework），再加一场 major TT 的 stepwise 驱动；
// 引擎 B 只做最后验证：TT 与 FF 各跑 quick、solid 两条流程 = 4 场，再加一场 solid FF 的 stepwise。每场一个 worktree，并行数可控。
// 用法：node scripts/live-matrix.mjs [--engine A|B] [--concurrency 6] [--only quick:TT,major:FF] [--set small] [--ref <commit-ish>]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const engine = opt('--engine', 'A');
const concurrency = Number(opt('--concurrency', engine === 'A' ? '6' : '4'));
const only = opt('--only', '');
// --set small：非大版本的常规验证 —— 引擎 A 上 solid-rework 与 major 各跑 TT 与 FF，4 场（用户 2026-09-18 定）。
const setName = opt('--set', '');
const SMALL = ['solid-rework:TT', 'solid-rework:FF', 'major:TT', 'major:FF'];
const ref = opt('--ref', 'HEAD');

const FLOWS_A = ['quick', 'solid-rework', 'major'];
const GOV = ['TT', 'TF', 'FT', 'FF'];
const matrix = engine === 'A'
  ? [...FLOWS_A.flatMap((s) => GOV.map((g) => ({ scenario: s, governance: g, driver: 'orchestrated' }))), { scenario: 'major', governance: 'TT', driver: 'stepwise' }]
  : [...['TT', 'FF'].flatMap((g) => ['quick', 'solid'].map((s) => ({ scenario: s, governance: g, driver: 'orchestrated' }))), { scenario: 'solid', governance: 'FF', driver: 'stepwise' }];
const key = (m) => `${m.scenario}:${m.governance}${m.driver === 'stepwise' ? ':stepwise' : ''}`;
const wanted = only ? only.split(',').map((x) => x.trim()) : setName === 'small' ? SMALL : null;
const runs = matrix.filter((m) => !wanted || wanted.includes(key(m)));

const logsDir = join(repoRoot, 'test', '.tmp', 'live', 'logs');
mkdirSync(logsDir, { recursive: true });
const startedAt = new Date();

function launch(m) {
  const env = [`XF_LIVE_SCENARIO=${m.scenario}`, `XF_LIVE_GOVERNANCE=${m.governance}`, `XF_LIVE_DRIVER=${m.driver}`, `XF_LIVE_ENGINE=${engine === 'A' ? 'claude' : 'gateway'}`];
  const log = join(logsDir, `matrix-${engine}-${key(m).replaceAll(':', '-')}.log`);
  return new Promise((res) => {
    const child = spawn('node', [join(repoRoot, 'scripts', 'live-worktree.mjs'), '--ref', ref, '--', ...env], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    child.on('close', (code) => {
      try { writeFileSync(log, Buffer.concat(out)); } catch { /* 日志只是辅助 */ }
      res({ ...m, code });
    });
  });
}

const queue = [...runs];
const results = [];
async function worker() {
  while (queue.length) {
    const m = queue.shift();
    process.stdout.write(`▶ ${key(m)}\n`);
    const r = await launch(m);
    process.stdout.write(`■ ${key(m)} exit ${r.code}\n`);
    results.push(r);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, runs.length) }, worker));

// 汇总：只认这次矩阵开始之后落盘的 summary。
const root = join(repoRoot, 'test', '.tmp', 'live', engine === 'A' ? 'claude' : 'gateway');
const rows = [];
for (const m of runs) {
  const dir = join(root, [m.scenario, ...(m.governance === 'TT' ? [] : [m.governance]), ...(m.driver === 'stepwise' ? ['stepwise'] : [])].join('-'));
  if (!existsSync(dir)) { rows.push([m, null]); continue; }
  const latest = readdirSync(dir).sort().filter((d) => new Date(d.replace(/-(\d\d)-(\d\d)-(\d\d\d)Z$/, ':$1:$2.$3Z')) >= startedAt).at(-1);
  const file = latest ? join(dir, latest, 'summary.json') : null;
  rows.push([m, file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null]);
}
process.stdout.write('\n| 场景 | 治理 · 驱动 | 结果 | 轮 | 返工 | oracle | output | xforge 调用 | deny |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n');
for (const [m, s] of rows) {
  const g = `${m.governance}${m.driver === 'stepwise' ? ' · stepwise' : ''}`;
  if (!s) { process.stdout.write(`| ${m.scenario} | ${g} | （没有结果） | | | | | | |\n`); continue; }
  process.stdout.write(`| ${m.scenario} | ${g} | ${s.outcome}${s.stopped_at ? `（${s.stopped_at}）` : ''} | ${s.turns} | ${s.reworks} | ${s.oracle.ran - s.oracle.failed}/${s.oracle.ran} | ${s.tokens.output} | ${s.observations.xforge_calls} | ${s.observations.enforce_denies} |\n`);
}
process.exitCode = rows.some(([, s]) => !s || s.outcome !== 'archived') ? 1 : 0;
