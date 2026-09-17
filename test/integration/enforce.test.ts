// design: cli §4 — CLI-19（三种坏输入都拒绝）、§4.1 出路、CLI-21（纯函数）；冷启动延迟只报不阻塞。
import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Project, repoRoot } from '../helpers/project.js';

describe('xforge-enforce', () => {
  let p: Project;
  beforeAll(async () => {
    p = await Project.create('enforce');
    await p.write('package.json', '{"name":"e"}\n');
    p.commit('seed');
    await p.xforge('init', '--flow', 'quick');
  });

  it('allows reads, allows writes outside governance with no projection in flight, denies evidence', async () => {
    expect((await p.enforce({ tool_name: 'Read', tool_input: { file_path: join(p.root, 'xforge', 'manifest.yaml') }, cwd: p.root })).decision).toBe('allow');
    expect((await p.enforce({ tool_name: 'Write', tool_input: { file_path: join(p.root, 'src', 'a.ts') }, cwd: p.root })).decision).toBe('allow');
    const evidence = await p.enforce({ tool_name: 'Edit', tool_input: { file_path: join(p.root, 'xforge', 'changes', 'C-1', 'evidence', 'x.yaml') }, cwd: p.root });
    expect(evidence.decision).toBe('deny');
    expect(evidence.reason).toContain('XF-ENFORCE-001');
    expect((await p.enforce({ tool_name: 'Bash', tool_input: { command: 'echo hi > xforge/.audit/chain.jsonl' }, cwd: p.root })).decision).toBe('deny');
    expect((await p.enforce({ tool_name: 'Bash', tool_input: { command: 'git reset --hard' }, cwd: p.root })).decision).toBe('deny');
  });

  it('shell reads of governed paths are allowed; only writes are matched, by glob', async () => {
    const allow = async (command: string): Promise<string> => (await p.enforce({ tool_name: 'Bash', tool_input: { command }, cwd: p.root })).decision;
    expect(await allow('cat xforge/changes/C-1/evidence/gates/unit-tests/1.log')).toBe('allow');
    expect(await allow('tail -5 xforge/.audit/chain.jsonl; ls xforge/changes/*/ledgers')).toBe('allow');
    expect(await allow('xforge show ledger:verification-receipt | head -60')).toBe('allow');
    expect(await allow("cat > xforge/changes/C-1/ledgers/deliveries/P-01.yaml <<'EOF'\nkind: delivery\nEOF")).toBe('allow');
    expect(await allow("sed -i '' 's/a/b/' xforge/changes/C-1/ledgers/review-findings.yaml")).toBe('allow');
    expect(await allow("sed -i '' 's/a/b/' xforge/manifest.yaml")).toBe('deny');
    expect(await allow('cp x.yaml xforge/changes/C-1/evidence/receipts/0001-stage-transition.yaml')).toBe('deny');
    expect(await allow('python3 - <<EOF\nopen("xforge/specs/index.yaml","w")\nEOF')).toBe('deny');
    expect(await allow('rm -rf xforge/changes/*/evidence')).toBe('deny');
  });

  it('interpreters that only read are reads; heredoc bodies are data, not targets', async () => {
    const allow = async (command: string): Promise<string> => (await p.enforce({ tool_name: 'Bash', tool_input: { command }, cwd: p.root })).decision;
    expect(await allow("python3 - <<'EOF'\nimport json\nfor l in open('xforge/.audit/chain.jsonl'): print(json.loads(l)['kind'])\nEOF")).toBe('allow');
    expect(await allow("tail -12 xforge/.audit/chain.jsonl | python3 -c 'import sys,json; [print(json.loads(l)[\"kind\"]) for l in sys.stdin]'")).toBe('allow');
    expect(await allow("node -e 'console.log(require(\"fs\").readFileSync(\"xforge/manifest.yaml\",\"utf8\").length)'")).toBe('allow');
    expect(await allow("find xforge/specs -type f -exec sh -c 'cat \"$1\"' _ {} \\;")).toBe('allow');
    expect(await allow("cat > /tmp/brief.md <<'EOF'\n看 xforge/changes/C-1/evidence/receipts/0001-stage-transition.yaml\nEOF")).toBe('allow');
    expect(await allow("python3 - <<'EOF'\nopen('xforge/specs/index.yaml','w').write('x')\nEOF")).toBe('deny');
    expect(await allow("node -e 'require(\"fs\").writeFileSync(\"xforge/manifest.yaml\",\"\")'")).toBe('deny');
  });

  it('a read of evidence in one segment does not turn a ledger write in the next into a violation', async () => {
    const allow = async (command: string): Promise<string> => (await p.enforce({ tool_name: 'Bash', tool_input: { command }, cwd: p.root })).decision;
    expect(await allow("tail -3 xforge/changes/C-1/evidence/gates/unit-tests/2.log; cat > xforge/changes/C-1/ledgers/deliveries/P-02.yaml <<EOF\nkind: delivery\nEOF")).toBe('allow');
    expect(await allow("f=xforge/changes/C-1/ledgers/verification-receipt.yaml && sed -i '' 's#3.yaml#4.yaml#' $f && xforge run --gate ledgers && ls xforge/changes/C-1/evidence/gates")).toBe('allow');
    expect(await allow("cat xforge/changes/C-1/ledgers/review-findings.yaml && cp x.yaml xforge/changes/C-1/evidence/receipts/0001.yaml")).toBe('deny');
    // 代码写的是源码文件，末尾顺手 grep 了清单：清单不是写入目标。
    expect(await allow("python3 - <<'EOF'\np='invoicely/core.py'; s=open(p).read()\nopen(p,'w').write(s)\nEOF\npython3 -m unittest 2>&1 | tail -3; grep -n unit-tests -A3 xforge/manifest.yaml")).toBe('allow');
    expect(await allow("python3 - <<'EOF'\nopen('xforge/specs/index.yaml','w').write('x')\nEOF\ngrep x xforge/manifest.yaml")).toBe('deny');
  });

  it('is a pure function of the payload', async () => {
    const payload = { tool_name: 'Write', tool_input: { file_path: join(p.root, 'src', 'a.ts') }, cwd: p.root };
    expect(await p.enforce(payload)).toEqual(await p.enforce(payload));
  });

  it('CLI-19 denies on an empty payload, a broken manifest and a missing policy file, but keeps the escape route open', async () => {
    const raw = await rawEnforce(p.root, '');
    expect(raw).toContain('"permissionDecision":"deny"');
    const manifestPath = join(p.root, 'xforge', 'manifest.yaml');
    const good = await (await import('node:fs/promises')).readFile(manifestPath, 'utf8');
    await writeFile(manifestPath, 'selected: [not, a, map\n');
    expect((await p.enforce({ tool_name: 'Write', tool_input: { file_path: join(p.root, 'src', 'a.ts') }, cwd: p.root })).reason).toContain('XF-ENFORCE-003');
    expect((await p.enforce({ tool_name: 'Read', tool_input: { file_path: join(p.root, 'src', 'a.ts') }, cwd: p.root })).decision).toBe('allow');
    expect((await p.enforce({ tool_name: 'Bash', tool_input: { command: 'xforge inspect' }, cwd: p.root })).decision).toBe('allow');
    expect((await p.enforce({ tool_name: 'Bash', tool_input: { command: 'xforge advance' }, cwd: p.root })).decision).toBe('deny');
    await writeFile(manifestPath, good.replace('protected-governance', 'missing-policy'));
    expect((await p.enforce({ tool_name: 'Write', tool_input: { file_path: join(p.root, 'src', 'a.ts') }, cwd: p.root })).decision).toBe('deny');
    await writeFile(manifestPath, good);
  });

  it('CLI-20 cold start to decision (reported, not enforced)', async () => {
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(p.root, 'src', 'a.ts') }, cwd: p.root });
    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      await rawEnforce(p.root, payload);
      samples.push(performance.now() - t0);
    }
    const median = samples.sort((a, b) => a - b)[2]!;
    // eslint-disable-next-line no-console
    console.log(`xforge-enforce cold start median: ${median.toFixed(0)} ms (target < 80 ms)`);
    expect(median).toBeGreaterThan(0);
  });
});

function rawEnforce(cwd: string, stdin: string): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile('node', [join(repoRoot, 'bin', 'xforge-enforce.js'), '--host', 'claude'], { cwd });
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', () => resolve(out));
    child.stdin!.end(stdin);
  });
}
