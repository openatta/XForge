// design: cli §1 — 主入口：解析、分发、信封、退出码。用法错误走 stderr；其余一律信封。
import { deprecation, resolveAssembleVerb, runAssemble } from '../assemble/index.js';
import { HELP, runExplain, runVersion } from '../meta/index.js';
import { dispatchVerb, VERBS, type Verb } from '../verbs/index.js';
import { flagBool, flagString, parseArgs } from './args.js';
import { emit, envelope, type Io, type Outcome } from './envelope.js';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '../model/paths.js';
import { CliError, UsageError } from './errors.js';

export type { Io } from './envelope.js';

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
    // 升级在途时，除升级自身与只读动词外一律拒绝：哨兵必须在命令面上可见。
    // doctor 只读，且在途升级「现在什么状态」正是它要回答的（cli §5.5）。
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
    else {
      const assemble = resolveAssembleVerb(verb);
      if (!assemble) throw new UsageError(`未知命令 ${verb}\n\n${HELP}`);
      outcome = await runAssemble(assemble, parsed, cwd, io);
      // 旧名照跑，但信封末尾带一条 deprecation；抛错时走不到这里，错误本身更要紧。
      if (assemble !== verb) outcome.diagnostics = [...(outcome.diagnostics ?? []), deprecation(verb, assemble)];
    }
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
