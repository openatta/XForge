// design: cli §4 — 执法：每次工具调用读宿主载荷，回宿主格式的决策；读不出治理就拒绝；出路按动词开。
import { realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import picomatch from 'picomatch';
import { parse } from 'yaml';
import { findProjectRoot, governancePaths } from '../model/paths.js';
import { inFlightFor } from '../model/projection.js';
import type { Policy, PolicyRule, Projection, ToolAction } from '../model/types.js';
import { payloadFor, type Call, type Decision } from './payloads/index.js';

export type { Call, Decision } from './payloads/index.js';

export interface EnforceIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

const ESCAPE_ROUTE = new Set(['help', 'version', 'explain', 'state', 'show', 'inspect', 'doctor', 'init', 'sync']);

export async function enforceMain(argv: readonly string[], io: EnforceIo): Promise<number> {
  const host = (argv.includes('--host') ? argv[argv.indexOf('--host') + 1] : 'claude') ?? 'claude';
  const adapter = payloadFor(host);
  const raw = await readAll(io.stdin);
  if (!adapter) {
    // 不认得这个宿主的载荷格式：看不懂就不放行（`失败朝安全`）。回答用通用形状，至少人能读。
    io.stdout.write(JSON.stringify({ decision: 'deny', reason: `XF-ENFORCE-003 不认得宿主 ${host} 的载荷格式（失败朝安全）` }) + '\n');
    return 0;
  }
  let decision: Decision;
  try {
    decision = await decide(adapter.parse(raw, io.cwd));
  } catch (error) {
    decision = { decision: 'deny', reason: `载荷无法解析（失败朝安全）：${(error as Error).message}` };
  }
  io.stdout.write(adapter.render(decision) + '\n');
  return 0;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk.toString();
  return out;
}

export async function decide(input: Call): Promise<Decision> {
  const call: Call = { ...input, cwd: canonical(input.cwd) };
  const root = await findProjectRoot(call.cwd, process.env);
  if (!root) return { decision: 'allow', reason: '不是 XForge 项目' };
  const paths = governancePaths(root);
  const rel = call.paths.map((p) => toRel(root, call.cwd, p));

  let policies: Policy[];
  try {
    policies = await loadPolicies(paths.manifest, (n) => paths.policy(n));
  } catch (error) {
    if (call.action === 'read' || call.action === 'other') return { decision: 'allow', reason: '治理不可读，但读不改变任何东西' };
    if (call.action === 'shell' && isEscapeRoute(call.command ?? '')) return { decision: 'allow', reason: '治理不可读；这条命令是修复它的出路' };
    return { decision: 'deny', reason: `XF-ENFORCE-003 治理不可读：${(error as Error).message}。xforge inspect` };
  }

  for (const policy of policies) {
    for (const rule of policy.rules) {
      if (!rule.tools.includes(call.action as ToolAction)) continue;
      if (matchesRule(rule, call, rel, root)) {
        if (rule.effect === 'allow') continue;
        return { decision: rule.effect, reason: `${rule.effect === 'deny' ? 'XF-ENFORCE-001 ' : ''}${rule.message ?? `策略 ${policy.name} 命中`}` };
      }
    }
  }

  if ((call.action === 'write' || call.action === 'edit') && rel.length) {
    const projections = await inFlightProjections(paths.changes, call.cwd);
    if (projections.length) {
      for (const [i, p] of rel.entries()) {
        // 治理目录归分发策略管，不归投影管。
        if (p.startsWith('xforge/')) continue;
        // 投影的范围以它自己的 workdir 为基（worktree 里的方案与包，路径不在治理根之下）；写到所有在途 workdir 之外的路径不归投影管。
        const abs = canonical(isAbsolute(call.paths[i]!) ? call.paths[i]! : resolve(call.cwd, call.paths[i]!));
        for (const pr of projections) {
          const inWorkdir = relative(canonical(pr.workdir), abs);
          if (!inWorkdir || inWorkdir.startsWith('..') || isAbsolute(inWorkdir)) continue;
          if (!picomatch(pr.allow)(inWorkdir)) return { decision: 'deny', reason: `XF-ENFORCE-002 ${inWorkdir} 不在在途投影策略允许的路径里（${pr.execution}）。xforge state` };
        }
      }
    }
  }
  return { decision: 'allow', reason: '' };
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function toRel(root: string, cwd: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  return relative(root, abs).split('\\').join('/');
}

function isEscapeRoute(command: string): boolean {
  const words = command.trim().split(/\s+/);
  return words[0] === 'xforge' && ESCAPE_ROUTE.has(words[1] ?? '');
}

// 命令行层面的写入迹象：重定向、就地编辑、文件系统动作、会改工作树的 git 子命令。
const SHELL_WRITE = /(^|[\s;&|(])(>>?|tee|sed\s+-i|rm|mv|cp|mkdir|touch|truncate|chmod|chown|ln|dd|install|patch|git\s+(checkout|reset|clean|restore|rm|mv))(\s|$)/;
// 解释器代码里的写入迹象：解释器本身不算写，只有它的代码在写文件时才算。
const CODE_WRITE = /open\s*\([^)]*['"][rwax+]*[wax][rwax+]*['"]|write_text|write_bytes|writeFile|appendFile|\.write\s*\(|unlink|os\.remove|os\.rename|rmtree|shutil\.(copy|move)|fs\.(rm|rename|mkdir|cp)/;
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g;
const PATH_TOKEN = /(?:\.{0,2}\/)?[\w@./*+-]*xforge\/[\w@./*+-]*/g;

/** 去掉 heredoc 正文：正文是数据，不是命令。 */
function commandLineOnly(command: string): string {
  return command.replace(HEREDOC, '<<heredoc');
}

/** shell 命令算不算写：命令行有写入迹象，或它喂给解释器的代码在写文件。 */
export function shellWrites(command: string): boolean {
  return SHELL_WRITE.test(commandLineOnly(command)) || CODE_WRITE.test(command);
}

/** 按 ; && || | 与换行切成段：一段里的路径只归这一段的动作，读一段、写一段不互相沾。 */
export function commandSegments(commandLine: string): string[] {
  return commandLine.split(/\s*(?:;|&&|\|\||\||\n)\s*/).filter((s) => s.trim().length);
}

/**
 * 写入目标：命令行里带写入迹象的那些段提到的治理路径，加上解释器代码里带写文件调用的那些行提到的路径。
 * 一条命令里读一段、写一段，或者代码里写完文件再 grep 一个治理文件，都不互相沾。
 */
export function writtenGovernedPaths(command: string, root: string, cwd: string): string[] {
  const out = new Set<string>();
  for (const seg of commandSegments(commandLineOnly(command))) {
    if (!SHELL_WRITE.test(seg)) continue;
    for (const p of governedPathsIn(seg, root, cwd, false)) out.add(p);
  }
  for (const line of command.split('\n')) {
    if (!CODE_WRITE.test(line)) continue;
    for (const p of governedPathsIn(line, root, cwd, true)) out.add(p);
  }
  return [...out];
}

/**
 * 抽出命令里提到的治理路径（相对项目根）。默认只看命令行本身：heredoc 正文是数据。
 * 但喂给解释器的代码在写文件时，路径就在那段代码里，这时整条命令都要看。
 */
export function governedPathsIn(command: string, root: string, cwd: string, includeBodies = false): string[] {
  const out = new Set<string>();
  const text = includeBodies ? command : commandLineOnly(command);
  for (const m of text.matchAll(PATH_TOKEN)) {
    const token = m[0].replace(/[;,)'"`]+$/, '');
    if (!token) continue;
    out.add(toRel(root, cwd, token));
  }
  return [...out];
}

function staticPrefix(glob: string): string {
  const i = glob.search(/[*?[{]/);
  return i === -1 ? glob : glob.slice(0, i);
}

function matchesRule(rule: PolicyRule, call: Call, rel: readonly string[], root: string): boolean {
  if (rule.paths?.length) {
    if (call.action === 'shell') {
      const cmd = call.command ?? '';
      if (!shellWrites(cmd)) return false;
      const m = picomatch(rule.paths);
      for (const p of writtenGovernedPaths(cmd, root, call.cwd)) {
        if (!/[*?[{]/.test(p)) {
          if (m(p)) return true;
          continue;
        }
        const pre = staticPrefix(p);
        if (rule.paths.some((g) => staticPrefix(g).startsWith(pre) || pre.startsWith(staticPrefix(g)))) return true;
      }
    } else {
      const m = picomatch(rule.paths);
      if (rel.some((p) => m(p))) return true;
    }
  }
  if (rule.commands?.length && call.action === 'shell') {
    const cmd = call.command ?? '';
    return rule.commands.some((c) => cmd.includes(c));
  }
  return false;
}

/** 只做最小结构检查，不引 ajv：执法要快。 */
async function loadPolicies(manifestPath: string, policyPath: (name: string) => string): Promise<Policy[]> {
  const manifest = parse(await readFile(manifestPath, 'utf8')) as { selected?: { policies?: unknown } } | null;
  const names = manifest?.selected?.policies;
  if (!Array.isArray(names)) throw new Error('清单没有 selected.policies');
  const out: Policy[] = [];
  for (const name of names) {
    if (typeof name !== 'string') throw new Error('selected.policies 里有非字符串');
    const policy = parse(await readFile(policyPath(name), 'utf8')) as Policy | null;
    if (!policy || !Array.isArray(policy.rules)) throw new Error(`策略 ${name} 没有 rules`);
    for (const r of policy.rules) {
      if (!['deny', 'ask', 'allow'].includes(r.effect) || !Array.isArray(r.tools)) throw new Error(`策略 ${name} 的规则不合法`);
    }
    out.push(policy);
  }
  return out;
}

async function inFlightProjections(changesDir: string, cwd: string): Promise<Projection[]> {
  let changes: string[];
  try {
    changes = (await readdir(changesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const all: Projection[] = [];
  for (const c of changes) {
    // 默认方案的投影在 Change 根下，具名方案的在各自子目录下；不引 ids 模块，用同一条形状规则内联。
    const dirs = [join(changesDir, c)];
    try {
      for (const d of await readdir(join(changesDir, c), { withFileTypes: true })) {
        if (d.isDirectory() && /^[a-z][a-z0-9-]*$/.test(d.name) && !['specs', 'interfaces', 'ledgers', 'evidence', 'default'].includes(d.name)) dirs.push(join(changesDir, c, d.name));
      }
    } catch {
      continue;
    }
    for (const base of dirs) {
      const dir = join(base, 'evidence', 'projections');
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.yaml'));
      } catch {
        continue;
      }
      for (const f of files) {
        const p = parse(await readFile(join(dir, f), 'utf8')) as Projection | null;
        if (p && Array.isArray(p.allow) && typeof p.workdir === 'string') all.push(p);
      }
    }
  }
  return inFlightFor(all, cwd);
}

