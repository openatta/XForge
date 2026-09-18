// design: cli §5.4 — 交互装配：探测、灰掉不可选项、不让空手过、答完与 flag 的答案逐字节相同（CLI-36 CLI-37 CLI-38）。
// 交互判断由边界给出（`io.interactive`），所以这里不需要真 TTY：喂一段按键就行。
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type Io } from '../../src/cli/index.js';

const SPACE = ' ';
const ENTER = '\r';
const DOWN = '\u001b[B';
const CTRL_C = '\u0003';

interface Trip {
  exit: number;
  stdout: string;
  stderr: string;
  cwd: string;
}

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xforge-interactive-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 一台「只装了这几样」的机器：一个假的 HOME（没有 `~/.claude`），一个只有这几个可执行文件的 PATH。
 * PATH 里不含真实 PATH —— 不然基准机上装了什么，测试就跟着变。
 */
function machineWith(binaries: string[]): { home: string; path: string } {
  const home = sandbox();
  const bin = sandbox();
  for (const b of binaries) {
    writeFileSync(join(bin, b), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, b), 0o755);
  }
  return { home, path: bin };
}

async function install(cwd: string, machine: { home: string; path: string }, keys: string, opts: { args?: string[]; noColor?: boolean } = {}): Promise<Trip> {
  const input = new PassThrough();
  const out = new PassThrough();
  const err = new PassThrough();
  let stdout = '';
  let stderr = '';
  out.on('data', (d: Buffer) => (stdout += d.toString()));
  err.on('data', (d: Buffer) => (stderr += d.toString()));
  // 会话变量会让宿主「确定在场」，那一路证据盖过 PATH —— 这里要测的是探测本身，所以清掉。
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: machine.home, PATH: machine.path };
  for (const name of ['XFORGE_ROOT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_HOME', 'CI']) delete env[name];
  if (opts.noColor) env['NO_COLOR'] = '1';
  const io: Io = { cwd, env, stdin: input, stdout: out, stderr: err, interactive: true, columns: 200 };
  const running = main(opts.args ?? ['init', '--flow', 'quick'], io);
  input.write(keys);
  const exit = await running;
  return { exit, stdout, stderr, cwd };
}

const manifestOf = (cwd: string): string => readFileSync(join(cwd, 'xforge', 'manifest.yaml'), 'utf8');

describe('interactive init (cli §5.4)', () => {
  it('lists what was detected with its evidence, greys out what was not, and writes the answer', async () => {
    const machine = machineWith(['claude']);
    const trip = await install(sandbox(), machine, SPACE + ENTER + ENTER);
    expect(trip.exit, trip.stderr).toBe(0);
    expect(trip.stderr).toContain('Select the hosts to install into');
    expect(trip.stderr).toContain('found: claude on PATH');
    expect(trip.stderr).toContain('not detected');
    expect(trip.stderr).toContain('\u001b[2m'); // 没探测到的项画灰
    expect(trip.stderr).toContain('Select the language for generated Skills');
    expect(manifestOf(trip.cwd)).toContain('platforms:\n  - claude\n');
    expect(manifestOf(trip.cwd)).toContain('language: zh-CN');
  });

  it('will not go on with nothing picked — and the cursor never rests on a greyed row', async () => {
    const machine = machineWith(['claude']);
    const trip = await install(sandbox(), machine, ENTER + DOWN + SPACE + ENTER + ENTER);
    expect(trip.exit).toBe(0);
    expect(trip.stderr).toContain('At least one tool must be selected.');
    // 往下走一格本该落到 codex 上，但 codex 探测不到：光标留在 claude，空格勾中的也就是 claude。
    expect(manifestOf(trip.cwd)).toContain('platforms:\n  - claude\n');
  });

  it('says so when nothing at all was detected, and cancel is not an answer', async () => {
    const trip = await install(sandbox(), machineWith([]), ENTER + CTRL_C); // 回车问不出答案，然后人放弃
    expect(trip.exit).toBe(1);
    expect(trip.stderr).toContain('Nothing detected');
    expect(trip.stderr).toContain('--platform');
    expect(existsSync(join(trip.cwd, 'xforge', 'manifest.yaml'))).toBe(false); // 取消不许留下半个清单
    const env = JSON.parse(trip.stdout.trim()) as { diagnostics: Array<{ code: string }> };
    expect(env.diagnostics[0]?.code).toBe('XF-ASSEMBLE-006');
  });

  it('writes the same manifest as the same answers given as flags (CLI-36)', async () => {
    const machine = machineWith(['claude']);
    const asked = await install(sandbox(), machine, SPACE + ENTER + ENTER);
    const flagged = await install(sandbox(), machine, '', { args: ['init', '--flow', 'quick', '--platform', 'claude', '--language', 'zh-CN'] });
    expect(flagged.stderr).toBe(''); // flag 把所有答案都说出来了，一个问题都不该问
    expect(manifestOf(asked.cwd)).toBe(manifestOf(flagged.cwd));
  });

  it('keeps stdout for the envelope alone, and colour out of it when asked (CLI-37 CLI-38)', async () => {
    const machine = machineWith(['claude']);
    const trip = await install(sandbox(), machine, SPACE + ENTER + ENTER, { noColor: true });
    const lines = trip.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, verb: 'init' });
    expect(trip.stderr).not.toContain('\u001b[2m');
    expect(trip.stderr).not.toContain('\u001b[0m');
  });

  it('asks nothing when the manifest is already there — a repeated init has no decision left', async () => {
    const machine = machineWith(['claude']);
    const trip = await install(sandbox(), machine, SPACE + ENTER + ENTER);
    const before = manifestOf(trip.cwd);
    const again = await install(trip.cwd, machine, '');
    expect(again.exit).toBe(0);
    expect(again.stderr).toBe('');
    expect(manifestOf(trip.cwd)).toBe(before);
  });
});
