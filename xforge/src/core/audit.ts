import { createHmac, randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AuditEvent, GovernanceRevision, ProjectContext } from '../types.js';
import { atomicWrite } from './files.js';
import { sha256, stableStringify } from './hash.js';
import { safeResolve } from './path-safety.js';

const AUDIT_DIRECTORY = 'xforge/.audit';
/** The global chain. Also the legacy single-file log that older projects still carry. */
const GLOBAL_LOG = `${AUDIT_DIRECTORY}/events.jsonl`;
/** One append-only chain per Change so concurrent Changes/worktrees cannot fork a shared chain. */
const SHARD_DIRECTORY = `${AUDIT_DIRECTORY}/changes`;
const LOCK_DIRECTORY = `${AUDIT_DIRECTORY}/.locks`;
const ANCHORS_FILE = `${AUDIT_DIRECTORY}/anchors.json`;
const GLOBAL_SHARD_KEY = '_global';
const CHANGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const TAIL_WINDOW_BYTES = 65_536;
const INDEX_VERSION = 2;
/** Workflow events are the auditable decisions; runtime events are summarized, not enumerated. */
const INDEX_EVENT_LIMIT = 1_000;

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

function isChangeId(value: string | null | undefined): value is string {
  return typeof value === 'string' && CHANGE_ID_PATTERN.test(value);
}

/** Events for an unrecognized Change ID stay on the global chain instead of creating a stray shard. */
function shardKeyFor(changeId: string | null | undefined): string | null {
  return isChangeId(changeId) ? changeId : null;
}

function shardRelative(shardKey: string | null): string {
  return shardKey === null ? GLOBAL_LOG : `${SHARD_DIRECTORY}/${shardKey}.jsonl`;
}

async function acquireLock(project: ProjectContext, shardKey: string | null): Promise<() => Promise<void>> {
  const relative = `${LOCK_DIRECTORY}/${shardKey ?? GLOBAL_SHARD_KEY}.lock`;
  const lock = await safeResolve(project.root, relative);
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

function parseLines(source: string): AuditEvent[] {
  return source.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as AuditEvent);
}

async function readLog(project: ProjectContext, shardKey: string | null): Promise<AuditEvent[]> {
  const absolute = await safeResolve(project.root, shardRelative(shardKey));
  if (!await exists(absolute)) return [];
  return parseLines(await readFile(absolute, 'utf8'));
}

async function shardKeys(project: ProjectContext): Promise<string[]> {
  const directory = await safeResolve(project.root, SHARD_DIRECTORY);
  const names = await readdir(directory).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -'.jsonl'.length)).filter(isChangeId).sort();
}

/**
 * All audit events known to this working tree: the global/legacy chain first, then every per-Change
 * chain in a stable order. Consumers filter by `change`; cross-shard order is not chronological.
 */
export async function readAuditEvents(project: ProjectContext): Promise<AuditEvent[]> {
  const events = await readLog(project, null);
  for (const key of await shardKeys(project)) events.push(...await readLog(project, key));
  return events;
}

/** Events belonging to one Change: legacy entries still on the global chain, then its own shard. */
export async function readChangeLogEvents(project: ProjectContext, changeId: string): Promise<AuditEvent[]> {
  const legacy = (await readLog(project, null)).filter((event) => event.change === changeId);
  const key = shardKeyFor(changeId);
  return key === null ? legacy : [...legacy, ...await readLog(project, key)];
}

function eventHash(event: Omit<AuditEvent, 'hash'>): string {
  return sha256(stableStringify(event));
}

/* ------------------------------------------------------------------ anchors */

interface EventTypeSummary { count: number; lastTimestamp: string; lastHash: string }

interface AnchorRecord {
  /** previousHash the first retained event of the shard must carry. */
  base: string | null;
  prunedCount: number;
  prunedThrough: string | null;
  prunedAt: string | null;
  /** Event types dropped by retention, so a rebuilt index still reports what once existed. */
  prunedEventTypes?: Record<string, EventTypeSummary>;
}

type AnchorFile = Record<string, AnchorRecord>;

function emptyAnchor(base: string | null = null): AnchorRecord {
  return { base, prunedCount: 0, prunedThrough: null, prunedAt: null, prunedEventTypes: {} };
}

function mergeTypeSummary(target: Record<string, EventTypeSummary>, event: AuditEvent): void {
  const existing = target[event.eventType];
  target[event.eventType] = { count: (existing?.count ?? 0) + 1, lastTimestamp: event.timestamp, lastHash: event.hash };
}

async function readAnchors(project: ProjectContext): Promise<AnchorFile> {
  const absolute = await safeResolve(project.root, ANCHORS_FILE);
  try {
    const parsed = JSON.parse(await readFile(absolute, 'utf8')) as { shards?: AnchorFile };
    return parsed.shards ?? {};
  } catch { return {}; }
}

async function writeAnchors(project: ProjectContext, anchors: AnchorFile): Promise<void> {
  await atomicWrite(project.root, ANCHORS_FILE, `${JSON.stringify({ apiVersion: 'xforge.dev/v1alpha2', kind: 'AuditAnchors', shards: anchors }, null, 2)}\n`);
}

/**
 * The genesis anchor of a shard. Recorded when the shard is created (or pruned); derived from the
 * legacy global chain when no record exists, so a project migrating from a single `events.jsonl`
 * keeps verifying without ever rewriting a historical event.
 */
async function anchorFor(project: ProjectContext, shardKey: string | null, anchors?: AnchorFile): Promise<AnchorRecord> {
  const file = anchors ?? await readAnchors(project);
  const recorded = file[shardKey ?? GLOBAL_SHARD_KEY];
  if (recorded) return recorded;
  if (shardKey === null) return emptyAnchor(null);
  const legacy = (await readLog(project, null)).filter((event) => event.change === shardKey);
  return emptyAnchor(legacy.at(-1)?.hash ?? null);
}

async function persistAnchor(project: ProjectContext, shardKey: string | null, record: AnchorRecord): Promise<void> {
  const release = await acquireLock(project, `${shardKey ?? GLOBAL_SHARD_KEY}-anchors`);
  try {
    const anchors = await readAnchors(project);
    anchors[shardKey ?? GLOBAL_SHARD_KEY] = record;
    await writeAnchors(project, anchors);
  } finally {
    await release();
  }
}

/* ------------------------------------------------------------------ chain head */

const tailCache = new Map<string, { size: number; head: string | null }>();

/** O(1) chain-head read: only the tail of the shard is parsed, so appends do not rescan the log. */
async function chainHead(absolute: string): Promise<{ head: string | null; size: number }> {
  let size: number;
  try { size = (await stat(absolute)).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { head: null, size: 0 };
    throw error;
  }
  if (size === 0) return { head: null, size };
  const cached = tailCache.get(absolute);
  if (cached && cached.size === size) return { head: cached.head, size };
  let head: string | null = null;
  const handle = await open(absolute, 'r');
  try {
    const length = Math.min(size, TAIL_WINDOW_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    if (length < size) {
      const boundary = text.indexOf('\n');
      text = boundary >= 0 ? text.slice(boundary + 1) : '';
    }
    const last = text.split('\n').filter((line) => line.trim().length > 0).at(-1);
    if (last) head = (JSON.parse(last) as AuditEvent).hash ?? null;
    else head = parseLines(await readFile(absolute, 'utf8')).at(-1)?.hash ?? null;
  } finally {
    await handle.close();
  }
  tailCache.set(absolute, { size, head });
  return { head, size };
}

/* ------------------------------------------------------------------ verification */

export interface AuditVerification {
  valid: boolean;
  head: string | null;
  eventCount: number;
  diagnostics: Array<{ code: string; message: string; eventId?: string }>;
  remotePending: number;
  /** Per-shard chain heads: `_global` plus one entry per Change shard. */
  shards?: Record<string, string | null>;
}

function verifyChain(events: AuditEvent[], base: string | null): { diagnostics: AuditVerification['diagnostics']; head: string | null } {
  const diagnostics: AuditVerification['diagnostics'] = [];
  let previous = base;
  for (const event of events) {
    const { hash, ...unsigned } = event;
    if (hash !== eventHash(unsigned)) diagnostics.push({ code: 'XFORGE_AUDIT_HASH_INVALID', message: 'Audit event hash does not match its content.', eventId: event.eventId });
    if (event.previousHash !== previous) diagnostics.push({ code: 'XFORGE_AUDIT_CHAIN_BROKEN', message: 'Audit previousHash does not match the chain head.', eventId: event.eventId });
    previous = hash;
  }
  return { diagnostics, head: previous };
}

function pendingDelivery(events: AuditEvent[], scope: AuditEvent[]): number {
  const delivered = new Set(events.filter((event) => event.eventType === 'audit.delivery' && event.outcome === 'succeeded').map((event) => event.inputDigest));
  const spooled = new Set(events.filter((event) => event.eventType === 'audit.delivery' && event.outcome === 'spooled').map((event) => event.inputDigest));
  return scope.filter((event) => event.deliveryState === 'pending' && !delivered.has(event.hash) && (spooled.has(event.hash) || event.eventType !== 'audit.delivery')).length;
}

export async function verifyAudit(project: ProjectContext, changeId?: string): Promise<AuditVerification> {
  const diagnostics: AuditVerification['diagnostics'] = [];
  const shards: Record<string, string | null> = {};
  const all: AuditEvent[] = [];
  let keys: string[];
  try { keys = await shardKeys(project); }
  catch (error) { return { valid: false, head: null, eventCount: 0, remotePending: 0, diagnostics: [{ code: 'XFORGE_AUDIT_PARSE_FAILED', message: (error as Error).message }] }; }
  const anchors = await readAnchors(project);
  const heads = new Map<string | null, string | null>();
  try {
    for (const key of [null, ...keys] as Array<string | null>) {
      const events = await readLog(project, key);
      const anchor = await anchorFor(project, key, anchors);
      const result = verifyChain(events, anchor.base);
      diagnostics.push(...result.diagnostics);
      shards[key ?? GLOBAL_SHARD_KEY] = result.head;
      heads.set(key, result.head);
      all.push(...events);
    }
  } catch (error) {
    return { valid: false, head: null, eventCount: 0, remotePending: 0, diagnostics: [{ code: 'XFORGE_AUDIT_PARSE_FAILED', message: (error as Error).message }] };
  }
  const scope = changeId ? all.filter((event) => event.change === changeId) : all;
  const head = changeId
    ? heads.get(shardKeyFor(changeId)) ?? scope.at(-1)?.hash ?? null
    : all.length === 0 ? null : sha256(stableStringify(shards));
  return { valid: diagnostics.length === 0, head, eventCount: all.length, diagnostics, remotePending: pendingDelivery(all, scope), shards };
}

/* ------------------------------------------------------------------ committed per-Change index */

export interface AuditIndexEventSummary {
  eventId: string;
  eventType: string;
  timestamp: string;
  plane: 'workflow' | 'runtime';
  stateRevision: string;
  outcome: AuditEvent['outcome'];
  deliveryState: AuditEvent['deliveryState'];
  /**
   * Lets the committed index attest a *specific* subject, not just "an event of this type
   * happened". `approvalVerifiedInChain` uses it to confirm that a given Approval receipt was
   * verified by an environment that held the provider secret, so an Agent — which never holds it —
   * can still trust that receipt on a fresh clone.
   */
  inputDigest: string;
  hash: string;
}

export interface AuditIndexDocument {
  apiVersion: 'xforge.dev/v1alpha2';
  kind: 'AuditIndex';
  version: number;
  change: string;
  generatedAt: string;
  chain: { anchor: string | null; head: string | null; eventCount: number; valid: boolean; prunedCount: number; prunedThrough: string | null };
  delivery: { remoteConfigured: boolean; pending: number; delivered: number };
  eventTypes: Record<string, { count: number; lastTimestamp: string; lastHash: string }>;
  coverageGaps: string[];
  runtimeEventCount: number;
  events: AuditIndexEventSummary[];
  eventsTruncated: boolean;
  /** Mirrors of `chain.*` kept for readers of the v1 index layout. */
  chainHead: string | null;
  chainValid: boolean;
  /** sha256 over the whole document minus this field; a hand-edited index fails to match. */
  digest: string;
}

export function auditIndexDigest(document: Omit<AuditIndexDocument, 'digest'> & { digest?: string }): string {
  const { digest: _ignored, ...unsigned } = document;
  return sha256(stableStringify(unsigned));
}

function summarize(event: AuditEvent): AuditIndexEventSummary {
  return {
    eventId: event.eventId, eventType: event.eventType, timestamp: event.timestamp, plane: event.plane,
    stateRevision: event.stateRevision, outcome: event.outcome, deliveryState: event.deliveryState,
    inputDigest: event.inputDigest, hash: event.hash,
  };
}

async function resolveChangeRoot(project: ProjectContext, changeId: string): Promise<string | null> {
  const active = `${project.changesPath}/${changeId}`;
  if (await exists(await safeResolve(project.root, active))) return active;
  const archiveRoot = await safeResolve(project.root, `${project.changesPath}/archive`);
  const names = await readdir(archiveRoot).catch(() => [] as string[]);
  const archived = names.filter((name) => name === changeId || name.endsWith(`-${changeId}`)).sort().at(-1);
  return archived ? `${project.changesPath}/archive/${archived}` : null;
}

async function indexPathFor(project: ProjectContext, changeId: string): Promise<string | null> {
  const root = await resolveChangeRoot(project, changeId);
  return root ? `${root}/evidence/audit/index.json` : null;
}

export interface LoadedAuditIndex {
  path: string;
  document: AuditIndexDocument;
  digestValid: boolean;
}

/** Reads the committed per-Change index. Returns null when the Change has no index on disk. */
export async function readChangeAuditIndex(project: ProjectContext, changeId: string): Promise<LoadedAuditIndex | null> {
  const relative = await indexPathFor(project, changeId);
  if (!relative) return null;
  let document: AuditIndexDocument;
  try { document = JSON.parse(await readFile(await safeResolve(project.root, relative), 'utf8')) as AuditIndexDocument; }
  catch { return null; }
  if (document?.kind !== 'AuditIndex') return null;
  const digestValid = typeof document.digest === 'string' && document.digest === auditIndexDigest(document) && document.change === changeId;
  return { path: relative, document, digestValid };
}

function emptyIndex(changeId: string, anchor: AnchorRecord, remoteConfigured: boolean): Omit<AuditIndexDocument, 'digest'> {
  return {
    apiVersion: 'xforge.dev/v1alpha2', kind: 'AuditIndex', version: INDEX_VERSION, change: changeId,
    generatedAt: new Date().toISOString(),
    chain: { anchor: anchor.base, head: anchor.base, eventCount: anchor.prunedCount, valid: true, prunedCount: anchor.prunedCount, prunedThrough: anchor.prunedThrough },
    delivery: { remoteConfigured, pending: 0, delivered: 0 },
    eventTypes: { ...(anchor.prunedEventTypes ?? {}) }, coverageGaps: [], runtimeEventCount: 0, events: [], eventsTruncated: false,
    chainHead: anchor.base, chainValid: true,
  };
}

function applyEvent(document: Omit<AuditIndexDocument, 'digest'>, event: AuditEvent): void {
  document.chain.head = event.hash;
  document.chain.eventCount += 1;
  document.chainHead = event.hash;
  const type = document.eventTypes[event.eventType] ?? { count: 0, lastTimestamp: event.timestamp, lastHash: event.hash };
  document.eventTypes[event.eventType] = { count: type.count + 1, lastTimestamp: event.timestamp, lastHash: event.hash };
  if (event.deliveryState === 'pending') document.delivery.pending += 1;
  if (event.eventType === 'audit.delivery' && event.outcome === 'succeeded') {
    document.delivery.delivered += 1;
    document.delivery.pending = Math.max(0, document.delivery.pending - 1);
  }
  for (const gap of event.coverage.gaps) if (!document.coverageGaps.includes(gap)) document.coverageGaps.push(gap);
  if (event.plane === 'runtime') document.runtimeEventCount += 1;
  else if (document.events.length < INDEX_EVENT_LIMIT) document.events.push(summarize(event));
  else document.eventsTruncated = true;
}

async function writeIndex(project: ProjectContext, changeId: string, document: Omit<AuditIndexDocument, 'digest'>): Promise<void> {
  const relative = await indexPathFor(project, changeId);
  if (!relative) return;
  document.generatedAt = new Date().toISOString();
  document.coverageGaps.sort();
  const complete: AuditIndexDocument = { ...document, digest: auditIndexDigest(document) };
  await atomicWrite(project.root, relative, `${JSON.stringify(complete, null, 2)}\n`);
}

/**
 * Rebuilds the committed index from the local chain, including a full chain verification.
 * O(events for this Change); used for workflow-plane events and explicit refreshes.
 */
/**
 * Folds the already-committed index into a freshly rebuilt one so the rebuild can only ever add
 * information. Without this, a rebuild is authoritative over the committed artifact: on a fresh
 * clone or in CI the local chain is empty, so the first `recordAudit` would write an empty index
 * over the Change's committed audit history — destroying the very evidence archive depends on.
 */
function mergeCommittedIndex(
  fresh: Omit<AuditIndexDocument, 'digest'>,
  committed: AuditIndexDocument,
): Omit<AuditIndexDocument, 'digest'> {
  for (const [type, summary] of Object.entries(committed.eventTypes)) {
    const local = fresh.eventTypes[type];
    /* Counts are informational; presence is what archive tests. Keep whichever side saw more, and
       the later observation, so neither a fresh clone nor a pruned prefix loses a type. */
    if (!local || summary.count > local.count) fresh.eventTypes[type] = { ...summary };
    else if (Date.parse(summary.lastTimestamp) > Date.parse(local.lastTimestamp)) {
      fresh.eventTypes[type] = { ...local, lastTimestamp: summary.lastTimestamp, lastHash: summary.lastHash };
    }
  }
  for (const gap of committed.coverageGaps) if (!fresh.coverageGaps.includes(gap)) fresh.coverageGaps.push(gap);
  fresh.chain.eventCount = Math.max(fresh.chain.eventCount, committed.chain.eventCount);
  fresh.chain.prunedCount = Math.max(fresh.chain.prunedCount, committed.chain.prunedCount);
  fresh.chain.prunedThrough ??= committed.chain.prunedThrough;
  fresh.delivery.delivered = Math.max(fresh.delivery.delivered, committed.delivery.delivered);
  fresh.runtimeEventCount = Math.max(fresh.runtimeEventCount, committed.runtimeEventCount);
  /*
   * Union by eventId, not "copy only when fresh has none": a second local event recorded after a
   * fresh-clone rebuild (e.g. a later Stage transition) must not silently drop the committed
   * Approval/Gate events a first rebuild had just folded in — `approvalVerifiedInChain` depends on
   * every prior `approval.decided` event surviving every subsequent rebuild, not just the first.
   */
  if (committed.events.length > 0) {
    const seen = new Set(fresh.events.map((item) => item.eventId));
    const merged = [...fresh.events];
    for (const item of committed.events) {
      if (seen.has(item.eventId)) continue;
      seen.add(item.eventId);
      merged.push({ ...item });
    }
    merged.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    fresh.eventsTruncated = fresh.eventsTruncated || committed.eventsTruncated || merged.length > INDEX_EVENT_LIMIT;
    fresh.events = merged.slice(0, INDEX_EVENT_LIMIT);
    fresh.chain.head ??= committed.chain.head;
    fresh.chainHead ??= committed.chainHead;
    fresh.delivery.pending = Math.max(fresh.delivery.pending, committed.delivery.pending);
  }
  return fresh;
}

export async function refreshChangeAuditIndex(project: ProjectContext, changeId: string): Promise<AuditIndexDocument | null> {
  if (!isChangeId(changeId)) return null;
  const relative = await indexPathFor(project, changeId);
  if (!relative) return null;
  const shardKey = shardKeyFor(changeId);
  const anchor = await anchorFor(project, shardKey);
  const legacy = (await readLog(project, null)).filter((event) => event.change === changeId);
  const shard = shardKey === null ? [] : await readLog(project, shardKey);
  let document = emptyIndex(changeId, anchor, Boolean(project.manifest.audit?.remote));
  for (const event of [...legacy, ...shard]) applyEvent(document, event);
  const verification = verifyChain(shard, anchor.base);
  const valid = verification.diagnostics.length === 0;
  document.chain.valid = valid;
  document.chainValid = valid;
  document.delivery.pending = pendingDelivery([...legacy, ...shard], [...legacy, ...shard]);
  /* A tampered index is deliberately NOT merged: an unverifiable document must not be able to
     inject event types, and readChangeAuditEvents already reports it as untrusted. */
  const committed = await readChangeAuditIndex(project, changeId);
  if (committed?.digestValid) document = mergeCommittedIndex(document, committed.document);
  await writeIndex(project, changeId, document);
  return { ...document, digest: auditIndexDigest(document) };
}

/** O(1) index maintenance for high-volume runtime events; falls back to a rebuild when out of sync. */
async function recordIndexEvent(project: ProjectContext, changeId: string, event: AuditEvent): Promise<void> {
  if (!isChangeId(changeId)) return;
  if (event.plane !== 'runtime') { await refreshChangeAuditIndex(project, changeId); return; }
  const loaded = await readChangeAuditIndex(project, changeId);
  if (!loaded || !loaded.digestValid || loaded.document.version !== INDEX_VERSION || loaded.document.chain.head !== event.previousHash) {
    await refreshChangeAuditIndex(project, changeId);
    return;
  }
  const { digest: _ignored, ...document } = loaded.document;
  applyEvent(document, event);
  await writeIndex(project, changeId, document);
}

/**
 * Whether a specific Approval receipt was verified by an environment that could verify it.
 *
 * XForge is meant to be driven by an Agent, and an Agent must never hold an approval provider's
 * secret — so on the Agent's machine an external receipt's HMAC can never be re-checked. Requiring
 * re-verification on every read therefore made the terminal `xforge archive` impossible for the
 * very actor the product is built around, which is not the posture OpenSpec's plain `archive`
 * command sets.
 *
 * The verification did happen once, in the environment that ran `xforge approve`, and that fact is
 * already recorded: `approval.decided` carries `sha256({policy, receipt})` as its `inputDigest`,
 * inside a hash chain whose committed per-Change index survives a fresh clone. Matching against it
 * is an offline check of "this receipt was accepted by a verifying environment" — forging it means
 * rewriting the chain, which is exactly what the chain exists to detect. A hand-placed receipt that
 * never went through `approve` has no such event and is still refused.
 */
export async function approvalVerifiedInChain(
  project: ProjectContext,
  changeId: string,
  policyId: string,
  receiptDigest: string,
): Promise<boolean> {
  const expected = sha256(stableStringify({ policy: policyId, receipt: receiptDigest }));
  const local = await readChangeLogEvents(project, changeId);
  if (local.some((event) => event.eventType === 'approval.decided' && event.inputDigest === expected)) return true;
  /* Fresh clone / CI: the chain file is gitignored, the committed index is not. */
  const committed = await readChangeAuditIndex(project, changeId);
  if (!committed?.digestValid) return false;
  return committed.document.events.some((event) => event.eventType === 'approval.decided' && event.inputDigest === expected);
}

/* ------------------------------------------------------------------ archive-facing read API */

export interface ChangeAuditFacts {
  change: string;
  /** Where the facts came from: the local chain, the committed index, both, or nothing at all. */
  source: 'log' | 'index' | 'merged' | 'none';
  /** True when the facts rest on a verified local chain or a digest-valid committed index. */
  trusted: boolean;
  /** Full events; empty when only the committed index is available. */
  events: AuditEvent[];
  eventTypes: string[];
  eventCount: number;
  chain: { valid: boolean; head: string | null; anchor: string | null; prunedCount: number };
  delivery: { remoteConfigured: boolean; pending: number; delivered: number };
  coverageGaps: string[];
  diagnostics: Array<{ code: string; message: string; eventId?: string }>;
  indexPath: string | null;
}

/**
 * The audit facts for one Change, usable on a machine that never ran the flow.
 *
 * `xforge/.audit/**` is gitignored, so the local chain is absent on a fresh clone or on CI. The
 * committed `<change>/evidence/audit/index.json` carries the event types, chain anchor/head and
 * delivery state, and commits to them with a `digest`, so archive can still answer its questions.
 * A hand-edited index fails the digest check and is reported as untrusted rather than believed.
 */
export async function readChangeAuditEvents(project: ProjectContext, changeId: string): Promise<ChangeAuditFacts> {
  const diagnostics: ChangeAuditFacts['diagnostics'] = [];
  const remoteConfigured = Boolean(project.manifest.audit?.remote);
  const loaded = await readChangeAuditIndex(project, changeId);
  if (loaded && !loaded.digestValid) {
    diagnostics.push({ code: 'XFORGE_AUDIT_INDEX_TAMPERED', message: `Committed audit index digest does not match its content: ${loaded.path}` });
  }
  const index = loaded?.digestValid ? loaded.document : null;

  const shardKey = shardKeyFor(changeId);
  let legacy: AuditEvent[] = [];
  let shard: AuditEvent[] = [];
  let parseFailed = false;
  try {
    legacy = (await readLog(project, null)).filter((event) => event.change === changeId);
    shard = shardKey === null ? [] : await readLog(project, shardKey);
  } catch (error) {
    parseFailed = true;
    diagnostics.push({ code: 'XFORGE_AUDIT_PARSE_FAILED', message: (error as Error).message });
  }
  const events = shardKey === null ? legacy : [...legacy, ...shard];

  const anchor = await anchorFor(project, shardKey);
  /* Legacy entries sit inside the interleaved global chain, so only their content hash is checked
     here; their linkage is covered by verifyAudit over the whole global chain. */
  for (const event of legacy) {
    const { hash, ...unsigned } = event;
    if (hash !== eventHash(unsigned)) diagnostics.push({ code: 'XFORGE_AUDIT_HASH_INVALID', message: 'Audit event hash does not match its content.', eventId: event.eventId });
  }
  const legacyInvalid = diagnostics.some((item) => item.code === 'XFORGE_AUDIT_HASH_INVALID');
  const verification = shardKey === null
    ? { diagnostics: [] as AuditVerification['diagnostics'], head: legacy.at(-1)?.hash ?? null }
    : verifyChain(shard, anchor.base);
  diagnostics.push(...verification.diagnostics);
  const logValid = !parseFailed && !legacyInvalid && verification.diagnostics.length === 0;
  const logTypes = [...new Set(events.map((event) => event.eventType))];

  const indexTypes = index ? Object.keys(index.eventTypes) : [];
  const indexCount = index ? index.chain.eventCount : 0;
  const logCount = events.length + anchor.prunedCount;

  let source: ChangeAuditFacts['source'];
  if (events.length > 0 && index && indexCount > logCount) source = 'merged';
  else if (events.length > 0) source = 'log';
  else if (index) source = 'index';
  else source = 'none';

  /* A committed index whose digest does not match is treated as a broken chain: archive must not
     accept audit facts that somebody edited by hand. */
  const tampered = Boolean(loaded && !loaded.digestValid);
  const chainValid = !tampered && (source === 'index'
    ? index!.chain.valid
    : source === 'merged' ? logValid && index!.chain.valid : logValid);

  const head = source === 'index' || source === 'merged' ? index!.chain.head : verification.head;
  const eventCount = source === 'index' || source === 'merged' ? indexCount : logCount;
  const trusted = tampered || source === 'none' ? false : source === 'log' ? logValid : Boolean(index);

  return {
    change: changeId,
    source,
    trusted,
    events,
    /** The index is a superset by construction: it survives retention pruning of the local chain. */
    eventTypes: [...new Set([...logTypes, ...indexTypes])].sort(),
    eventCount,
    chain: {
      valid: chainValid,
      head,
      anchor: index?.chain.anchor ?? anchor.base,
      prunedCount: Math.max(anchor.prunedCount, index?.chain.prunedCount ?? 0),
    },
    delivery: {
      remoteConfigured,
      pending: source === 'index' ? index!.delivery.pending : pendingDelivery(events, events),
      delivered: index?.delivery.delivered ?? events.filter((event) => event.eventType === 'audit.delivery' && event.outcome === 'succeeded').length,
    },
    coverageGaps: [...new Set([...events.flatMap((event) => event.coverage.gaps), ...(index?.coverageGaps ?? [])])].sort(),
    diagnostics,
    indexPath: loaded?.path ?? null,
  };
}

/* ------------------------------------------------------------------ append */

async function appendEvent(project: ProjectContext, changeId: string | null, event: Omit<AuditEvent, 'previousHash' | 'hash'>): Promise<AuditEvent> {
  const shardKey = shardKeyFor(changeId);
  const release = await acquireLock(project, shardKey);
  try {
    const relative = shardRelative(shardKey);
    const absolute = await safeResolve(project.root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    const anchors = await readAnchors(project);
    const created = shardKey !== null && !(shardKey in anchors) && !await exists(absolute);
    const anchor = await anchorFor(project, shardKey, anchors);
    const tail = await chainHead(absolute);
    const unsigned = { ...event, previousHash: tail.head ?? anchor.base };
    const complete: AuditEvent = { ...unsigned, hash: eventHash(unsigned) };
    const line = `${JSON.stringify(complete)}\n`;
    await appendFile(absolute, line, { encoding: 'utf8', flag: 'a' });
    tailCache.set(absolute, { size: tail.size + Buffer.byteLength(line), head: complete.hash });
    if (created) await persistAnchor(project, shardKey, anchor);
    return complete;
  } finally {
    await release();
  }
}

/* ------------------------------------------------------------------ remote delivery */

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

/**
 * Runtime-plane events are produced once per agent tool call, so they never block on an HTTP
 * round-trip: they are spooled and drained by `xforge audit retry`. Workflow-plane events are rare
 * and stay synchronous so an operator sees delivery failures immediately.
 */
function deliveryMode(project: ProjectContext, plane: 'workflow' | 'runtime'): 'inline' | 'spool' {
  return project.manifest.audit?.delivery?.[plane] ?? (plane === 'runtime' ? 'spool' : 'inline');
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
  /*
   * Test seams for fault-injection coverage of the write-then-audit compensation paths.
   * XFORGE_FAULT_AUDIT_RECORD fails before anything is appended; XFORGE_FAULT_AUDIT_INDEX fails
   * after the event is already on the chain, modelling an index-write failure.
   */
  if (process.env.XFORGE_FAULT_AUDIT_RECORD === '1') throw new Error('Injected audit record failure (XFORGE_FAULT_AUDIT_RECORD).');
  const plane = input.plane ?? 'workflow';
  const remoteConfigured = Boolean(project.manifest.audit?.remote);
  const spoolable = remoteConfigured && input.deliver !== false;
  const change = input.change ?? null;
  const event = await appendEvent(project, change, {
    apiVersion: 'xforge.dev/v1alpha2', kind: 'AuditEvent', eventId: randomUUID(), eventType: input.eventType,
    timestamp: new Date().toISOString(), plane, platform: input.platform ?? 'xforge', surface: input.surface ?? 'local',
    sessionId: input.sessionId ?? 'unknown', turnId: input.turnId ?? 'unknown', toolCallId: input.toolCallId ?? 'unknown', correlationId: input.correlationId ?? randomUUID(),
    actor: input.actor ?? { id: process.env.USER ?? 'unknown', provider: 'local-os', role: 'operator', type: 'system' },
    change, flow: input.flow ?? null, stage: input.stage ?? null, workPackage: input.workPackage ?? null,
    stateRevision: input.revision?.stateRevision ?? 'unknown', gitBase: input.revision?.gitBase ?? 'unknown', gitHead: input.revision?.gitHead ?? 'unknown',
    refs: { rules: input.refs?.rules ?? [], policies: input.refs?.policies ?? [], gates: input.refs?.gates ?? [] },
    decision: input.decision ?? null, reason: input.reason ?? null, outcome: input.outcome ?? 'unknown', durationMs: input.durationMs ?? null,
    inputDigest: input.inputDigest ?? sha256(stableStringify(input.input ?? null)), outputDigest: sha256(stableStringify(input.output ?? null)),
    redaction: project.manifest.audit?.redaction ?? 'metadata-only', coverage: input.coverage ?? { observed: true, gaps: [] },
    deliveryState: spoolable ? 'pending' : 'not-configured',
  });
  if (change) await recordIndexEvent(project, change, event);
  if (process.env.XFORGE_FAULT_AUDIT_INDEX === '1') throw new Error('Injected audit index failure (XFORGE_FAULT_AUDIT_INDEX).');
  if (!spoolable || deliveryMode(project, plane) !== 'inline') return event;

  const delivery = await deliverRemote(project, event);
  const deliveryEvent = await appendEvent(project, change, {
    apiVersion: 'xforge.dev/v1alpha2', kind: 'AuditEvent', eventId: randomUUID(), eventType: 'audit.delivery', timestamp: new Date().toISOString(),
    plane: 'workflow', platform: 'xforge', surface: input.surface ?? 'local', sessionId: input.sessionId ?? 'unknown', turnId: input.turnId ?? 'unknown', toolCallId: 'unknown', correlationId: event.correlationId,
    actor: { id: 'xforge-audit', provider: 'xforge', role: 'system', type: 'system' }, change, flow: input.flow ?? null, stage: input.stage ?? null, workPackage: null,
    stateRevision: event.stateRevision, gitBase: event.gitBase, gitHead: event.gitHead, refs: { rules: [], policies: [], gates: [] }, decision: delivery.delivered ? 'delivered' : 'spooled', reason: delivery.reason,
    outcome: delivery.delivered ? 'succeeded' : 'spooled', durationMs: null, inputDigest: event.hash, outputDigest: sha256(delivery.reason ?? 'delivered'), redaction: 'metadata-only', coverage: { observed: true, gaps: [] },
    deliveryState: delivery.delivered ? 'delivered' : 'spooled',
  });
  if (change) await recordIndexEvent(project, change, deliveryEvent);
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

/* ------------------------------------------------------------------ retention */

export interface AuditPruneResult {
  retentionDays: number | null;
  shards: number;
  removed: number;
  details: Array<{ shard: string; removed: number; anchor: string | null }>;
}

/** Counts events past `audit.localRetentionDays` without deleting anything. */
export async function expiredAuditEvents(project: ProjectContext, now = Date.now()): Promise<number> {
  const days = project.manifest.audit?.localRetentionDays;
  if (!days) return 0;
  const cutoff = now - days * 86_400_000;
  return (await readAuditEvents(project)).filter((event) => Date.parse(event.timestamp) < cutoff).length;
}

/**
 * Enforces `audit.localRetentionDays` by dropping the expired *prefix* of each per-Change chain and
 * moving that shard's anchor to the last dropped event's hash. The retained events still verify
 * against the anchor, and the committed index keeps the event-type summary of everything pruned, so
 * archive's `requiredEventTypes` question survives truncation.
 */
export async function pruneExpiredAuditEvents(project: ProjectContext, options: { retentionDays?: number; now?: number } = {}): Promise<AuditPruneResult> {
  const days = options.retentionDays ?? project.manifest.audit?.localRetentionDays ?? null;
  const result: AuditPruneResult = { retentionDays: days, shards: 0, removed: 0, details: [] };
  if (!days) return result;
  const cutoff = (options.now ?? Date.now()) - days * 86_400_000;
  const pruned: Array<string | null> = [];
  for (const key of [null, ...await shardKeys(project)] as Array<string | null>) {
    const release = await acquireLock(project, key);
    try {
      const events = await readLog(project, key);
      let boundary = 0;
      while (boundary < events.length && Date.parse(events[boundary]!.timestamp) < cutoff) boundary += 1;
      if (boundary === 0) continue;
      const removed = events.slice(0, boundary);
      const retained = events.slice(boundary);
      const anchor = await anchorFor(project, key);
      const prunedEventTypes = { ...(anchor.prunedEventTypes ?? {}) };
      for (const event of removed) mergeTypeSummary(prunedEventTypes, event);
      const next: AnchorRecord = {
        base: removed.at(-1)!.hash,
        prunedCount: anchor.prunedCount + removed.length,
        prunedThrough: removed.at(-1)!.hash,
        prunedAt: new Date().toISOString(),
        prunedEventTypes,
      };
      const relative = shardRelative(key);
      await atomicWrite(project.root, relative, retained.map((event) => `${JSON.stringify(event)}\n`).join(''));
      tailCache.delete(await safeResolve(project.root, relative));
      result.shards += 1;
      result.removed += removed.length;
      result.details.push({ shard: key ?? GLOBAL_SHARD_KEY, removed: removed.length, anchor: next.base });
      await persistAnchor(project, key, next);
      pruned.push(key);
    } finally {
      await release();
    }
  }
  /* The committed index must keep reporting what retention removed from the local chain. */
  for (const key of pruned) if (key !== null) await refreshChangeAuditIndex(project, key);
  return result;
}
