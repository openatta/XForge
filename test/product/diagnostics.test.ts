// design: rule-files §6 — RF-27（码与字典双向一致）、RF-28（remedy 是本 CLI 的调用）。
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { validate } from '../../src/model/schemas.js';
import type { Diagnostic } from '../../src/model/types.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE = /XF-(?:MODEL|STATE|INSPECT|RUN|ATTEST|ADVANCE|ENFORCE|ASSEMBLE|DOCTOR|REPAIR)-\d{3}/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function codesIn(files: string[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(CODE)) out.add(m[0]);
  return out;
}

const dictFiles = readdirSync(join(root, 'diagnostics')).filter((f) => f.endsWith('.yaml'));
const dictCodes = new Set(dictFiles.map((f) => f.slice(0, -5)));

describe('diagnostics dictionary', () => {
  it('every file validates and is named after its code', () => {
    for (const f of dictFiles) {
      const data = parse(readFileSync(join(root, 'diagnostics', f), 'utf8')) as Diagnostic;
      expect(validate('diagnostic', data), f).toEqual({ ok: true });
      expect(`${data.code}.yaml`).toBe(f);
    }
  });

  it('RF-27 every code used in src/ or the design has a dictionary file', () => {
    const used = codesIn([...walk(join(root, 'src')), ...walk(join(root, 'docs', 'design'))]);
    for (const code of used) expect(dictCodes.has(code), `${code} has no dictionary file`).toBe(true);
  });

  it('RF-27 every dictionary file is referenced by src/ or the design', () => {
    const used = codesIn([...walk(join(root, 'src')), ...walk(join(root, 'docs', 'design'))]);
    for (const code of dictCodes) expect(used.has(code), `${code} is defined but never used`).toBe(true);
  });

  it('RF-28 a remedy command is a call to this CLI', () => {
    for (const f of dictFiles) {
      const data = parse(readFileSync(join(root, 'diagnostics', f), 'utf8')) as Diagnostic;
      if (data.remedy.command) expect(data.remedy.command, f).toMatch(/^xforge(?:-enforce)?(?: |$)/);
    }
  });
});
