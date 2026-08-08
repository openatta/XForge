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

export function dumpYaml(value: unknown): string {
  return stringify(value, { sortMapEntries: true, lineWidth: 120 });
}
