// design: cli §1.1 — 命令层错误：一个诊断码、一个退出码、一条出路；用法错误不进信封。
import type { EnvelopeDiagnostic } from '../model/types.js';

export type ExitCode = 0 | 1 | 2 | 3;

export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exit: ExitCode,
    public readonly remedy?: { command?: string; text: string },
    public readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'CliError';
  }

  toDiagnostic(): EnvelopeDiagnostic {
    const d: EnvelopeDiagnostic = {
      code: this.code,
      severity: 'blocking',
      message: this.details.length ? `${this.message}：${this.details.join('；')}` : this.message,
    };
    if (this.remedy) d.remedy = this.remedy;
    return d;
  }
}

/** 退出码 2：参数不对。写 stderr，不写信封。 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
