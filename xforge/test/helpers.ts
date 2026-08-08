import { cp, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse, stringify } from 'yaml';

export const xforgeRoot = path.resolve(new URL('..', import.meta.url).pathname);
export const repositoryRoot = path.resolve(xforgeRoot, '..');
export const scaffoldPayload = path.join(repositoryRoot, 'scaffold', 'payload');
export const cliPath = path.join(xforgeRoot, 'dist', 'cli.js');

export async function fixture(prefix = 'xforge-test-'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await cp(scaffoldPayload, root, { recursive: true, force: false, errorOnExist: false });
  return realpath(root);
}

export async function yamlFile<T = Record<string, unknown>>(root: string, relative: string): Promise<T> {
  return parse(await readFile(path.join(root, ...relative.split('/')), 'utf8')) as T;
}

export async function updateYaml(
  root: string,
  relative: string,
  update: (value: Record<string, any>) => void,
): Promise<void> {
  const absolute = path.join(root, ...relative.split('/'));
  const value = parse(await readFile(absolute, 'utf8')) as Record<string, any>;
  update(value);
  await writeFile(absolute, stringify(value, { sortMapEntries: true, lineWidth: 120 }));
}

export async function write(root: string, relative: string, content: string): Promise<void> {
  const absolute = path.join(root, ...relative.split('/'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

export async function runCli(root: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}> {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
  let json: any = null;
  try { json = JSON.parse(result.stdout); } catch {}
  return { ...result, json };
}

export function changeYaml(flow: 'quick' | 'solid' | 'major', overrides: Record<string, unknown> = {}): string {
  const value = {
    flow,
    classification: { risk: flow === 'quick' ? 'low' : flow === 'major' ? 'high' : 'medium', security: false, privacy: false, publicApi: false, dataMigration: false },
    scope: { modules: ['root'], paths: ['src/**'] },
    ...overrides,
  };
  return stringify(value, { sortMapEntries: true });
}

export async function createCompleteSolidChange(root: string, id = 'add-feature'): Promise<void> {
  const base = `xforge/changes/${id}`;
  await write(root, `${base}/change.yaml`, changeYaml('solid'));
  await write(root, `${base}/proposal.md`, '## Why\nTest\n\n## Flow choice\nsolid\n');
  await write(root, `${base}/specs/widget/spec.md`, '## ADDED Requirements\n\n### Requirement: Widget works\n\n#### Scenario: success\n- **WHEN** used\n- **THEN** it works\n');
  await write(root, `${base}/design.md`, '## Decisions\nUse a deterministic fixture.\n');
  await write(root, `${base}/assurance.md`, '## Completeness\nAll requirements are covered.\n');
  await write(root, `${base}/evidence/verification-receipt.yaml`, 'status: passed\nrevision: fixture\n');
}
