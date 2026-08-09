import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { Diagnostic } from '../types.js';
import { diagnostic } from './errors.js';

export type SchemaName = 'manifest' | 'lock' | 'flow' | 'change' | 'agent' | 'gate' | 'rule' | 'permission-policy' | 'hook' | 'approval-receipt' | 'transition-receipt' | 'audit-event' | 'script' | 'scaffold' | 'work-package' | 'work-package-delivery' | 'work-package-dispatch';

const schemaRoot = path.resolve(new URL('../../schemas', import.meta.url).pathname);
let validatorsPromise: Promise<Map<SchemaName, ValidateFunction>> | null = null;

function formatErrors(errors: ErrorObject[] | null | undefined, filePath: string): Diagnostic[] {
  return (errors ?? []).map((error) => diagnostic(
    'XFORGE_SCHEMA_INVALID',
    `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
    filePath,
    'error',
    { keyword: error.keyword, params: error.params, schemaPath: error.schemaPath },
  ));
}

async function buildValidators(): Promise<Map<SchemaName, ValidateFunction>> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => Ajv2020;
  addFormats(ajv);
  const names: SchemaName[] = ['manifest', 'lock', 'flow', 'change', 'agent', 'gate', 'rule', 'permission-policy', 'hook', 'approval-receipt', 'transition-receipt', 'audit-event', 'script', 'scaffold', 'work-package', 'work-package-delivery', 'work-package-dispatch'];
  const result = new Map<SchemaName, ValidateFunction>();
  for (const name of names) {
    const schema = JSON.parse(await readFile(path.join(schemaRoot, `${name}.schema.json`), 'utf8')) as object;
    result.set(name, ajv.compile(schema));
  }
  return result;
}

export async function validateSchema(name: SchemaName, value: unknown, filePath: string): Promise<Diagnostic[]> {
  validatorsPromise ??= buildValidators();
  const validator = (await validatorsPromise).get(name);
  if (!validator) throw new Error(`Schema validator missing: ${name}`);
  return validator(value) ? [] : formatErrors(validator.errors, filePath);
}
