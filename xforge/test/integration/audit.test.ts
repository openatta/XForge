import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pruneExpiredAuditEvents,
  readAuditEvents,
  readChangeAuditEvents,
  recordAudit,
  retryAuditDelivery,
  verifyAudit,
} from '../../src/core/audit.js';
import { loadProject } from '../../src/core/project-loader.js';
import { changeYaml, fixture, runCli, updateYaml, write } from '../helpers.js';

async function acceptingServer(received: string[]): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push(Buffer.concat(chunks).toString('utf8'));
      response.statusCode = 204;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP test server did not bind.');
  return { endpoint: `http://127.0.0.1:${address.port}/events`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

afterEach(() => {
  delete process.env.XFORGE_AUDIT_ENDPOINT;
  delete process.env.XFORGE_AUDIT_TOKEN;
  delete process.env.XFORGE_AUDIT_HMAC_SECRET;
});

describe('enterprise audit', () => {
  it('detects local hash-chain tampering', async () => {
    const root = await fixture();
    const project = await loadProject(root, { exactRoot: true });
    await recordAudit(project, { eventType: 'test.event', change: null, outcome: 'succeeded', input: { secret: 'not-persisted' } });
    expect((await verifyAudit(project)).valid).toBe(true);
    const log = path.join(root, 'xforge', '.audit', 'events.jsonl');
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    const event = JSON.parse(lines[0]!);
    event.reason = 'tampered';
    lines[0] = JSON.stringify(event);
    await writeFile(log, `${lines.join('\n')}\n`);
    const verification = await verifyAudit(project);
    expect(verification.valid).toBe(false);
    expect(verification.diagnostics.map((item) => item.code)).toContain('XFORGE_AUDIT_HASH_INVALID');
  });

  it('spools a failed remote append and clears the per-change debt on retry', async () => {
    let accept = false;
    const received: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'));
        response.statusCode = accept ? 204 : 503;
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('HTTP test server did not bind.');
      process.env.XFORGE_AUDIT_ENDPOINT = `http://127.0.0.1:${address.port}/events`;
      const root = await fixture();
      const project = await loadProject(root, { exactRoot: true });
      await recordAudit(project, { eventType: 'major.test', change: 'major-change', outcome: 'succeeded' });
      expect((await verifyAudit(project, 'major-change')).remotePending).toBe(1);
      expect((await readAuditEvents(project)).some((event) => event.outcome === 'spooled')).toBe(true);
      accept = true;
      expect(await retryAuditDelivery(project)).toMatchObject({ attempted: 1, delivered: 1 });
      expect((await verifyAudit(project, 'major-change')).remotePending).toBe(0);
      expect(received.length).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('makes Major remote debt fail the CI audit verification command', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/major-ci/change.yaml', changeYaml('major'));
    const project = await loadProject(root, { exactRoot: true });
    await recordAudit(project, { eventType: 'stage.entered', change: 'major-ci', flow: 'major', stage: 'propose', outcome: 'succeeded' });
    const result = await runCli(root, ['audit', 'verify', '--change', 'major-ci']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toEqual(expect.arrayContaining(['XFORGE_AUDIT_REMOTE_PENDING', 'XFORGE_AUDIT_EVENT_MISSING']));
  });

  it('shards the chain per Change so parallel worktrees merge without breaking it', async () => {
    const main = await fixture();
    const worktree = await fixture();
    for (const root of [main, worktree]) {
      await write(root, 'xforge/changes/change-a/change.yaml', changeYaml('solid'));
      await write(root, 'xforge/changes/change-b/change.yaml', changeYaml('solid'));
    }
    const mainProject = await loadProject(main, { exactRoot: true });
    const worktreeProject = await loadProject(worktree, { exactRoot: true });

    /* Two Workers, two git worktrees, two Changes, written at the same time. */
    await Promise.all([
      ...[1, 2, 3].map((index) => recordAudit(mainProject, { eventType: `a.step.${index}`, change: 'change-a', outcome: 'succeeded', deliver: false })),
      ...[1, 2, 3].map((index) => recordAudit(worktreeProject, { eventType: `b.step.${index}`, change: 'change-b', outcome: 'succeeded', deliver: false })),
      ...[1, 2].map((index) => recordAudit(mainProject, { eventType: `c.step.${index}`, change: 'change-b', outcome: 'succeeded', deliver: false })),
    ]);
    expect((await verifyAudit(mainProject)).valid).toBe(true);
    expect((await verifyAudit(worktreeProject)).valid).toBe(true);

    /* Merging the worktree back only ever touches that Change's own shard file. */
    const shard = path.join('xforge', '.audit', 'changes', 'change-b.jsonl');
    await mkdir(path.dirname(path.join(main, shard)), { recursive: true });
    await copyFile(path.join(worktree, shard), path.join(main, shard));
    const merged = await verifyAudit(mainProject);
    expect(merged.diagnostics).toEqual([]);
    expect(merged.valid).toBe(true);
    const facts = await readChangeAuditEvents(mainProject, 'change-b');
    expect(facts.chain.valid).toBe(true);
    expect(facts.events.map((event) => event.eventType).sort()).toEqual(['b.step.1', 'b.step.2', 'b.step.3']);
    expect((await readChangeAuditEvents(mainProject, 'change-a')).events).toHaveLength(3);
  });

  it('never blocks a runtime-plane event on remote delivery', async () => {
    const received: string[] = [];
    const server = await acceptingServer(received);
    try {
      process.env.XFORGE_AUDIT_ENDPOINT = server.endpoint;
      const root = await fixture();
      await write(root, 'xforge/changes/rt-change/change.yaml', changeYaml('solid'));
      const project = await loadProject(root, { exactRoot: true });

      const runtime = await recordAudit(project, { eventType: 'agent.tool.before', plane: 'runtime', change: 'rt-change', outcome: 'succeeded' });
      expect(runtime.eventType).toBe('agent.tool.before');
      expect(runtime.deliveryState).toBe('pending');
      expect(received).toHaveLength(0);
      expect((await readAuditEvents(project)).filter((event) => event.eventType === 'audit.delivery')).toHaveLength(0);

      /* Workflow-plane events are rare and stay synchronous. */
      const workflow = await recordAudit(project, { eventType: 'stage.entered', change: 'rt-change', outcome: 'succeeded' });
      expect(workflow.eventType).toBe('audit.delivery');
      expect(workflow.outcome).toBe('succeeded');
      expect(received).toHaveLength(1);

      expect(await retryAuditDelivery(project)).toMatchObject({ attempted: 1, delivered: 1 });
      expect(received).toHaveLength(2);
      expect((await verifyAudit(project, 'rt-change')).remotePending).toBe(0);
      expect((await verifyAudit(project)).valid).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('answers archive audit questions from the committed index when events.jsonl is absent', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/idx-change/change.yaml', changeYaml('solid'));
    const project = await loadProject(root, { exactRoot: true });
    for (const eventType of ['gate.after', 'stage.entered', 'approval.decided']) {
      await recordAudit(project, { eventType, change: 'idx-change', outcome: 'succeeded', deliver: false });
    }
    const indexPath = path.join(root, 'xforge', 'changes', 'idx-change', 'evidence', 'audit', 'index.json');
    const document = JSON.parse(await readFile(indexPath, 'utf8'));
    expect(document.chain).toMatchObject({ eventCount: 3, valid: true });

    /* xforge/.audit is gitignored: a fresh clone or a CI runner has the index and nothing else. */
    await rm(path.join(root, 'xforge', '.audit'), { recursive: true, force: true });
    const facts = await readChangeAuditEvents(project, 'idx-change');
    expect(facts.source).toBe('index');
    expect(facts.trusted).toBe(true);
    expect(facts.chain).toMatchObject({ valid: true, head: document.chain.head });
    expect(facts.eventTypes).toEqual(['approval.decided', 'gate.after', 'stage.entered']);
    expect(facts.eventCount).toBe(3);
    expect(facts.events).toHaveLength(0);
  });

  it('keeps the committed index intact when a fresh clone records its first event', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/clone-change/change.yaml', changeYaml('solid'));
    const project = await loadProject(root, { exactRoot: true });
    for (const eventType of ['gate.after', 'stage.entered', 'approval.decided']) {
      await recordAudit(project, { eventType, change: 'clone-change', outcome: 'succeeded', deliver: false });
    }
    const indexPath = path.join(root, 'xforge', 'changes', 'clone-change', 'evidence', 'audit', 'index.json');
    const before = JSON.parse(await readFile(indexPath, 'utf8'));

    /* A fresh clone has the committed index but no local chain, because .audit is gitignored.
       Rebuilding the index from that empty chain would erase the Change's whole audit history and
       permanently block archive; the rebuild must only ever add to what is already committed. */
    await rm(path.join(root, 'xforge', '.audit'), { recursive: true, force: true });
    await recordAudit(project, { eventType: 'archive.before', change: 'clone-change', outcome: 'succeeded', deliver: false });

    const after = JSON.parse(await readFile(indexPath, 'utf8'));
    for (const eventType of ['gate.after', 'stage.entered', 'approval.decided']) {
      expect(after.eventTypes[eventType]).toEqual(before.eventTypes[eventType]);
    }
    expect(after.eventTypes['archive.before']).toBeDefined();
    expect(after.chain.eventCount).toBeGreaterThanOrEqual(before.chain.eventCount);

    const facts = await readChangeAuditEvents(project, 'clone-change');
    expect(facts.trusted).toBe(true);
    expect(facts.eventTypes).toEqual(['approval.decided', 'archive.before', 'gate.after', 'stage.entered']);
  });

  it('refuses to prune when no retention policy is configured', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/prune-change/change.yaml', changeYaml('solid'));
    /* `localRetentionDays` is required inside `audit`, so "no retention policy" means no audit block. */
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { delete manifest.audit; });
    /* Pruning deletes history. With no declared policy the command must say so, not quietly
       report success having done nothing — and not invent a retention window of its own. */
    const result = await runCli(root, ['audit', 'prune']);
    expect(result.json.data).toMatchObject({ pruned: null, reason: 'not-configured' });
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_AUDIT_RETENTION_NOT_CONFIGURED');
  });

  it('detects a hand-edited committed audit index', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/tamper-change/change.yaml', changeYaml('solid'));
    const project = await loadProject(root, { exactRoot: true });
    await recordAudit(project, { eventType: 'stage.entered', change: 'tamper-change', outcome: 'succeeded', deliver: false });
    const indexPath = path.join(root, 'xforge', 'changes', 'tamper-change', 'evidence', 'audit', 'index.json');
    const document = JSON.parse(await readFile(indexPath, 'utf8'));
    document.eventTypes['gate.after'] = { count: 1, lastTimestamp: new Date().toISOString(), lastHash: 'f'.repeat(64) };
    await writeFile(indexPath, `${JSON.stringify(document, null, 2)}\n`);
    await rm(path.join(root, 'xforge', '.audit'), { recursive: true, force: true });

    const facts = await readChangeAuditEvents(project, 'tamper-change');
    expect(facts.trusted).toBe(false);
    expect(facts.chain.valid).toBe(false);
    expect(facts.eventTypes).not.toContain('gate.after');
    expect(facts.diagnostics.map((item) => item.code)).toContain('XFORGE_AUDIT_INDEX_TAMPERED');
  });

  it('prunes expired events behind a chain anchor and keeps the chain verifiable', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/old-change/change.yaml', changeYaml('solid'));
    const project = await loadProject(root, { exactRoot: true });
    for (const eventType of ['stage.entered', 'gate.after']) {
      await recordAudit(project, { eventType, change: 'old-change', outcome: 'succeeded', deliver: false });
    }
    const pruned = await pruneExpiredAuditEvents(project, { retentionDays: 1, now: Date.now() + 5 * 86_400_000 });
    expect(pruned.removed).toBe(2);
    expect((await verifyAudit(project)).valid).toBe(true);

    /* New events chain onto the anchor left behind by the pruned prefix. */
    await recordAudit(project, { eventType: 'approval.decided', change: 'old-change', outcome: 'succeeded', deliver: false });
    expect((await verifyAudit(project)).valid).toBe(true);
    const facts = await readChangeAuditEvents(project, 'old-change');
    expect(facts.chain).toMatchObject({ valid: true, prunedCount: 2 });
    expect(facts.eventTypes).toEqual(['approval.decided', 'gate.after', 'stage.entered']);
    expect(facts.eventCount).toBe(3);
  });
});
