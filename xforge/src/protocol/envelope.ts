import { PROTOCOL_VERSION } from '../constants.js';
import type { Diagnostic, Envelope, FileChange, NextAction } from '../types.js';

export function envelope<T>(input: {
  command: string;
  root: string | null;
  data?: T | null;
  diagnostics?: Diagnostic[];
  changes?: FileChange[];
  nextActions?: NextAction[];
  ok?: boolean;
}): Envelope<T> {
  const diagnostics = input.diagnostics ?? [];
  const ok = input.ok ?? !diagnostics.some((item) => item.severity === 'error');
  return {
    protocolVersion: PROTOCOL_VERSION,
    ok,
    command: input.command,
    root: input.root,
    data: input.data ?? null,
    diagnostics,
    changes: input.changes ?? [],
    nextActions: input.nextActions ?? [],
  };
}

function disabledHookNames(data: unknown): string[] {
  const hooks = (data as { resources?: { hooks?: unknown } } | null)?.resources?.hooks;
  if (!Array.isArray(hooks)) return [];
  return hooks
    .filter((hook): hook is { id: string; enabled: boolean } =>
      Boolean(hook) && typeof hook === 'object' && 'enabled' in (hook as Record<string, unknown>) && (hook as { enabled: unknown }).enabled === false)
    .map((hook) => hook.id);
}

/**
 * `render` replaces the JSON dump of `data` for commands whose whole purpose is to be read by a
 * person — `state`, whose value disappears if it arrives as a wall of JSON; `upgrade-scaffold`,
 * whose plan is the output; and `state`, whose `data` is the entire resolved project and printed
 * as JSON buries the `Next actions:` block below it. Everything else about the text form is
 * unchanged, so `--text` still alters presentation only: the same Envelope, the same diagnostics,
 * the same exit code. A renderer must therefore never be the only place a fact appears, and must
 * say what it left out — machine callers read the JSON envelope or `--field`, never this.
 */
export function present(result: Envelope, textMode: boolean, render?: (data: unknown) => string): string {
  if (!textMode) return `${JSON.stringify(result)}\n`;

  const lines = [
    `XForge ${result.command}: ${result.ok ? 'OK' : 'FAILED'}`,
    `Protocol: ${result.protocolVersion}`,
    `Root: ${result.root ?? '(not found)'}`,
    render && result.data !== null ? render(result.data) : `Data: ${JSON.stringify(result.data, null, 2)}`,
  ];
  const disabledHooks = disabledHookNames(result.data);
  if (disabledHooks.length > 0) {
    lines.push(`Note: Hook(s) selected but disabled — they will not run until a project explicitly enables and trusts them: ${disabledHooks.join(', ')}`);
  }
  lines.push(
    `Diagnostics: ${JSON.stringify(result.diagnostics, null, 2)}`,
    `Changes: ${JSON.stringify(result.changes, null, 2)}`,
    `Next actions: ${JSON.stringify(result.nextActions, null, 2)}`,
  );
  return `${lines.join('\n')}\n`;
}
