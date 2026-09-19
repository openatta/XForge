// design: migration §1 — MG-01 … MG-06 的布局断言。
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const EXPECTED_SRC_DIRS = [
  'cli', 'verbs', 'assemble', 'enforce', 'meta', 'model', 'machines',
  'gates', 'baselines', 'audit', 'projection', 'providers', 'fs', 'mcp',
].sort();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function tsFiles(dir: string): string[] {
  return walk(dir).filter((f) => f.endsWith('.ts'));
}

/** 静态 import 闭包（只跟相对导入）。 */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      let target = resolve(dirname(file), m[1]!.replace(/\.js$/, '.ts'));
      if (!target.endsWith('.ts')) target += '.ts';
      stack.push(target);
    }
  }
  return seen;
}

const designHeadings = new Map<string, Set<string>>();
for (const name of ['migration', 'rule-files', 'cli', 'skills']) {
  const text = readFileSync(join(root, 'docs', 'design', `${name}.md`), 'utf8');
  const heads = new Set<string>();
  for (const m of text.matchAll(/^#{2,4}\s+(\d+(?:\.\d+)?)/gm)) heads.add(m[1]!);
  designHeadings.set(name, heads);
}

describe('repository layout (migration §1)', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { bin: Record<string, string>; files: string[] };

  it('MG-01 bin entries point at bin/', () => {
    expect(pkg.bin.xforge).toBe('bin/xforge.js');
    expect(pkg.bin['xforge-enforce']).toBe('bin/xforge-enforce.js');
  });

  it('MG-02 src/ has exactly the fourteen designed directories', () => {
    const dirs = readdirSync(join(root, 'src')).filter((d) => statSync(join(root, 'src', d)).isDirectory()).sort();
    expect(dirs).toEqual(EXPECTED_SRC_DIRS);
  });

  it('MG-03 the enforcement entry never imports the workflow plane', () => {
    const closure = importClosure(join(root, 'src', 'enforce', 'index.ts'));
    const forbidden = ['verbs', 'assemble', 'providers', 'gates', 'baselines'].map((d) => join(root, 'src', d) + '/');
    for (const file of closure) {
      for (const dir of forbidden) expect(file.startsWith(dir), `${file} reachable from enforce`).toBe(false);
    }
  });

  it('MG-04 npm pack ships only the designed entries', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
    const files = (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
    const allowed = new Set(['bin', 'dist', 'schemas', 'scaffold', 'diagnostics', 'README.md', 'LICENSE', 'NOTICE', 'package.json']);
    for (const f of files) expect(allowed.has(f.split('/')[0]!), `unexpected packed file ${f}`).toBe(true);
    expect(files.some((f) => f.startsWith('legacy/'))).toBe(false);
  });

  it('MG-05 nothing in src/ or test/ reaches into legacy/', () => {
    const reaches = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*legacy\//;
    for (const file of [...tsFiles(join(root, 'src')), ...tsFiles(join(root, 'test'))]) {
      expect(reaches.test(readFileSync(file, 'utf8')), `${file} imports from legacy/`).toBe(false);
    }
    const tsconfig = readFileSync(join(root, 'tsconfig.json'), 'utf8');
    expect(tsconfig.includes('legacy')).toBe(false);
    expect(pkg.files.includes('legacy')).toBe(false);
  });

  it('MG-06 every source file starts with a design pointer to an existing section', () => {
    for (const file of tsFiles(join(root, 'src'))) {
      const first = readFileSync(file, 'utf8').split('\n')[0] ?? '';
      const m = /^\/\/ design: (migration|rule-files|cli|skills) §(\d+(?:\.\d+)?)/.exec(first);
      expect(m, `${file} has no design pointer`).not.toBeNull();
      expect(designHeadings.get(m![1]!)!.has(m![2]!), `${file} points at missing section ${m![1]} §${m![2]}`).toBe(true);
    }
  });
});
