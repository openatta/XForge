// design: cli §1.1 — 一个信封：成功与否、结果、诊断、改动了哪些文件、下一步可以做什么。
import type { Envelope, EnvelopeDiagnostic } from '../model/types.js';
import type { ExitCode } from './errors.js';

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 只有 init 的交互用得上；没有它就一律非交互（命令行设计 D15）。 */
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (on: boolean) => void };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream;
}

export interface Outcome<R = unknown> {
  result: R;
  diagnostics?: EnvelopeDiagnostic[];
  changed?: string[];
  next?: Array<{ command: string; why: string }>;
  change?: string;
  scheme?: string;
  /** 退出码 3 由调用方显式指定（损坏 / 治理不可读）；否则由 diagnostics 推出。 */
  exit?: ExitCode;
}

export function envelope<R>(verb: string, o: Outcome<R>): { env: Envelope<R>; exit: ExitCode } {
  const diagnostics = o.diagnostics ?? [];
  const ok = !diagnostics.some((d) => d.severity === 'blocking');
  const env: Envelope<R> = { ok, verb, result: o.result, diagnostics, changed: o.changed ?? [], next: (o.next ?? []).slice(0, 3) };
  if (o.change) env.change = o.change;
  if (o.scheme) env.scheme = o.scheme;
  const exit: ExitCode = o.exit ?? (ok ? 0 : 1);
  return { env, exit };
}

export function pickField(env: Envelope, path: string): unknown {
  let cur: unknown = env;
  for (const part of path.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

/** --text：给人看的呈现；语义与退出码不变。 */
export function renderText(env: Envelope): string {
  const lines: string[] = [];
  lines.push(`${env.ok ? 'ok' : 'blocked'} · ${env.verb}${env.change ? ` · ${env.change}` : ''}`);
  for (const d of env.diagnostics) {
    lines.push(`  [${d.severity}] ${d.code} ${d.message}`);
    if (d.remedy?.command) lines.push(`      → ${d.remedy.command}`);
    else if (d.remedy?.text) lines.push(`      → ${d.remedy.text}`);
  }
  if (env.result !== undefined && env.result !== null && Object.keys(env.result as object).length) {
    lines.push(JSON.stringify(env.result, null, 2));
  }
  if (env.changed.length) lines.push(`changed: ${env.changed.join(', ')}`);
  for (const n of env.next) lines.push(`next: ${n.command}  # ${n.why}`);
  return lines.join('\n') + '\n';
}

export function emit(io: Io, env: Envelope, opts: { text: boolean; field?: string }): void {
  if (opts.field) {
    io.stdout.write(JSON.stringify(pickField(env, opts.field) ?? null) + '\n'); // 没有这一段就是 null，不是字面 undefined
    return;
  }
  io.stdout.write(opts.text ? renderText(env) : JSON.stringify(env) + '\n');
}
