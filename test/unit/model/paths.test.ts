// design: rule-files §1 — RF-01、RF-02，以及治理根的查找。
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { findProjectRoot, governancePaths, ledgerPath } from '../../../src/model/paths.js';

describe('governancePaths (RF-01)', () => {
  const p = governancePaths('/proj');
  const c = p.change('C-20260915-x');
  it('generates every designed path', () => {
    expect(relative('/proj', p.manifest)).toBe('xforge/manifest.yaml');
    expect(relative('/proj', p.flow('solid'))).toBe('xforge/scaffold/flows/solid.yaml');
    expect(relative('/proj', p.skill('xforge-design', 'zh-CN'))).toBe('xforge/scaffold/skills/xforge-design/SKILL_cn.md');
    expect(relative('/proj', p.specsDomainIndex('auth'))).toBe('xforge/specs/auth/index.yaml');
    expect(relative('/proj', c.declaration)).toBe('xforge/changes/C-20260915-x/change.yaml');
    expect(relative('/proj', c.ledger('exit/material-questions'))).toBe('xforge/changes/C-20260915-x/ledgers/exit/material-questions.yaml');
    expect(relative('/proj', c.receipt(9, 'package-dispatch'))).toBe('xforge/changes/C-20260915-x/evidence/receipts/0009-package-dispatch.yaml');
    expect(relative('/proj', c.projection('EX-20260915-a7k2q9'))).toBe('xforge/changes/C-20260915-x/evidence/projections/EX-20260915-a7k2q9.yaml');
    expect(relative('/proj', p.auditChain)).toBe('xforge/.audit/chain.jsonl');
  });
  it('RF-02 keeps the assertion layer and the evidence layer in different directories', () => {
    expect(c.ledgersDir).not.toBe(c.evidenceDir);
    expect(c.ledger('review-findings').startsWith(c.ledgersDir)).toBe(true);
    expect(c.gateRun('structure', 1).startsWith(c.evidenceDir)).toBe(true);
  });
  it('a named scheme lives in a sub-directory; the default scheme does not', () => {
    expect(relative('/proj', p.change('C-20260915-x', 'test').scope)).toBe('xforge/changes/C-20260915-x/test/scope.yaml');
    expect(relative('/proj', c.scope)).toBe('xforge/changes/C-20260915-x/scope.yaml');
  });
  it('delivery ledgers are per package', () => {
    expect(ledgerPath('/l', 'delivery', 'P-01')).toBe('/l/deliveries/P-01.yaml');
    expect(() => ledgerPath('/l', 'delivery')).toThrow();
    expect(() => ledgerPath('/l', 'nope')).toThrow();
  });
});

describe('findProjectRoot', () => {
  it('walks up to the directory holding xforge/manifest.yaml', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xforge-'));
    await mkdir(join(root, 'xforge'), { recursive: true });
    await writeFile(join(root, 'xforge', 'manifest.yaml'), 'version: 1\n');
    await mkdir(join(root, 'src', 'deep'), { recursive: true });
    expect(await findProjectRoot(join(root, 'src', 'deep'))).toBe(root);
    expect(await findProjectRoot(tmpdir())).toBeNull();
  });
});
