import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgementAttestationDigest,
  approvalVerifiedInChain,
  auditIndexDigest,
  INDEX_VERSION,
  pruneExpiredAuditEvents,
  readAcknowledgementAttestations,
  readAuditEvents,
  readChangeAuditEvents,
  readChangeAuditIndex,
  readTransitionAttestations,
  recordAudit,
  refreshChangeAuditIndex,
  retryAuditDelivery,
  transitionAttestationDigest,
  verifyAudit,
} from '../../src/core/audit.js';
import { XForgeError } from '../../src/core/errors.js';
import { sha256, stableStringify } from '../../src/core/hash.js';
import { loadProject } from '../../src/core/project-loader.js';
import type { AuditEvent, ProjectContext } from '../../src/types.js';
import { changeYaml, fixture, runCli, updateYaml, write } from '../helpers.js';

/**
 * A fully valid chain event, built the same way `appendEvent` builds one: the hash is sha256 over
 * the event minus its own `hash`. Tests need this to stand up chains long enough to cross
 * `INDEX_EVENT_LIMIT` without paying for a thousand `recordAudit` round-trips.
 */
function chainEvent(previousHash: string | null, overrides: Partial<AuditEvent> & { eventType: string; change: string; timestamp: string }): AuditEvent {
  const body = {
    apiVersion: 'xforge.dev/v1alpha2' as const, kind: 'AuditEvent' as const, eventId: randomUUID(),
    plane: 'workflow' as const, platform: 'xforge', surface: 'local' as const,
    sessionId: 'test', turnId: 'test', toolCallId: 'test', correlationId: randomUUID(),
    actor: { id: 'tester', provider: 'local-os', role: 'operator', type: 'system' as const },
    flow: null, stage: null, workPackage: null, stateRevision: 'unknown', gitBase: 'unknown', gitHead: 'unknown',
    refs: { rules: [], policies: [], gates: [] }, decision: null, reason: null, outcome: 'succeeded' as const,
    durationMs: null, inputDigest: sha256('null'), outputDigest: sha256('null'), redaction: 'metadata-only' as const,
    coverage: { observed: true, gaps: [] }, deliveryState: 'not-configured' as const,
    ...overrides,
    previousHash,
  };
  return { ...body, hash: sha256(stableStringify(body)) };
}

async function writeShard(root: string, changeId: string, events: AuditEvent[]): Promise<void> {
  const relative = path.join('xforge', '.audit', 'changes', `${changeId}.jsonl`);
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), events.map((event) => `${JSON.stringify(event)}\n`).join(''));
}

function indexPath(root: string, changeId: string): string {
  return path.join(root, 'xforge', 'changes', changeId, 'evidence', 'audit', 'index.json');
}

async function lockDirectory(root: string, changeId: string, owner: Record<string, unknown> | null): Promise<string> {
  const lock = path.join(root, 'xforge', '.audit', '.locks', `${changeId}.lock`);
  await mkdir(lock, { recursive: true });
  if (owner) await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify(owner)}\n`);
  return lock;
}

/** A pid that certainly does not exist any more: a child process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (typeof child.pid !== 'number') throw new Error('Could not spawn a probe process.');
  return child.pid;
}

function signedProject(project: ProjectContext, env: string): void {
  /* Declared in memory rather than in `xforge/manifest.yaml` because `manifest.schema.json` still
     has to learn the `audit.chain` property (that file is owned elsewhere); the reader in audit.ts
     is structural for exactly this reason. */
  (project.manifest.audit as unknown as Record<string, unknown>).chain = { hmacSecretEnv: env };
}

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
  delete process.env.XFORGE_AUDIT_CHAIN_SECRET;
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

  /*
   * The shipped Major Flow no longer requires remote delivery: with `audit.remote` configured but
   * no endpoint in the environment, every event stayed `pending` forever and archive blocked on
   * `audit:remote-pending` with no way to clear it, so a default install could drive a Major Change
   * all the way to ready-to-archive and then never finish it. Remote delivery is now an opt-in, and
   * these two tests pin both halves of that: the default is archivable, and opting in still creates
   * real, reported debt.
   */
  it('does not manufacture remote debt for Major on the shipped default', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/major-ci/change.yaml', changeYaml('major'));
    const project = await loadProject(root, { exactRoot: true });
    await recordAudit(project, { eventType: 'stage.entered', change: 'major-ci', flow: 'major', stage: 'propose', outcome: 'succeeded' });
    const result = await runCli(root, ['audit', 'verify', '--change', 'major-ci']);
    const codes = result.json.diagnostics.map((item: any) => item.code);
    expect(codes).not.toContain('XFORGE_AUDIT_REMOTE_PENDING');
    /* Still fails, but only on the events the Flow's own audit policy requires and this Change
       has not produced — which is a debt the Change can actually pay off. */
    expect(result.code).toBe(1);
    expect(codes).toContain('XFORGE_AUDIT_EVENT_MISSING');
  });

  it('makes Major remote debt fail the CI audit verification command once remote delivery is required', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.audit.remote.requiredFor = ['major']; });
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

  it('never evicts governance events from a Change whose chain outgrows the index event limit', async () => {
    const root = await fixture();
    const change = 'long-change';
    await write(root, `xforge/changes/${change}/change.yaml`, changeYaml('major'));

    /*
     * 1200 gate events is an ordinary long Change, not a pathological one: `runGate` records
     * gate.before + gate.after per gate run, so a Change with a handful of work packages and a few
     * dozen agent edit-then-check cycles gets here. The events archive actually reasons from happen
     * at Stage boundaries — after all of that noise — and the v2 index kept the *oldest* 1000, so
     * they were exactly the ones it dropped.
     */
    const at = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    const noise: AuditEvent[] = [];
    let previous: string | null = null;
    for (let index = 0; index < 1200; index += 1) {
      const event = chainEvent(previous, { change, eventType: index % 2 === 0 ? 'gate.before' : 'gate.after', timestamp: at(index) });
      noise.push(event);
      previous = event.hash;
    }
    const approvalSubject = sha256(stableStringify({ policy: 'security-review', receipt: 'r-approval' }));
    const governance: AuditEvent[] = [];
    for (const [offset, [eventType, inputDigest]] of ([
      ['stage.entered', transitionAttestationDigest('r-transition')],
      ['approval.decided', approvalSubject],
      ['work-package.reviewed', acknowledgementAttestationDigest('r-ack')],
    ] as const).entries()) {
      const event = chainEvent(previous, { change, eventType, inputDigest, timestamp: at(1200 + offset) });
      governance.push(event);
      previous = event.hash;
    }
    await writeShard(root, change, [...noise, ...governance]);

    const project = await loadProject(root, { exactRoot: true });
    await refreshChangeAuditIndex(project, change);
    /* The synthetic chain is a real one: it verifies, so nothing below rests on a broken fixture. */
    expect((await verifyAudit(project, change)).valid).toBe(true);

    const document = JSON.parse(await readFile(indexPath(root, change), 'utf8'));
    const retained = new Set(document.events.map((event: any) => event.eventId));
    for (const event of governance) expect(retained.has(event.eventId)).toBe(true);
    /* The limit still applies — to the noise, evicting its oldest end rather than its newest. */
    expect(document.events.filter((event: any) => event.eventType.startsWith('gate.'))).toHaveLength(1_000);
    expect(retained.has(noise[0]!.eventId)).toBe(false);
    expect(retained.has(noise.at(-1)!.eventId)).toBe(true);
    expect(document.eventsTruncated).toBe(true);
    /* Volume dropped noise, so `eventsTruncated` is honest — but nothing governance-bearing went
       with it, which is the question the orphan-receipt scan actually needs answered. */
    expect(document.governanceComplete).toBe(true);

    /* Fresh clone / CI: `xforge/.audit/**` is gitignored, so the committed index is all there is. */
    await rm(path.join(root, 'xforge', '.audit'), { recursive: true, force: true });
    expect(await approvalVerifiedInChain(project, change, 'security-review', 'r-approval')).toBe(true);
    expect((await readAcknowledgementAttestations(project, change)).attests('r-ack')).toBe(true);
    const transitions = await readTransitionAttestations(project, change);
    expect(transitions.attests('r-transition')).toBe(true);
    expect(transitions.complete).toBe(true);
  });

  it('keeps a late approval.decided when the committed index is already at the event limit', async () => {
    const root = await fixture();
    const change = 'merge-change';
    await write(root, `xforge/changes/${change}/change.yaml`, changeYaml('major'));
    const project = await loadProject(root, { exactRoot: true });
    await recordAudit(project, {
      eventType: 'approval.decided', change, outcome: 'succeeded', deliver: false,
      inputDigest: sha256(stableStringify({ policy: 'security-review', receipt: 'r-late' })),
    });

    /* An index carrying a Change's earlier history — from a colleague's machine, or from before a
       retention pass — that is already at the limit. The merge has to choose what survives, and
       choosing "the first 1000 by timestamp" throws away everything that decides archive. */
    const document = JSON.parse(await readFile(indexPath(root, change), 'utf8'));
    document.events = [
      ...Array.from({ length: 1_200 }, (_ignored, index) => ({
        eventId: randomUUID(), eventType: 'gate.after', timestamp: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
        plane: 'workflow', stateRevision: 'unknown', outcome: 'succeeded', deliveryState: 'not-configured',
        inputDigest: sha256('null'), hash: sha256(`old-${index}`),
      })),
      ...document.events,
    ];
    document.eventsTruncated = true;
    document.digest = auditIndexDigest(document);
    await writeFile(indexPath(root, change), `${JSON.stringify(document, null, 2)}\n`);

    await refreshChangeAuditIndex(project, change);
    const merged = await readChangeAuditIndex(project, change);
    expect(merged?.digestValid).toBe(true);
    expect(merged!.document.events.some((event) => event.eventType === 'approval.decided')).toBe(true);
    expect(merged!.document.events.filter((event) => event.eventType === 'gate.after')).toHaveLength(1_000);

    /* Fresh clone / CI: without this the Approval reads as unverified and archive is permanently
       impossible there, while the machine that ran the flow keeps working. */
    await rm(path.join(root, 'xforge', '.audit'), { recursive: true, force: true });
    expect(await approvalVerifiedInChain(project, change, 'security-review', 'r-late')).toBe(true);
  });

  it('heals a v2 index that was truncated the wrong way, and stays honest when it cannot', async () => {
    const root = await fixture();
    const change = 'heal-change';
    await write(root, `xforge/changes/${change}/change.yaml`, changeYaml('solid'));
    const project = await loadProject(root, { exactRoot: true });
    await recordAudit(project, {
      eventType: 'stage.entered', change, outcome: 'succeeded', deliver: false,
      inputDigest: transitionAttestationDigest('r-heal'),
    });

    /* Exactly what a pre-v3 CLI leaves behind: no `governanceComplete`, and a truncation flag that
       used to mean "some events are missing, possibly the ones you are about to ask about". */
    const stale = JSON.parse(await readFile(indexPath(root, change), 'utf8'));
    stale.version = 2;
    delete stale.governanceComplete;
    stale.eventsTruncated = true;
    stale.digest = auditIndexDigest(stale);
    await writeFile(indexPath(root, change), `${JSON.stringify(stale, null, 2)}\n`);
    /* Until it is rebuilt it is read conservatively: the orphan scan stays disabled. */
    expect((await readTransitionAttestations(project, change)).complete).toBe(false);

    /* The local chain still holds every event the stale index listed, so the replay proves the
       rebuilt document is a superset and the inherited flag no longer says anything about it. */
    await refreshChangeAuditIndex(project, change);
    const healed = await readChangeAuditIndex(project, change);
    /* Current, not a literal: the point is that healing produces an index this CLI wrote, and
       pinning the number meant every later shape change failed here rather than where it changed. */
    expect(healed!.document.version).toBe(INDEX_VERSION);
    expect(healed!.document.governanceComplete).toBe(true);
    const attestations = await readTransitionAttestations(project, change);
    expect(attestations.complete).toBe(true);
    expect(attestations.attests('r-heal')).toBe(true);

    /* Where the local chain cannot prove it — a clone, where the chain is gitignored — the loss is
       real and is inherited rather than wished away. */
    await writeFile(indexPath(root, change), `${JSON.stringify(stale, null, 2)}\n`);
    await rm(path.join(root, 'xforge', '.audit'), { recursive: true, force: true });
    await refreshChangeAuditIndex(project, change);
    const cloned = await readChangeAuditIndex(project, change);
    expect(cloned!.document.governanceComplete).toBe(false);
    expect((await readTransitionAttestations(project, change)).complete).toBe(false);
  });

  it('reclaims an audit lock whose owning process is gone', async () => {
    const root = await fixture();
    const change = 'lock-change';
    await write(root, `xforge/changes/${change}/change.yaml`, changeYaml('solid'));
    const project = await loadProject(root, { exactRoot: true });
    /* One Ctrl-C, agent-harness SIGTERM or CI container eviction while the lock was held used to
       poison every later command that records an event for this Change, forever. */
    const lock = await lockDirectory(root, change, { pid: deadPid(), hostname: hostname(), startedAt: new Date().toISOString() });

    await recordAudit(project, { eventType: 'gate.after', change, outcome: 'succeeded', deliver: false });

    const events = (await readAuditEvents(project)).filter((event) => event.change === change);
    expect(events.map((event) => event.eventType)).toEqual(['audit.lock.reclaimed', 'gate.after']);
    expect(events[0]!.reason).toMatch(/^process-gone:/);
    /* The reclaim is a link in the chain it protected, not a note beside it. */
    expect((await verifyAudit(project, change)).valid).toBe(true);
    expect(await readFile(path.join(lock, 'owner.json'), 'utf8').then(() => true, () => false)).toBe(false);
  });

  it('reclaims an audit lock left behind by another host once it outlives its TTL', async () => {
    const root = await fixture();
    const change = 'ttl-change';
    await write(root, `xforge/changes/${change}/change.yaml`, changeYaml('solid'));
    const project = await loadProject(root, { exactRoot: true });
    /* A live pid, so only age can decide — the pid belongs to a machine this one cannot ask about. */
    await lockDirectory(root, change, { pid: process.pid, hostname: 'ci-runner-17', startedAt: new Date(Date.now() - 600_000).toISOString() });
    await recordAudit(project, { eventType: 'gate.after', change, outcome: 'succeeded', deliver: false });
    expect((await readAuditEvents(project)).filter((event) => event.eventType === 'audit.lock.reclaimed')[0]!.reason).toMatch(/^expired:/);

    /* A lock written by a CLI old enough to record no owner at all falls back to the same age test. */
    const legacy = await lockDirectory(root, change, null);
    const old = new Date(Date.now() - 600_000);
    await utimes(legacy, old, old);
    await recordAudit(project, { eventType: 'gate.after', change, outcome: 'succeeded', deliver: false });
    const reclaims = (await readAuditEvents(project)).filter((event) => event.eventType === 'audit.lock.reclaimed');
    expect(reclaims).toHaveLength(2);
    expect(reclaims[1]!.reason).toBe('no-owner-expired');
    expect((await verifyAudit(project, change)).valid).toBe(true);
  });

  it('reports a lock held by a live process as a structured error naming the lock', async () => {
    const root = await fixture();
    const change = 'busy-change';
    await write(root, `xforge/changes/${change}/change.yaml`, changeYaml('solid'));
    const project = await loadProject(root, { exactRoot: true });
    /* This process is alive and the lock is fresh, so it is genuinely held: waiting is correct, and
       giving up has to say what to do about it rather than throwing a bare Error. */
    await lockDirectory(root, change, { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() });
    const error = await recordAudit(project, { eventType: 'gate.after', change, outcome: 'succeeded', deliver: false }).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(XForgeError);
    expect((error as XForgeError).diagnostics[0]!.code).toBe('XFORGE_AUDIT_LOCK_TIMEOUT');
    expect((error as XForgeError).diagnostics[0]!.message).toContain(`.audit/.locks/${change}.lock`);
    expect((error as XForgeError).nextActions[0]!.command).toContain(`xforge/.audit/.locks/${change}.lock`);
  });

  it('anchors the chain with an HMAC when the manifest declares a chain secret', async () => {
    const root = await fixture();
    const change = 'hmac-change';
    await write(root, `xforge/changes/${change}/change.yaml`, changeYaml('major'));
    const project = await loadProject(root, { exactRoot: true });
    process.env.XFORGE_AUDIT_CHAIN_SECRET = 'chain-secret';
    signedProject(project, 'XFORGE_AUDIT_CHAIN_SECRET');

    for (const eventType of ['gate.after', 'stage.entered', 'approval.decided']) {
      await recordAudit(project, { eventType, change, outcome: 'succeeded', deliver: false });
    }
    const shard = path.join(root, 'xforge', '.audit', 'changes', `${change}.jsonl`);
    const lines = (await readFile(shard, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.every((event) => typeof event.hmac === 'string')).toBe(true);
    expect((await verifyAudit(project, change)).valid).toBe(true);
    expect(JSON.parse(await readFile(indexPath(root, change), 'utf8')).hmac).toEqual(expect.any(String));

    /*
     * The property the anchor exists for. An editor with repository access can rewrite an event and
     * recompute the unkeyed `hash` — the default chain is corruption-evident, not tamper-evident, so
     * this passes every check XForge otherwise makes. Recomputing the HMAC needs the secret.
     */
    const { hash: _replaced, hmac, ...body } = lines.at(-1)!;
    const forged = { ...body, decision: 'approved-by-nobody' };
    lines[lines.length - 1] = { ...forged, hmac, hash: sha256(stableStringify(forged)) };
    await writeFile(shard, `${lines.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const verification = await verifyAudit(project, change);
    expect(verification.valid).toBe(false);
    expect(verification.diagnostics.map((item) => item.code)).toContain('XFORGE_AUDIT_HMAC_INVALID');
    /* The forgery is internally consistent: only the key catches it. */
    expect(verification.diagnostics.map((item) => item.code)).not.toContain('XFORGE_AUDIT_HASH_INVALID');
  });

  it('fails closed when a signed chain is read or extended without its secret', async () => {
    const root = await fixture();
    const change = 'closed-change';
    await write(root, `xforge/changes/${change}/change.yaml`, changeYaml('major'));
    const project = await loadProject(root, { exactRoot: true });
    process.env.XFORGE_AUDIT_CHAIN_SECRET = 'chain-secret';
    signedProject(project, 'XFORGE_AUDIT_CHAIN_SECRET');
    await recordAudit(project, { eventType: 'stage.entered', change, outcome: 'succeeded', deliver: false });
    const committed = await readFile(indexPath(root, change), 'utf8');

    /* Reading a signed chain with no key must not quietly fall back to the unkeyed check. */
    delete process.env.XFORGE_AUDIT_CHAIN_SECRET;
    const verification = await verifyAudit(project, change);
    expect(verification.valid).toBe(false);
    expect(verification.diagnostics.map((item) => item.code)).toContain('XFORGE_AUDIT_HMAC_UNVERIFIABLE');
    const facts = await readChangeAuditEvents(project, change);
    expect(facts.trusted).toBe(false);
    expect(facts.diagnostics.map((item) => item.code)).toContain('XFORGE_AUDIT_HMAC_UNVERIFIABLE');

    /* Nor may it append an event nobody can verify later, nor overwrite the committed index with an
       unsigned rebuild — that would destroy the history it could not read. */
    const error = await recordAudit(project, { eventType: 'gate.after', change, outcome: 'succeeded', deliver: false }).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(XForgeError);
    expect((error as XForgeError).diagnostics[0]!.code).toBe('XFORGE_AUDIT_CHAIN_SECRET_MISSING');
    expect(await readFile(indexPath(root, change), 'utf8')).toBe(committed);

    /* And an unsigned event slipped into a signed chain is reported, not accepted. */
    process.env.XFORGE_AUDIT_CHAIN_SECRET = 'chain-secret';
    const shard = path.join(root, 'xforge', '.audit', 'changes', `${change}.jsonl`);
    const events = (await readFile(shard, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    delete events.at(-1)!.hmac;
    await writeFile(shard, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    expect((await verifyAudit(project, change)).diagnostics.map((item) => item.code)).toContain('XFORGE_AUDIT_HMAC_MISSING');
  });
});
