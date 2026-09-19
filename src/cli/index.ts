// design: cli §1 — 主入口：解析、分发、信封、退出码。用法错误走 stderr；其余一律信封。
import { runAssemble, ASSEMBLE_VERBS, type AssembleVerb } from '../assemble/index.js';
import { HELP, runExplain, runVersion } from '../meta/index.js';
import { dispatchVerb, VERBS, type Verb } from '../verbs/index.js';
import { flagBool, flagString, parseArgs } from './args.js';
import { emit, envelope, type Io, type Outcome } from './envelope.js';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '../model/paths.js';
import { CliError, UsageError } from './errors.js';

export type { Io } from './envelope.js';

/**
 * 每个命令认得的开关（命令行设计 §1.2、`CLI-50`）。三个通用开关对所有命令都认。
 * 有这张表，一个打错或不支持的开关就是用法错，而不是被静默吞掉 ——
 * 吞掉的后果是 `repair --dry-run` 真的写盘、`repair --platform x` 改的是别的宿主，两次都退出 0。
 */
const COMMON_FLAGS = ['text', 'field', 'cwd'] as const;
const FLAGS: Record<string, readonly string[]> = {
  help: [],
  version: [],
  explain: [],
  state: ['change', 'scheme', 'orient'],
  show: ['change', 'scheme'],
  inspect: ['change', 'scheme', 'all', 'hygiene'],
  run: ['change', 'scheme', 'gate', 'package', 'force'],
  attest: ['change', 'scheme', 'stage', 'archive', 'decision', 'note', 'via', 'command'],
  advance: ['change', 'scheme', 'no-run', 'workdir', 'rework-to', 'reason', 'dispatch', 'deliver', 'archive'],
  init: ['flow', 'platform', 'language', 'no-input'],
  sync: ['platform'],
  doctor: ['platform'],
  repair: ['dry-run'],
  update: ['status', 'finish', 'rollback', 'payload', 'to'],
  upgrade: ['status', 'finish', 'rollback', 'payload', 'to'],
  remove: ['confirm'],
};

function checkFlags(verb: string, parsed: ReturnType<typeof parseArgs>): void {
  const known = FLAGS[verb];
  if (!known) return; // 命令本身不认得，由下面的「未知命令」去报
  const allowed = new Set<string>([...COMMON_FLAGS, ...known]);
  const unknown = [...parsed.flags.keys()].filter((k) => !allowed.has(k));
  if (!unknown.length) return;
  const list = [...COMMON_FLAGS, ...known].map((f) => `--${f}`).join(' ');
  throw new UsageError(`xforge ${verb} 不认得 ${unknown.map((k) => `--${k}`).join(' ')}\n\n用法: xforge ${verb} ${list || '（这个命令没有开关）'}`);
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const parsed = parseArgs(argv);
  const verb = parsed.positional[0] ?? 'help';
  const text = flagBool(parsed, 'text');
  const field = flagString(parsed, 'field');
  const rawCwd = flagString(parsed, 'cwd') ?? io.cwd;
  let cwd = rawCwd;
  try {
    cwd = realpathSync(rawCwd);
  } catch {
    cwd = rawCwd;
  }
  try {
    checkFlags(verb, parsed);
    // 升级在途时，除升级自身与只读动词外一律拒绝：哨兵必须在命令面上可见。
    const SENTINEL_OK = new Set(['help', 'version', 'explain', 'state', 'show', 'inspect', 'doctor', 'update', 'upgrade']);
    if (!SENTINEL_OK.has(verb)) {
      const root = await findProjectRoot(cwd);
      if (root && existsSync(join(root, 'xforge', '.upgrade', 'status.yaml'))) {
        throw new CliError('XF-ASSEMBLE-001', '一次脚手架升级在途，先完成或回滚它', 1, { command: 'xforge update --status', text: '看在途状态' });
      }
    }
    let outcome: Outcome;
    if (verb === 'help') {
      io.stdout.write(HELP);
      return 0;
    } else if (verb === 'version') outcome = await runVersion(cwd);
    else if (verb === 'explain') {
      const code = parsed.positional[1];
      if (!code) throw new UsageError('用法: xforge explain <code>');
      outcome = await runExplain(code);
    } else if ((VERBS as readonly string[]).includes(verb)) outcome = await dispatchVerb(verb as Verb, parsed, cwd, io.env);
    else if ((ASSEMBLE_VERBS as readonly string[]).includes(verb)) outcome = await runAssemble(verb as AssembleVerb, parsed, cwd, io.env, io);
    else throw new UsageError(`未知命令 ${verb}\n\n${HELP}`);
    const { env, exit } = envelope(verb, outcome);
    emit(io, env, { text, ...(field ? { field } : {}) });
    return exit;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(error.message + '\n');
      return 2;
    }
    if (error instanceof CliError) {
      const { env } = envelope(verb, { result: {}, diagnostics: [error.toDiagnostic()], exit: error.exit });
      emit(io, env, { text, ...(field ? { field } : {}) });
      return error.exit;
    }
    io.stderr.write(`xforge: 内部错误：${(error as Error).stack ?? String(error)}\n`);
    return 3;
  }
}
