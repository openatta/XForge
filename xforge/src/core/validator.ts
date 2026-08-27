import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { Diagnostic } from '../types.js';
import { diagnostic } from './errors.js';

/**
 * Every file format this product validates, in one list.
 *
 * The names were written twice — once as a type union and once as the array `buildValidators`
 * iterates — with nothing keeping them in step. A name in the union and not the array compiled no
 * validator and threw at the first document that used it; a name in the array and not the union
 * could not be passed to `validateSchema` at all. Deriving the type from the array leaves one place
 * to add a format, which is also what `test/integration/governed-formats.test.ts` reads to record
 * what enforces each one.
 */
export const SCHEMA_NAMES = [
  'manifest', 'lock', 'flow', 'change', 'agent', 'gate', 'rule', 'permission-policy', 'hook',
  'approval-receipt', 'transition-receipt', 'audit-event', 'script', 'scaffold', 'work-package',
  'work-package-delivery', 'work-package-dispatch', 'work-package-ack-receipt', 'review-ack-receipt',
  'mcp-server',
] as const;

export type SchemaName = typeof SCHEMA_NAMES[number];

/* See identity.ts's packageRoot comment: fileURLToPath, not .pathname + path.resolve, for Windows. */
const schemaRoot = path.resolve(fileURLToPath(new URL('../../schemas', import.meta.url)));
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
  const result = new Map<SchemaName, ValidateFunction>();
  for (const name of SCHEMA_NAMES) {
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
