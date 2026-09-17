// design: rule-files §6 — 诊断码字典随 CLI 包发布，按码一文件。
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readYaml } from './yaml.js';
import type { Diagnostic } from './types.js';

export const CODE = /^XF-(MODEL|STATE|INSPECT|RUN|ATTEST|ADVANCE|ENFORCE|ASSEMBLE)-\d{3}$/;

export function diagnosticsDir(): string {
  return fileURLToPath(new URL('../../diagnostics/', import.meta.url));
}

export async function loadDiagnostic(code: string, dir = diagnosticsDir()): Promise<Diagnostic | null> {
  if (!CODE.test(code)) return null;
  try {
    return await readYaml<Diagnostic>(`${dir}${code}.yaml`, 'diagnostic');
  } catch {
    return null;
  }
}

export async function listDiagnosticCodes(dir = diagnosticsDir()): Promise<string[]> {
  const files = await readdir(dir);
  return files.filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).sort();
}
