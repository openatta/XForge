// design: rule-files §1.1 §2 — RF-03：写权限矩阵里每个「拒」在分发策略里都有一条 deny；MG-07：legacy/ 已删除。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import { parse } from 'yaml';
import type { Policy } from '../../src/model/types.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('protected-governance policy', () => {
  const policy = parse(readFileSync(join(root, 'scaffold', 'policies', 'protected-governance.yaml'), 'utf8')) as Policy;
  const denies = policy.rules.filter((r) => r.effect === 'deny' && r.paths?.length).flatMap((r) => r.paths!);
  const denied = picomatch(denies);
  it('RF-03 every cell the write matrix marks 拒 for the Agent is denied for write/edit/shell', () => {
    const mustDeny = [
      'xforge/manifest.yaml', 'xforge/constitution.md', 'xforge/scaffold/flows/solid.yaml', 'xforge/scaffold/skills/xforge/SKILL_cn.md',
      'xforge/specs/index.yaml', 'xforge/specs/billing/invoices.md', 'xforge/interfaces/x/index.yaml',
      'xforge/changes/C-1/evidence/receipts/0001-stage-transition.yaml', 'xforge/changes/C-1/evidence/gates/unit-tests/1.log',
      'xforge/changes/C-1/evidence/projections/EX-1.yaml', 'xforge/changes/C-1/evidence/audit-index.yaml', 'xforge/.audit/chain.jsonl',
    ];
    for (const p of mustDeny) expect(denied(p), `${p} should be denied`).toBe(true);
    const rule = policy.rules.find((r) => r.effect === 'deny' && r.paths?.length)!;
    expect(new Set(rule.tools)).toEqual(new Set(['write', 'edit', 'shell']));
  });
  it('RF-03 what the Agent may write is not denied', () => {
    for (const p of ['xforge/changes/C-1/change.yaml', 'xforge/changes/C-1/proposal.md', 'xforge/changes/C-1/specs/billing/x.md', 'xforge/changes/C-1/ledgers/review-findings.yaml', 'xforge/changes/C-1/ledgers/deliveries/P-01.yaml', 'src/a.ts']) {
      expect(denied(p), `${p} should be allowed`).toBe(false);
    }
  });
});

describe('legacy/', () => {
  it('MG-07 the archived 0.8.6 line is gone from this branch', () => {
    expect(existsSync(join(root, 'legacy'))).toBe(false);
  });
});
