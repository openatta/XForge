import type { Diagnostic, NextAction } from '../types.js';

export class XForgeError extends Error {
  readonly diagnostics: Diagnostic[];
  readonly nextActions: NextAction[];
  readonly root: string | null;

  constructor(
    diagnostic: Diagnostic | Diagnostic[],
    options: { nextActions?: NextAction[]; root?: string | null } = {},
  ) {
    const diagnostics = Array.isArray(diagnostic) ? diagnostic : [diagnostic];
    super(diagnostics.map((item) => item.message).join('; '));
    this.name = 'XForgeError';
    this.diagnostics = diagnostics;
    this.nextActions = options.nextActions ?? [];
    this.root = options.root ?? null;
  }
}

export function diagnostic(
  code: string,
  message: string,
  path?: string,
  severity: Diagnostic['severity'] = 'error',
  details?: unknown,
): Diagnostic {
  return { code, severity, message, ...(path ? { path } : {}), ...(details === undefined ? {} : { details }) };
}
