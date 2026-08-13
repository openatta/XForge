import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse, stringify } from 'yaml';
import { afterAll } from 'vitest';
import { CHECK_FINDINGS_PATH } from '../src/core/check-findings.js';
import { CONSTITUTION_CHECK_PATH, constitutionPrinciples } from '../src/core/constitution-check.js';
import { executeApprove, type ApprovalTerminal } from '../src/commands/approve.js';
import { loadProject } from '../src/core/project-loader.js';

export const xforgeRoot = path.resolve(new URL('..', import.meta.url).pathname);
export const repositoryRoot = path.resolve(xforgeRoot, '..');
export const scaffoldPayload = path.join(repositoryRoot, 'scaffold', 'payload');
export const cliPath = path.join(xforgeRoot, 'dist', 'cli.js');

const temporaryRoots = new Set<string>();

afterAll(async () => {
  await Promise.all([...temporaryRoots].map((root) => rm(root, { recursive: true, force: true })));
  temporaryRoots.clear();
});

export async function temporaryDirectory(prefix = 'xforge-test-'): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  temporaryRoots.add(root);
  return root;
}

export async function fixture(prefix = 'xforge-test-'): Promise<string> {
  const root = await temporaryDirectory(prefix);
  await cp(scaffoldPayload, root, { recursive: true, force: false, errorOnExist: false });
  return root;
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

async function runCliCore(root: string, args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const coverageEnvironment = process.env.XFORGE_TEST_NODE_V8_COVERAGE
    ? { NODE_V8_COVERAGE: process.env.XFORGE_TEST_NODE_V8_COVERAGE }
    : {};
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: { ...process.env, ...coverageEnvironment, ...env },
      shell: false,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (stdin !== undefined) child.stdin!.end(stdin);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
}

export async function runCli(root: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}> {
  const result = await runCliCore(root, args, env);
  let json: any = null;
  try { json = JSON.parse(result.stdout); } catch {}
  return { ...result, json };
}

/** Like `runCli`, but feeds `stdin` to the child — the Hook dispatcher and the approval dialogue read it. */
export async function runCliWithInput(root: string, args: string[], stdin: string, env: NodeJS.ProcessEnv = {}): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}> {
  const result = await runCliCore(root, args, env, stdin);
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

/** The machine-decidable half of a Check Stage: a review that found nothing still has to say so. */
export function checkFindings(entries = ''): string {
  return entries ? `findings:\n${entries}` : 'findings: []\n';
}

/** Answers every `## ` principle in the shipped Constitution as compliant. */
export async function constitutionLedger(root: string): Promise<string> {
  const source = await readFile(path.join(root, 'xforge', 'constitution.md'), 'utf8');
  const principles = constitutionPrinciples(source);
  return `principles:\n${principles.map((name) => `  - principle: ${JSON.stringify(name)}\n    status: compliant\n`).join('')}`;
}

export async function createCompleteSolidChange(root: string, id = 'add-feature'): Promise<void> {
  const base = `xforge/changes/${id}`;
  await write(root, `${base}/change.yaml`, changeYaml('solid'));
  await write(root, `${base}/proposal.md`, '## Why\nTest\n\n## Flow choice\nsolid\n');
  await write(root, `${base}/specs/widget/spec.md`, '## ADDED Requirements\n\n### Requirement: Widget works\n\n#### Scenario: success\n- **WHEN** used\n- **THEN** it works\n');
  await write(root, `${base}/design.md`, '## Decisions\nUse a deterministic fixture.\n');
  await write(root, `${base}/check-report.md`, '## Completeness\nProposal, delta Specs, and Design agree.\n');
  await write(root, `${base}/${CHECK_FINDINGS_PATH}`, checkFindings());
  await write(root, `${base}/${CONSTITUTION_CHECK_PATH}`, await constitutionLedger(root));
  await write(root, `${base}/assurance.md`, '## Completeness\nAll requirements are covered.\n');
  await write(root, `${base}/evidence/verification-receipt.yaml`, 'status: passed\nrevision: fixture\n');
}

/**
 * There is no `--receipt` import path anymore, and every receipt (local or mcp) is only trusted once
 * XForge's own audit chain independently records the `approval.decided` event that produced it. So
 * test setup that needs "an approval already exists" can no longer shortcut by writing a hand-signed
 * file — it goes through the real `executeApprove` local path, exactly as `xforge approve` run at a
 * terminal would, via a scripted `ApprovalTerminal` that answers the live dialogue.
 */
export const approvalTestEnv = {};

async function successful(root: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<any> {
  const result = await runCli(root, args, env);
  if (result.code !== 0) throw new Error(`${args.join(' ')} failed: ${JSON.stringify(result.json?.diagnostics ?? result.stderr)}`);
  return result.json;
}

function scriptedApprovalTerminal(answers: Record<string, string>): ApprovalTerminal {
  return {
    present() {},
    async question(prompt: string) {
      for (const [key, answer] of Object.entries(answers)) if (prompt.includes(key)) return answer;
      return '';
    },
  };
}

export async function approveCurrentRevision(
  root: string,
  change: string,
  transition: string,
  policyId: string,
  actor = 'owner@example.test',
  role = 'owner',
): Promise<any> {
  const project = await loadProject(root, { exactRoot: true });
  const terminal = scriptedApprovalTerminal({
    'Approver identity': actor, 'Approver role': role, 'Decision': 'approve', 'Reason': 'Approved by the test governance dialogue.',
  });
  const result = await executeApprove(project, { change, transition, policy: policyId, interactive: true, dryRun: false, terminal });
  if (result.data.status !== 'recorded') throw new Error(`approve --change ${change} --for ${transition} --policy ${policyId} did not record: ${JSON.stringify(result.diagnostics)}`);
  return result;
}

export async function advanceSolidToApply(root: string, id = 'add-feature'): Promise<void> {
  await successful(root, ['check', '--change', id, '--gate', 'structure']);
  await successful(root, ['transition', '--change', id, '--to', 'design']);
  /* Solid now reviews before it implements: design -> check -> apply, with the planning approval
     guarding entry to Check rather than straight to Apply. */
  await approveCurrentRevision(root, id, 'check', 'planning-solid');
  await successful(root, ['transition', '--change', id, '--to', 'check']);
  await successful(root, ['check', '--change', id]);
  await successful(root, ['transition', '--change', id, '--to', 'apply']);
}

export async function advanceSolidToReadyToArchive(root: string, id = 'add-feature'): Promise<void> {
  await advanceSolidToApply(root, id);
  await successful(root, ['transition', '--change', id, '--to', 'verify']);
  await successful(root, ['check', '--change', id]);
  await successful(root, ['transition', '--change', id, '--to', 'ready-to-archive']);
  await approveCurrentRevision(root, id, 'archive', 'closing-solid');
}
