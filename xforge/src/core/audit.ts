import { createHmac, randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AuditEvent, GovernanceRevision, ProjectContext } from '../types.js';
import { atomicWrite } from './files.js';
import { sha256, stableStringify } from './hash.js';
import { safeResolve } from './path-safety.js';

const AUDIT_LOG = 'xforge/.audit/events.jsonl';
const AUDIT_LOCK = 'xforge/.audit/.write-lock';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function acquireLock(project: ProjectContext): Promise<() => Promise<void>> {
  const lock = await safeResolve(project.root, AUDIT_LOCK);
  await mkdir(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await mkdir(lock);
      return () => rm(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error('Timed out waiting for the audit append lock.');
}

export async function readAuditEvents(project: ProjectContext): Promise<AuditEvent[]> {
  const absolute = await safeResolve(project.root, AUDIT_LOG);
  if (!await exists(absolute)) return [];
  const source = await readFile(absolute, 'utf8');
  return source.split('\n').filter(Boolean).map((line) => JSON.parse(line) as AuditEvent);
}

function eventHash(event: Omit<AuditEvent, 'hash'>): string {
  return sha256(stableStringify(event));
}

export interface AuditVerification {
  valid: boolean;
  head: string | null;
  eventCount: number;
  diagnostics: Array<{ code: string; message: string; eventId?: string }>;
  remotePending: number;
}

export async function verifyAudit(project: ProjectContext, changeId?: string): Promise<AuditVerification> {
  const diagnostics: AuditVerification['diagnostics'] = [];
  let events: AuditEvent[];
  try { events = await readAuditEvents(project); }
  catch (error) {
    return { valid: false, head: null, eventCount: 0, remotePending: 0, diagnostics: [{ code: 'XFORGE_AUDIT_PARSE_FAILED', message: (error as Error).message }] };
  }
  let previous: string | null = null;
  const delivered = new Set(events.filter((event) => event.eventType === 'audit.delivery' && event.outcome === 'succeeded').map((event) => event.inputDigest));
  const spooled = new Set(events.filter((event) => event.eventType === 'audit.delivery' && event.outcome === 'spooled').map((event) => event.inputDigest));
  for (const event of events) {
    const { hash, ...unsigned } = event;
    if (hash !== eventHash(unsigned)) diagnostics.push({ code: 'XFORGE_AUDIT_HASH_INVALID', message: 'Audit event hash does not match its content.', eventId: event.eventId });
    if (event.previousHash !== previous) diagnostics.push({ code: 'XFORGE_AUDIT_CHAIN_BROKEN', message: 'Audit previousHash does not match the chain head.', eventId: event.eventId });
    previous = hash;
  }
  const remotePending = events.filter((event) => (!changeId || event.change === changeId) && event.deliveryState === 'pending' && !delivered.has(event.hash) && (spooled.has(event.hash) || event.eventType !== 'audit.delivery')).length;
  return { valid: diagnostics.length === 0, head: previous, eventCount: events.length, diagnostics, remotePending };
}

async function updateChangeIndex(project: ProjectContext, changeId: string): Promise<void> {
  const verification = await verifyAudit(project);
  const events = (await readAuditEvents(project)).filter((event) => event.change === changeId);
  const index = {
    apiVersion: 'xforge.dev/v1alpha2', kind: 'AuditIndex', change: changeId,
    generatedAt: new Date().toISOString(), chainHead: verification.head, chainValid: verification.valid,
    events: events.map((event) => ({ eventId: event.eventId, eventType: event.eventType, timestamp: event.timestamp, stateRevision: event.stateRevision, outcome: event.outcome, deliveryState: event.deliveryState, hash: event.hash })),
  };
  let changeRoot = `${project.changesPath}/${changeId}`;
  if (!await exists(await safeResolve(project.root, changeRoot))) {
    const archiveRoot = await safeResolve(project.root, `${project.changesPath}/archive`);
    const names = await readdir(archiveRoot).catch(() => [] as string[]);
    const archived = names.filter((name) => name === changeId || name.endsWith(`-${changeId}`)).sort().at(-1);
    if (!archived) return;
    changeRoot = `${project.changesPath}/archive/${archived}`;
  }
  await atomicWrite(project.root, `${changeRoot}/evidence/audit/index.json`, `${JSON.stringify(index, null, 2)}\n`);
}

async function appendEvent(project: ProjectContext, event: Omit<AuditEvent, 'previousHash' | 'hash'>): Promise<AuditEvent> {
  const release = await acquireLock(project);
  try {
    const existing = await readAuditEvents(project);
    const unsigned = { ...event, previousHash: existing.at(-1)?.hash ?? null };
    const complete: AuditEvent = { ...unsigned, hash: eventHash(unsigned) };
    const absolute = await safeResolve(project.root, AUDIT_LOG);
    await mkdir(path.dirname(absolute), { recursive: true });
    await appendFile(absolute, `${JSON.stringify(complete)}\n`, { encoding: 'utf8', flag: 'a' });
    return complete;
  } finally {
    await release();
  }
}

async function deliverRemote(project: ProjectContext, event: AuditEvent): Promise<{ delivered: boolean; reason: string | null }> {
  const remote = project.manifest.audit?.remote;
  if (!remote) return { delivered: false, reason: 'not-configured' };
  const endpoint = process.env[remote.endpointEnv];
  if (!endpoint) return { delivered: false, reason: `missing:${remote.endpointEnv}` };
  const body = JSON.stringify(event);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-xforge-event-hash': event.hash };
  if (remote.tokenEnv && process.env[remote.tokenEnv]) headers.authorization = `Bearer ${process.env[remote.tokenEnv]}`;
  if (remote.hmacSecretEnv && process.env[remote.hmacSecretEnv]) headers['x-xforge-signature'] = createHmac('sha256', process.env[remote.hmacSecretEnv]!).update(body).digest('hex');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remote.timeoutSeconds * 1000);
  timer.unref();
  try {
    const response = await fetch(endpoint, { method: 'POST', headers, body, signal: controller.signal });
    return response.ok ? { delivered: true, reason: null } : { delivered: false, reason: `http:${response.status}` };
  } catch (error) {
    return { delivered: false, reason: (error as Error).name === 'AbortError' ? 'timeout' : 'network-error' };
  } finally {
    clearTimeout(timer);
  }
}

export interface RecordAuditInput {
  eventType: string;
  plane?: 'workflow' | 'runtime';
  platform?: string;
  surface?: 'local' | 'cloud' | 'ci' | 'unknown';
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  correlationId?: string;
  actor?: AuditEvent['actor'];
  change?: string | null;
  flow?: string | null;
  stage?: string | null;
  workPackage?: string | null;
  revision?: Partial<GovernanceRevision>;
  refs?: Partial<AuditEvent['refs']>;
  decision?: string | null;
  reason?: string | null;
  outcome?: AuditEvent['outcome'];
  durationMs?: number | null;
  input?: unknown;
  output?: unknown;
  coverage?: AuditEvent['coverage'];
  deliver?: boolean;
  inputDigest?: string;
}

export async function recordAudit(project: ProjectContext, input: RecordAuditInput): Promise<AuditEvent> {
  const remoteConfigured = Boolean(project.manifest.audit?.remote);
  const event = await appendEvent(project, {
    apiVersion: 'xforge.dev/v1alpha2', kind: 'AuditEvent', eventId: randomUUID(), eventType: input.eventType,
    timestamp: new Date().toISOString(), plane: input.plane ?? 'workflow', platform: input.platform ?? 'xforge', surface: input.surface ?? 'local',
    sessionId: input.sessionId ?? 'unknown', turnId: input.turnId ?? 'unknown', toolCallId: input.toolCallId ?? 'unknown', correlationId: input.correlationId ?? randomUUID(),
    actor: input.actor ?? { id: process.env.USER ?? 'unknown', provider: 'local-os', role: 'operator', type: 'system' },
    change: input.change ?? null, flow: input.flow ?? null, stage: input.stage ?? null, workPackage: input.workPackage ?? null,
    stateRevision: input.revision?.stateRevision ?? 'unknown', gitBase: input.revision?.gitBase ?? 'unknown', gitHead: input.revision?.gitHead ?? 'unknown',
    refs: { rules: input.refs?.rules ?? [], policies: input.refs?.policies ?? [], gates: input.refs?.gates ?? [] },
    decision: input.decision ?? null, reason: input.reason ?? null, outcome: input.outcome ?? 'unknown', durationMs: input.durationMs ?? null,
    inputDigest: input.inputDigest ?? sha256(stableStringify(input.input ?? null)), outputDigest: sha256(stableStringify(input.output ?? null)),
    redaction: project.manifest.audit?.redaction ?? 'metadata-only', coverage: input.coverage ?? { observed: true, gaps: [] },
    deliveryState: remoteConfigured && input.deliver !== false ? 'pending' : 'not-configured',
  });
  if (input.change) await updateChangeIndex(project, input.change);
  if (!remoteConfigured || input.deliver === false) return event;

  const delivery = await deliverRemote(project, event);
  const deliveryEvent = await appendEvent(project, {
    apiVersion: 'xforge.dev/v1alpha2', kind: 'AuditEvent', eventId: randomUUID(), eventType: 'audit.delivery', timestamp: new Date().toISOString(),
    plane: 'workflow', platform: 'xforge', surface: input.surface ?? 'local', sessionId: input.sessionId ?? 'unknown', turnId: input.turnId ?? 'unknown', toolCallId: 'unknown', correlationId: event.correlationId,
    actor: { id: 'xforge-audit', provider: 'xforge', role: 'system', type: 'system' }, change: input.change ?? null, flow: input.flow ?? null, stage: input.stage ?? null, workPackage: null,
    stateRevision: event.stateRevision, gitBase: event.gitBase, gitHead: event.gitHead, refs: { rules: [], policies: [], gates: [] }, decision: delivery.delivered ? 'delivered' : 'spooled', reason: delivery.reason,
    outcome: delivery.delivered ? 'succeeded' : 'spooled', durationMs: null, inputDigest: event.hash, outputDigest: sha256(delivery.reason ?? 'delivered'), redaction: 'metadata-only', coverage: { observed: true, gaps: [] },
    deliveryState: delivery.delivered ? 'delivered' : 'spooled',
  });
  if (input.change) await updateChangeIndex(project, input.change);
  return deliveryEvent;
}

export async function retryAuditDelivery(project: ProjectContext): Promise<{ attempted: number; delivered: number }> {
  const events = await readAuditEvents(project);
  const deliveredHashes = new Set(events.filter((event) => event.eventType === 'audit.delivery' && event.outcome === 'succeeded').map((event) => event.inputDigest));
  const pending = events.filter((event) => event.deliveryState === 'pending' && !deliveredHashes.has(event.hash));
  let delivered = 0;
  for (const event of pending) {
    const result = await deliverRemote(project, event);
    if (!result.delivered) continue;
    delivered += 1;
    await recordAudit(project, { eventType: 'audit.delivery', change: event.change, flow: event.flow, stage: event.stage, correlationId: event.correlationId, revision: { stateRevision: event.stateRevision, gitBase: event.gitBase, gitHead: event.gitHead }, decision: 'delivered', outcome: 'succeeded', inputDigest: event.hash, deliver: false });
  }
  return { attempted: pending.length, delivered };
}
