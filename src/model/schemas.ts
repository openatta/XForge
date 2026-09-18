// design: rule-files §1 — schemas/ 随包发布，运行期按名加载，一份 ajv 实例复用。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ajvModule from 'ajv';
import type { Ajv, ValidateFunction } from 'ajv';
import formatsModule from 'ajv-formats';

// ajv 与 ajv-formats 是 CJS 包；ESM 下 default 可能是模块对象本身，也可能挂在 .default 上。
type AjvCtor = new (options?: object) => Ajv;
const AjvClass = ((ajvModule as unknown as { default?: AjvCtor }).default ?? (ajvModule as unknown as AjvCtor));
const addFormats = ((formatsModule as unknown as { default?: (a: Ajv) => void }).default ?? (formatsModule as unknown as (a: Ajv) => void));

export const SCHEMA_NAMES = [
  'manifest', 'flow', 'gate', 'policy', 'hook', 'executor', 'integrity', 'hosts',
  'baseline-domains', 'baseline-entries', 'change', 'scope', 'work-packages',
  'ledger', 'gate-run', 'receipt', 'projection', 'audit-event', 'audit-index',
  'diagnostic', 'envelope', 'upgrade-status', 'mcp-approval',
] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

export function schemasDir(): string {
  return fileURLToPath(new URL('../../schemas/', import.meta.url));
}

let ajv: Ajv | undefined;
const compiled = new Map<SchemaName, ValidateFunction>();

function instance(): Ajv {
  if (!ajv) {
    ajv = new AjvClass({ allErrors: true, strict: false });
    addFormats(ajv);
  }
  return ajv;
}

function validator(name: SchemaName): ValidateFunction {
  const cached = compiled.get(name);
  if (cached) return cached;
  const text = readFileSync(`${schemasDir()}${name}.schema.json`, 'utf8');
  const fn = instance().compile(JSON.parse(text) as object);
  compiled.set(name, fn);
  return fn;
}

export type Validation = { ok: true } | { ok: false; errors: string[] };

export function validate(name: SchemaName, data: unknown): Validation {
  const fn = validator(name);
  if (fn(data)) return { ok: true };
  const errors = (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
  return { ok: false, errors };
}
