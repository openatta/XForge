// design: cli §2 — 五个动词的分发：参数 → 上下文 → 动词函数 → 信封。
import type { Parsed } from '../cli/args.js';
import { flagBool, flagList, flagString } from '../cli/args.js';
import { CliError } from '../cli/errors.js';
import type { Outcome } from '../cli/envelope.js';
import { UsageError } from '../cli/errors.js';
import { DEFAULT_SCHEME } from '../model/paths.js';
import { isSchemeId } from '../model/ids.js';
import { advanceArchive, advanceDeliver, advanceDispatch, advanceRework, advanceStage } from './advance.js';
import { attestApprove, attestEntry, attestReceipt, attestVerification } from './attest.js';
import { listOpenChanges, listSchemes, loadChange, loadProject, type ChangeCtx, type Project } from './context.js';
import { runInspect } from './inspect.js';
import { runRun } from './run.js';
import { runShow } from './show.js';
import { runState } from './state.js';

export const VERBS = ['state', 'show', 'inspect', 'run', 'attest', 'advance'] as const;
export type Verb = (typeof VERBS)[number];

export async function dispatchVerb(verb: Verb, parsed: Parsed, cwd: string, env: NodeJS.ProcessEnv): Promise<Outcome> {
  const project = await loadProject(flagString(parsed, 'cwd') ?? cwd, env);
  const changeId = flagString(parsed, 'change');
  // 方案的解析：--scheme，其次环境变量 XFORGE_SCHEME（给每个方案一个会话/worktree 时设一次），最后缺省。
  const scheme = flagString(parsed, 'scheme') ?? env['XFORGE_SCHEME'] ?? DEFAULT_SCHEME;
  if (scheme !== DEFAULT_SCHEME && !isSchemeId(scheme)) {
    throw new CliError('XF-STATE-001', `方案 id ${scheme} 不合法：小写字母开头的字母数字与连字符，且不能是 specs/interfaces/ledgers/evidence`, 2, { text: '换一个方案 id' });
  }
  const needChange = async (): Promise<ChangeCtx> => {
    const ctx = await loadChange(project, changeId, scheme);
    if (!ctx) throw new UsageError('没有未归档的 Change；先写 change.yaml（xforge state 给骨架）');
    return ctx;
  };
  switch (verb) {
    case 'state':
      return runState(project, { ...(changeId ? { change: changeId } : {}), orient: flagBool(parsed, 'orient'), scheme });
    case 'show': {
      const ref = parsed.positional[1];
      if (!ref) throw new UsageError('用法: xforge show <ref>');
      return runShow(await needChange(), ref);
    }
    case 'inspect': {
      if (flagBool(parsed, 'all')) return inspectAll(project, flagBool(parsed, 'hygiene'));
      return runInspect(await needChange(), { hygiene: flagBool(parsed, 'hygiene') });
    }
    case 'run': {
      const ctx = await needChange();
      const packageId = flagString(parsed, 'package');
      return runRun(ctx, { gates: flagList(parsed, 'gate'), ...(packageId ? { packageId } : {}), force: flagBool(parsed, 'force') });
    }
    case 'attest':
      return attest(project, parsed, needChange);
    case 'advance':
      return advance(parsed, cwd, needChange);
    default:
      throw new UsageError(`未知动词 ${String(verb)}`);
  }
}

async function attest(project: Project, parsed: Parsed, needChange: () => Promise<ChangeCtx>): Promise<Outcome> {
  const sub = parsed.positional[1];
  switch (sub) {
    case 'approve': {
      const decision = flagString(parsed, 'decision');
      if (flagString(parsed, 'via') === undefined && decision !== 'approved' && decision !== 'rejected') throw new UsageError('用法: xforge attest approve (--stage <id> | --archive) --decision approved|rejected [--via <mcp-approver>]');
      if (flagString(parsed, 'via') !== undefined && decision !== undefined) throw new UsageError('--via 时决定由 MCP 给，不带 --decision');
      const stage = flagString(parsed, 'stage');
      const note = flagString(parsed, 'note');
      const via = flagString(parsed, 'via');
      return attestApprove(await needChange(), { ...(stage ? { stage } : {}), archive: flagBool(parsed, 'archive'), ...(decision ? { decision: decision as 'approved' | 'rejected' } : {}), ...(note ? { note } : {}), ...(via ? { via } : {}) });
    }
    case 'entry':
    case 'finding': {
      const ref = sub === 'finding' ? 'review-findings' : parsed.positional[2];
      const id = sub === 'finding' ? parsed.positional[2] : parsed.positional[3];
      if (!ref || !id) throw new UsageError('用法: xforge attest entry <ledger-kind> <entry-id>');
      return attestEntry(await needChange(), ref, id);
    }
    case 'receipt':
      return attestReceipt(await needChange());
    case 'verification': {
      const commands: Record<string, string> = {};
      for (const kv of flagList(parsed, 'command')) {
        const eq = kv.indexOf('=');
        if (eq === -1) throw new UsageError('用法: xforge attest verification --command <name>=<command>');
        commands[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      if (!Object.keys(commands).length) throw new UsageError('用法: xforge attest verification --command <name>=<command>');
      return attestVerification(project, commands);
    }
    default:
      throw new UsageError('用法: xforge attest approve|entry|receipt|verification …');
  }
}

async function advance(parsed: Parsed, cwd: string, needChange: () => Promise<ChangeCtx>): Promise<Outcome> {
  const workdir = flagString(parsed, 'workdir') ?? cwd;
  if (parsed.positional[1] === 'package') {
    const pkg = parsed.positional[2];
    if (!pkg) throw new UsageError('用法: xforge advance package <id> --dispatch|--deliver');
    if (flagBool(parsed, 'dispatch')) return advanceDispatch(await needChange(), pkg, workdir);
    if (flagBool(parsed, 'deliver')) return advanceDeliver(await needChange(), pkg);
    throw new UsageError('用法: xforge advance package <id> --dispatch|--deliver');
  }
  if (flagBool(parsed, 'archive')) return advanceArchive(await needChange());
  const target = flagString(parsed, 'rework-to');
  if (target) return advanceRework(await needChange(), target, flagString(parsed, 'reason') ?? '', workdir);
  return advanceStage(await needChange(), { noRun: flagBool(parsed, 'no-run'), workdir });
}

/** --all：项目级检查一次，再对每个未归档 Change 的每个方案各验一遍，诊断合并。 */
async function inspectAll(project: Project, hygiene: boolean): Promise<Outcome> {
  const merged = await runInspect(project, { hygiene });
  const diagnostics = [...(merged.diagnostics ?? [])];
  let checks = (merged.result as { checks: number }).checks;
  for (const id of await listOpenChanges(project.paths)) {
    for (const s of [DEFAULT_SCHEME, ...(await listSchemes(project.paths.change(id)))]) {
      const ctx = await loadChange(project, id, s);
      if (!ctx) continue;
      const one = await runInspect(ctx, { hygiene: false });
      checks += (one.result as { checks: number }).checks;
      for (const d of one.diagnostics ?? []) diagnostics.push({ ...d, message: `${id}${s === DEFAULT_SCHEME ? '' : `/${s}`}: ${d.message}` });
    }
  }
  const problems = diagnostics.filter((d) => d.severity !== 'info').length;
  const out: Outcome = { result: { checks, problems }, diagnostics };
  if (diagnostics.some((d) => d.severity === 'blocking')) out.exit = 3;
  return out;
}
