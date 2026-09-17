// design: rule-files §6 — 诊断码是模型层错误的唯一出口。
export class ModelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ModelError';
  }
}
