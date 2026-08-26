import { readFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { XForgeError, diagnostic } from './errors.js';

export async function loadYaml<T>(filePath: string, projectPath?: string): Promise<T> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new XForgeError(diagnostic('XFORGE_FILE_MISSING', `Required file is missing: ${projectPath ?? filePath}`, projectPath ?? filePath));
    }
    throw error;
  }

  try {
    const value = parse(source, { strict: true, uniqueKeys: true }) as T;
    if (!value || typeof value !== 'object') throw new Error('Document must be an object');
    return value;
  } catch (error) {
    throw new XForgeError(diagnostic(
      'XFORGE_YAML_INVALID',
      `Invalid YAML: ${(error as Error).message}`,
      projectPath ?? filePath,
    ));
  }
}

/**
 * A YAML value read as a trimmed string, or the empty string for anything that is not one.
 *
 * Every governance ledger this product reads is Agent-authored YAML, so a field is `unknown` until
 * something coerces it, and "absent", "null", "a number" and "  " all have to collapse to the same
 * answer before any rule can be written against them. The three ledger evaluators each defined this
 * identically before it lived here; that they agreed was luck, not design.
 */
export function trimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function dumpYaml(value: unknown): string {
  return stringify(value, { sortMapEntries: true, lineWidth: 120 });
}
