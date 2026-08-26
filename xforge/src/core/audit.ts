import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { rmSync } from 'node:fs';
import { access, appendFile, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import type { AuditEvent, GovernanceRevision, ProjectContext } from '../types.js';
import { XForgeError, diagnostic } from './errors.js';
import { atomicWrite, exists } from './files.js';
import { sha256, stableStringify } from './hash.js';
import { safeResolve } from './path-safety.js';
import { acquireLock } from './audit/locking.js';
import {
  attestableEvents, chainSigner, eventHash, eventSignature, sealEvent, signatureDiagnostic, unsignedBody,
  signBody, verdictFor, type ChainSigner, type SignatureVerdict,
} from './audit/signing.js';

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
/**
 * v3 splits the committed index's retained events into a governance-bearing set that is never
 * evicted and a bounded residual, and records that split in `governanceComplete`. A v2 index is
 * still readable — `indexGovernanceComplete` falls back to its `eventsTruncated` flag — and
 * `recordIndexEvent` rebuilds any index whose version is not the current one, so a project heals on
 * its next recorded event rather than needing a migration command.
 */
/**
 * Bumped whenever the index's own shape changes, which makes every older document rebuild itself
 * (`recordIndexEvent` falls back to `refreshChangeAuditIndex`) rather than be read under the wrong
 * schema. Exported so tests assert "current" instead of pinning a literal that goes stale.
 */
export const INDEX_VERSION = 4;
/**
 * How many *residual* (non-governance) workflow events the committed index retains. Runtime events
 * are summarized rather than enumerated, and governance events (see `GOVERNANCE_EVENT_TYPES`) are
 * exempt from this limit entirely.
 */
const INDEX_EVENT_LIMIT = 1_000;

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

/* ------------------------------------------------------------------ append lock */

/**
 * The old budget was 40 × 25ms = 1s, which is genuinely too short: one `xforge hook` runs per agent
 * tool call, and a burst of parallel tool calls contends on the same per-Change lock. A stale lock
 * no longer costs a wait at all (it is reclaimed on the first pass), so the budget only has to cover
 * real contention.
 */

/** Absolute paths of locks this process currently holds, for the best-effort exit sweep. */

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
  /* A reclaim here is not recorded: this lock is taken while the shard lock is already held, so
     writing an event would deadlock. The reclaim of the shard lock itself is the one that matters. */
  const { release } = await acquireLock(project, `${shardKey ?? GLOBAL_SHARD_KEY}-anchors`);
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

interface AuditVerification {
  valid: boolean;
  head: string | null;
  eventCount: number;
  diagnostics: Array<{ code: string; message: string; eventId?: string }>;
  remotePending: number;
  /** Per-shard chain heads: `_global` plus one entry per Change shard. */
  shards?: Record<string, string | null>;
}

function verifyChain(events: AuditEvent[], base: string | null, signer: ChainSigner): { diagnostics: AuditVerification['diagnostics']; head: string | null } {
  const diagnostics: AuditVerification['diagnostics'] = [];
  let previous = base;
  for (const event of events) {
    if (event.hash !== eventHash(unsignedBody(event))) diagnostics.push({ code: 'XFORGE_AUDIT_HASH_INVALID', message: 'Audit event hash does not match its content.', eventId: event.eventId });
    if (event.previousHash !== previous) diagnostics.push({ code: 'XFORGE_AUDIT_CHAIN_BROKEN', message: 'Audit previousHash does not match the chain head.', eventId: event.eventId });
    const verdict = eventSignature(signer, event);
    if (verdict !== 'ok') diagnostics.push(signatureDiagnostic(verdict, signer, 'Audit event', event.eventId));
    previous = event.hash;
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
  const signer = chainSigner(project);
  const heads = new Map<string | null, string | null>();
  try {
    for (const key of [null, ...keys] as Array<string | null>) {
      const events = await readLog(project, key);
      const anchor = await anchorFor(project, key, anchors);
      const result = verifyChain(events, anchor.base, signer);
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

interface AuditIndexEventSummary {
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

interface AuditIndexDocument {
  apiVersion: 'xforge.dev/v1alpha2';
  kind: 'AuditIndex';
  version: number;
  change: string;
  generatedAt: string;
  chain: { anchor: string | null; head: string | null; eventCount: number; valid: boolean; prunedCount: number; prunedThrough: string | null };
  /**
   * `remoteDeclared` is a Manifest fact: the project names the environment variables a remote sink
   * would be read from. `remoteEndpointResolved` is an environment fact: that variable actually has
   * a value in the process writing this index.
   *
   * They were one field, `remoteConfigured`, computed as `Boolean(manifest.audit?.remote)` — and the
   * shipped Manifest always carries that block, so it read `true` in every project that had never
   * configured anything. Beside `delivered: 0` and a four-figure `pending`, a live run read it as
   * "delivery is set up and failing" when the truth was "no endpoint was ever set". One field could
   * not say both things, and the one it did say was the one nobody needed.
   */
  delivery: { remoteDeclared: boolean; remoteEndpointResolved: boolean; pending: number; delivered: number };
  eventTypes: Record<string, { count: number; lastTimestamp: string; lastHash: string }>;
  coverageGaps: string[];
  runtimeEventCount: number;
  events: AuditIndexEventSummary[];
  /**
   * Whether `events` is missing any *residual* (non-governance) workflow event this Change produced.
   * Ordinary volume trips this — it says nothing about whether the index can still answer a
   * governance question, which is what `governanceComplete` is for.
   */
  eventsTruncated: boolean;
  /**
   * Whether every governance-bearing event this index ever saw is still in `events`. True for any
   * index built by v3 or later, because those event types are exempt from `INDEX_EVENT_LIMIT`; false
   * only when a v2 index that had already dropped events (and could have dropped governance ones,
   * since v2 evicted the *newest*) was folded in and the local chain could not be shown to cover it.
   * Absent on v2 documents — read it through `indexGovernanceComplete`, never directly.
   */
  governanceComplete?: boolean;
  /** Mirrors of `chain.*` kept for readers of the v1 index layout. */
  chainHead: string | null;
  chainValid: boolean;
  /** HMAC over the document minus `digest` and this field; present only when the chain is signed. */
  hmac?: string;
  /** sha256 over the whole document minus this field; a hand-edited index fails to match. */
  digest: string;
}

/**
 * The event types the attestation readers in this file reason from, and therefore the ones the
 * committed index may never evict.
 *
 * The v2 index kept the *oldest* `INDEX_EVENT_LIMIT` workflow events, and governance events happen
 * at Stage boundaries — i.e. late — while `runGate` emits `gate.before`/`gate.after` per gate run
 * (doubled when remote delivery is inline). A Change with a handful of work packages crosses 1000
 * events in a few dozen edit-then-check cycles, at which point the index silently stopped recording
 * exactly the events archive depends on. The consequence only ever appeared on a fresh clone or in
 * CI, where the gitignored local chain is absent and the committed index is the sole source: the
 * Approval receipt read as unverified and archive became permanently impossible while the laptop
 * that ran the flow kept working. Exempting these types is what makes the limit a cap on *noise*.
 *
 * Every literal here is one the readers below actually consult — `approvalVerifiedInChain`,
 * `readAcknowledgementAttestations` (via `ACKNOWLEDGEMENT_EVENT_TYPES`) and
 * `readTransitionAttestations` (via `TRANSITION_EVENT_TYPE`). Adding a reader that reasons from a
 * new event type means adding that type here, or it will silently start losing its evidence at
 * volume; the set is assembled from those same constants so the two cannot drift.
 */
const GOVERNANCE_EVENT_TYPES = new Set<string>();

/** Unbounded by design: a Change produces a handful of these, not thousands. */
function isGovernanceEvent(eventType: string): boolean {
  return GOVERNANCE_EVENT_TYPES.has(eventType);
}

/** v2 documents predate the flag; their `eventsTruncated` carried exactly this meaning. */
function indexGovernanceComplete(document: AuditIndexDocument): boolean {
  return document.governanceComplete ?? !document.eventsTruncated;
}

/**
 * Applies `INDEX_EVENT_LIMIT` to the residual events only, evicting the oldest first.
 *
 * `document.events` is in chain order on a rebuild and in timestamp order after a merge, so the
 * front of the residual really is its oldest end. Governance events keep their positions, so the
 * retained list stays a chronologically ordered subset either way.
 */
function enforceEventLimit(document: Omit<AuditIndexDocument, 'digest'>): void {
  let residual = 0;
  for (const event of document.events) if (!isGovernanceEvent(event.eventType)) residual += 1;
  if (residual <= INDEX_EVENT_LIMIT) return;
  let evictable = residual - INDEX_EVENT_LIMIT;
  document.events = document.events.filter((event) => {
    if (evictable === 0 || isGovernanceEvent(event.eventType)) return true;
    evictable -= 1;
    return false;
  });
  document.eventsTruncated = true;
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

interface LoadedAuditIndex {
  path: string;
  document: AuditIndexDocument;
  /** True only when the document is both self-consistent and (when signed) correctly signed. */
  digestValid: boolean;
  /** `ok` for every project that does not declare `audit.chain.hmacSecretEnv`. */
  signature: SignatureVerdict;
}

/** Reads the committed per-Change index. Returns null when the Change has no index on disk. */
export async function readChangeAuditIndex(project: ProjectContext, changeId: string): Promise<LoadedAuditIndex | null> {
  const relative = await indexPathFor(project, changeId);
  if (!relative) return null;
  let document: AuditIndexDocument;
  try { document = JSON.parse(await readFile(await safeResolve(project.root, relative), 'utf8')) as AuditIndexDocument; }
  catch { return null; }
  if (document?.kind !== 'AuditIndex') return null;
  const { digest: _digest, hmac, ...body } = document;
  const signature = verdictFor(chainSigner(project), hmac, body);
  const selfConsistent = typeof document.digest === 'string' && document.digest === auditIndexDigest(document) && document.change === changeId;
  /* Fails closed on every signature verdict other than `ok`, including "signed but this environment
     holds no secret": a reader that cannot check the signature must not fall back to the unkeyed
     digest, or declaring a secret would buy nothing. */
  return { path: relative, document, digestValid: selfConsistent && signature === 'ok', signature };
}

/** The two independent facts about remote delivery, read once. */
function remoteDeliveryFacts(project: ProjectContext): { declared: boolean; resolved: boolean } {
  const remote = project.manifest.audit?.remote;
  return { declared: Boolean(remote), resolved: Boolean(remote?.endpointEnv && process.env[remote.endpointEnv]) };
}

function emptyIndex(changeId: string, anchor: AnchorRecord, remote: { declared: boolean; resolved: boolean }): Omit<AuditIndexDocument, 'digest'> {
  return {
    apiVersion: 'xforge.dev/v1alpha2', kind: 'AuditIndex', version: INDEX_VERSION, change: changeId,
    generatedAt: new Date().toISOString(),
    chain: { anchor: anchor.base, head: anchor.base, eventCount: anchor.prunedCount, valid: true, prunedCount: anchor.prunedCount, prunedThrough: anchor.prunedThrough },
    delivery: { remoteDeclared: remote.declared, remoteEndpointResolved: remote.resolved, pending: 0, delivered: 0 },
    eventTypes: { ...(anchor.prunedEventTypes ?? {}) }, coverageGaps: [], runtimeEventCount: 0, events: [], eventsTruncated: false,
    governanceComplete: true,
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
  /* Every workflow event is retained on the way in. The limit is applied once, in `writeIndex`, and
     only to the residual — so a governance event can never be refused entry because of gate noise,
     and a rebuild costs one pass over the chain rather than one eviction scan per event. */
  else document.events.push(summarize(event));
}

async function writeIndex(project: ProjectContext, changeId: string, document: Omit<AuditIndexDocument, 'digest'>): Promise<AuditIndexDocument | null> {
  const relative = await indexPathFor(project, changeId);
  if (!relative) return null;
  const signer = chainSigner(project);
  /* A project that signs its index must never have that index rewritten by an environment that
     cannot sign it: the replacement would fail verification everywhere, and because an unverifiable
     committed index is deliberately not merged, the rewrite would also drop the history it held.
     Appending refuses outright (`sealEvent`); a refresh simply leaves the committed file alone. */
  if (signer.configured && signer.secret === null) return null;
  document.generatedAt = new Date().toISOString();
  document.coverageGaps.sort();
  /* The one place the retained-event limit is enforced, so no builder can forget it and no builder
     has to pay for it per event. */
  enforceEventLimit(document);
  /* Any `hmac` carried over from the document that was read is stale by construction — the body it
     signed has just changed — so it is dropped and recomputed rather than trusted. */
  const { hmac: _stale, ...body } = document;
  const signed = signer.secret === null ? body : { ...body, hmac: signBody(signer.secret, body) };
  const complete: AuditIndexDocument = { ...signed, digest: auditIndexDigest(signed) };
  await atomicWrite(project.root, relative, `${JSON.stringify(complete, null, 2)}\n`);
  return complete;
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
  /*
   * Whether this rebuild demonstrably contains everything the committed document did, captured
   * before the counters below are merged into `fresh`. It is what lets an index that a *v2* build
   * truncated the wrong way heal: `refreshChangeAuditIndex` replays the entire local chain, so when
   * neither side reports a pruned prefix and every committed summary reappears in the replay, the
   * rebuilt document is a superset and the old truncation says nothing about it any more. When the
   * local chain cannot show that — a fresh clone, a pruned prefix — the flag is inherited, because
   * whatever v2 dropped is genuinely unrecoverable and pretending otherwise would be worse.
   */
  const freshIds = new Set(fresh.events.map((item) => item.eventId));
  const replayedCommitted = fresh.chain.prunedCount === 0
    && committed.chain.prunedCount === 0
    && committed.events.every((item) => freshIds.has(item.eventId));
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
    fresh.events = merged;
    if (!replayedCommitted) {
      fresh.eventsTruncated = fresh.eventsTruncated || committed.eventsTruncated;
      if (!indexGovernanceComplete(committed)) fresh.governanceComplete = false;
    }
    /* The limit is applied to the whole union on the way out, so what survives is chosen once from
       everything known — never "the first 1000 by timestamp", which is what dropped the Approval. */
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
  let document = emptyIndex(changeId, anchor, remoteDeliveryFacts(project));
  for (const event of [...legacy, ...shard]) applyEvent(document, event);
  const verification = verifyChain(shard, anchor.base, chainSigner(project));
  const valid = verification.diagnostics.length === 0;
  document.chain.valid = valid;
  document.chainValid = valid;
  document.delivery.pending = pendingDelivery([...legacy, ...shard], [...legacy, ...shard]);
  /* A tampered index is deliberately NOT merged: an unverifiable document must not be able to
     inject event types, and readChangeAuditEvents already reports it as untrusted. */
  const committed = await readChangeAuditIndex(project, changeId);
  if (committed?.digestValid) document = mergeCommittedIndex(document, committed.document);
  /* The written document is the return value: it is the one carrying the signature, when signed. */
  return await writeIndex(project, changeId, document) ?? { ...document, digest: auditIndexDigest(document) };
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
  const local = attestableEvents(chainSigner(project), await readChangeLogEvents(project, changeId));
  if (local.some((event) => event.eventType === APPROVAL_EVENT_TYPE && event.inputDigest === expected)) return true;
  /* Fresh clone / CI: the chain file is gitignored, the committed index is not. */
  const committed = await readChangeAuditIndex(project, changeId);
  if (!committed?.digestValid) return false;
  return committed.document.events.some((event) => event.eventType === APPROVAL_EVENT_TYPE && event.inputDigest === expected);
}

/** The lifecycle event `xforge approve` records; nothing else attests an Approval receipt. */
const APPROVAL_EVENT_TYPE = 'approval.decided';

/** The lifecycle events `work-package acknowledge` and `review acknowledge` record; nothing else
    attests a receipt of either kind. Both are plain committed JSON whose every field is computable
    by whoever wrote them, so both have to be attested rather than believed. */
const ACKNOWLEDGEMENT_EVENT_TYPES = new Set(['work-package.integrated', 'work-package.reviewed', 'review.acknowledged']);

/**
 * The `inputDigest` an acknowledgement audit event must carry to attest a receipt with this digest.
 *
 * The single definition both sides of the acknowledgement protocol use: `work-package acknowledge`
 * passes it to `recordAudit` as an explicit `inputDigest`, and `resolveWorkPackages` recomputes it
 * from the committed receipt to decide whether the chain vouches for it. Because the value is a
 * function of the receipt digest alone, the two sides cannot drift and the read side never has to
 * reconstruct anything the write side happened to know — the receipt digest already commits to the
 * Change, package, execution, role, status, delivery and actor.
 */
export function acknowledgementAttestationDigest(receiptDigest: string): string {
  return sha256(stableStringify({ ackReceipt: receiptDigest }));
}

/** Which acknowledgement receipts one Change's audit history vouches for. */
export interface AcknowledgementAttestations {
  /**
   * True when the Change has no audit history at all — no local chain entries and no committed
   * index file. It is a property of the Change, evaluated once, never of an individual receipt.
   */
  noAuditData: boolean;
  /** Whether the chain (local or committed) carries an acknowledgement event for this receipt. */
  attests(receiptDigest: string): boolean;
}

/**
 * Which Git-tracked acknowledgement receipts this Change's audit chain actually attests.
 *
 * A `WorkPackageAckReceipt` is a plain committed JSON file, and every property it commits to — its
 * self-digest, the delivery it binds, its path — is computable offline by whoever wrote it. Taken
 * at face value, a hand-written receipt therefore mints a `reviewed`/`integrated` record naming any
 * actor its author likes. That fact is the product, so it has to be attested rather than believed:
 * `work-package.reviewed`/`work-package.integrated` carry `sha256({ackReceipt})` as their
 * `inputDigest`, inside a hash chain whose committed per-Change index survives a fresh clone, so
 * matching against it is an offline check of "this receipt was written by an `acknowledge` run".
 * Forging it means rewriting the chain, which is what the chain exists to detect. This mirrors
 * `approvalVerifiedInChain`, which answers the same question for Approval receipts.
 *
 * `noAuditData` is the one escape, and it is deliberately all-or-nothing. `xforge/.audit/**` is
 * gitignored, so a clone of a project that never committed `evidence/audit/index.json` has no audit
 * data whatsoever; there the committed receipt is the only surviving truth about who reviewed what,
 * and refusing it would resurrect the exact loss the receipt was introduced to fix. It cannot be
 * used to slip one forged receipt past a real chain: it requires that the Change has *no* events on
 * the local chain and *no* committed index file, not merely that this one event is missing. A
 * committed index that exists but fails its digest check counts as audit data — a tampered index
 * fails closed rather than unlocking the escape.
 */
export async function readAcknowledgementAttestations(project: ProjectContext, changeId: string): Promise<AcknowledgementAttestations> {
  const local = await readChangeLogEvents(project, changeId);
  /* Fresh clone / CI: the chain file is gitignored, the committed index is not. */
  const committed = await readChangeAuditIndex(project, changeId);
  const digests = new Set<string>();
  /* `noAuditData` below is computed from the *unfiltered* list on purpose: a signed chain that this
     environment cannot verify must not filter down to "no audit data" and unlock the escape. */
  for (const event of attestableEvents(chainSigner(project), local)) if (ACKNOWLEDGEMENT_EVENT_TYPES.has(event.eventType)) digests.add(event.inputDigest);
  if (committed?.digestValid) {
    for (const event of committed.document.events) if (ACKNOWLEDGEMENT_EVENT_TYPES.has(event.eventType)) digests.add(event.inputDigest);
  }
  const noAuditData = local.length === 0 && committed === null;
  return {
    noAuditData,
    attests: (receiptDigest: string) => noAuditData || digests.has(acknowledgementAttestationDigest(receiptDigest)),
  };
}

/** The lifecycle event `xforge transition` records after a receipt is on disk; nothing else attests one. */
const TRANSITION_EVENT_TYPE = 'stage.entered';

/*
 * The one place the governance-bearing set is assembled, from the very constants the three readers
 * in this section match on. Declared after them rather than beside `GOVERNANCE_EVENT_TYPES` so it
 * cannot quietly list a type no reader uses, or omit one every reader depends on; the functions that
 * consult the set all run long after this statement.
 */
for (const type of [APPROVAL_EVENT_TYPE, ...ACKNOWLEDGEMENT_EVENT_TYPES, TRANSITION_EVENT_TYPE]) GOVERNANCE_EVENT_TYPES.add(type);

/**
 * The `inputDigest` a `stage.entered` audit event must carry to attest a Transition receipt.
 *
 * The single definition both sides of the transition protocol use, exactly as
 * `acknowledgementAttestationDigest` serves the acknowledgement protocol: `transition` passes it to
 * `recordAudit`, and the orphan-receipt scan recomputes it from the receipt on disk to ask whether
 * the chain ever said this Stage was entered. The receipt digest already commits to the Change,
 * Flow, from/to Stages, revision and actor, so the receipt digest alone is enough of a subject.
 */
export function transitionAttestationDigest(receiptDigest: string): string {
  return sha256(stableStringify({ transitionReceipt: receiptDigest }));
}

/** What this machine can prove about the `stage.entered` events behind one Change's receipts. */
interface TransitionAttestations {
  /**
   * Whether the readable attestations can be treated as the *complete* set for this Change, so that
   * a missing one means something. A property of the Change, evaluated once, never of a receipt.
   */
  complete: boolean;
  /** Whether the chain (local or committed) carries a `stage.entered` event for this receipt. */
  attests(receiptDigest: string): boolean;
  /**
   * Whether a receipt's `auditHead` names an event still on *this* machine's local chain — i.e.
   * whether this working tree is the one that wrote the receipt.
   */
  writtenHere(auditHead: string | null): boolean;
}

/**
 * Which Transition receipts this Change's audit history attests, and whether absence proves anything.
 *
 * `transition` writes the receipt and then records `stage.entered`; a process killed between the two
 * (SIGKILL, power loss, container eviction) leaves a receipt no event attests, and because
 * `control-plane.ts` derives `currentStage` from the last receipt, that remnant silently advances
 * the Change. Detecting it means reasoning from an *absent* event, which is only sound when the set
 * of readable events is known to be complete — otherwise a legitimate receipt is accused of being a
 * crash remnant, which is far more damaging than the remnant.
 *
 * `complete` is therefore deliberately narrow, and mirrors `readAcknowledgementAttestations`'
 * all-or-nothing `noAuditData` escape rather than trying to reason per receipt:
 * - the committed index must exist and pass its digest check — `xforge/.audit/**` is gitignored, so
 *   on any machine that did not run the flow the index is the only surviving record, and a missing
 *   or hand-edited one means this machine simply cannot see what happened elsewhere;
 * - it must report its governance events complete, and neither it nor the local shard anchor may
 *   report a pruned prefix — past either boundary an attestation can be gone for reasons that have
 *   nothing to do with a crash.
 *
 * That first test used to be `!eventsTruncated`, which made the whole scan disable itself on any
 * Change that simply produced more than `INDEX_EVENT_LIMIT` workflow events — i.e. precisely the
 * long, many-cycle Changes most likely to have been interrupted. Since v3 the index never evicts a
 * `stage.entered`, so the question "could an attestation be missing for a reason other than a crash?"
 * is answered by `governanceComplete` and no longer by the volume of gate noise.
 *
 * `writtenHere` is the second, independent test, and it is what a "was the chain pruned?" check
 * cannot do: a Change cloned from a colleague has a perfectly complete-looking local chain of the
 * *clone's own* events, so the colleague's receipts appear unattested. Their `auditHead` names a
 * chain head that never existed on this machine, which says plainly that this working tree is not
 * where they were written and their attestations were never expected to be here.
 */
export async function readTransitionAttestations(project: ProjectContext, changeId: string): Promise<TransitionAttestations> {
  const local = await readChangeLogEvents(project, changeId);
  /* Fresh clone / CI: the chain file is gitignored, the committed index is not. */
  const committed = await readChangeAuditIndex(project, changeId);
  const anchor = await anchorFor(project, shardKeyFor(changeId));
  const digests = new Set<string>();
  const localHashes = new Set<string>();
  const attestable = new Set(attestableEvents(chainSigner(project), local).map((event) => event.eventId));
  for (const event of local) {
    /* `writtenHere` asks where a receipt was written, not whether to believe it, and answering "not
       here" only ever suppresses an accusation — so it reads every local hash, signed or not. */
    localHashes.add(event.hash);
    if (event.eventType === TRANSITION_EVENT_TYPE && attestable.has(event.eventId)) digests.add(event.inputDigest);
  }
  if (committed?.digestValid) {
    for (const event of committed.document.events) if (event.eventType === TRANSITION_EVENT_TYPE) digests.add(event.inputDigest);
  }
  const complete = Boolean(
    committed?.digestValid
    && indexGovernanceComplete(committed.document)
    && committed.document.chain.prunedCount === 0
    && anchor.prunedCount === 0,
  );
  return {
    complete,
    attests: (receiptDigest: string) => digests.has(transitionAttestationDigest(receiptDigest)),
    writtenHere: (auditHead: string | null) => auditHead !== null && localHashes.has(auditHead),
  };
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
  delivery: { remoteDeclared: boolean; remoteEndpointResolved: boolean; pending: number; delivered: number };
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
  const remote = remoteDeliveryFacts(project);
  const signer = chainSigner(project);
  const loaded = await readChangeAuditIndex(project, changeId);
  if (loaded && loaded.signature !== 'ok') {
    /* A signature failure is a different accusation from a hand-edited document — "signed by a key
       this environment cannot check" is usually a missing env var, not tampering — so it says so. */
    diagnostics.push(signatureDiagnostic(loaded.signature, signer, `Committed audit index ${loaded.path}`));
  } else if (loaded && !loaded.digestValid) {
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
  const legacyDiagnostics: ChangeAuditFacts['diagnostics'] = [];
  for (const event of legacy) {
    if (event.hash !== eventHash(unsignedBody(event))) legacyDiagnostics.push({ code: 'XFORGE_AUDIT_HASH_INVALID', message: 'Audit event hash does not match its content.', eventId: event.eventId });
    const verdict = eventSignature(signer, event);
    if (verdict !== 'ok') legacyDiagnostics.push(signatureDiagnostic(verdict, signer, 'Audit event', event.eventId));
  }
  diagnostics.push(...legacyDiagnostics);
  const legacyInvalid = legacyDiagnostics.length > 0;
  const verification = shardKey === null
    ? { diagnostics: [] as AuditVerification['diagnostics'], head: legacy.at(-1)?.hash ?? null }
    : verifyChain(shard, anchor.base, signer);
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
      remoteDeclared: remote.declared,
      remoteEndpointResolved: remote.resolved,
      pending: source === 'index' ? index!.delivery.pending : pendingDelivery(events, events),
      delivered: index?.delivery.delivered ?? events.filter((event) => event.eventType === 'audit.delivery' && event.outcome === 'succeeded').length,
    },
    coverageGaps: [...new Set([...events.flatMap((event) => event.coverage.gaps), ...(index?.coverageGaps ?? [])])].sort(),
    diagnostics,
    indexPath: loaded?.path ?? null,
  };
}

/* ------------------------------------------------------------------ append */

/**
 * The event that records taking an abandoned lock over.
 *
 * It is built here rather than routed through `recordAudit` because it is written *while the lock is
 * held*: calling `recordAudit` would re-enter `acquireLock` on the same shard and deadlock. Writing
 * it onto the very chain the lock protects is also the right place for it — the reclaim is a fact
 * about that chain's history, and it lands immediately before the event whose append discovered it.
 * `deliveryState: 'not-configured'` keeps it from creating remote-delivery debt of its own.
 */
function lockReclaimBody(project: ProjectContext, changeId: string | null, reclaimed: { path: string; reason: string }): Omit<AuditEvent, 'previousHash' | 'hash'> {
  return {
    apiVersion: 'xforge.dev/v1alpha2', kind: 'AuditEvent', eventId: randomUUID(), eventType: 'audit.lock.reclaimed',
    timestamp: new Date().toISOString(), plane: 'workflow', platform: 'xforge', surface: 'local',
    sessionId: 'unknown', turnId: 'unknown', toolCallId: 'unknown', correlationId: randomUUID(),
    actor: { id: 'xforge-audit', provider: 'xforge', role: 'system', type: 'system' },
    change: changeId, flow: null, stage: null, workPackage: null,
    stateRevision: 'unknown', gitBase: 'unknown', gitHead: 'unknown',
    refs: { rules: [], policies: [], gates: [] },
    decision: 'reclaimed', reason: reclaimed.reason, outcome: 'succeeded', durationMs: null,
    inputDigest: sha256(stableStringify({ lock: reclaimed.path })), outputDigest: sha256(reclaimed.reason),
    redaction: project.manifest.audit?.redaction ?? 'metadata-only', coverage: { observed: true, gaps: [] },
    deliveryState: 'not-configured',
  };
}

async function appendEvent(project: ProjectContext, changeId: string | null, event: Omit<AuditEvent, 'previousHash' | 'hash'>): Promise<AuditEvent> {
  const shardKey = shardKeyFor(changeId);
  const signer = chainSigner(project);
  const { release, reclaimed } = await acquireLock(project, shardKey);
  try {
    const relative = shardRelative(shardKey);
    const absolute = await safeResolve(project.root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    const anchors = await readAnchors(project);
    const created = shardKey !== null && !(shardKey in anchors) && !await exists(absolute);
    const anchor = await anchorFor(project, shardKey, anchors);
    const tail = await chainHead(absolute);
    const bodies = reclaimed === null ? [event] : [lockReclaimBody(project, changeId, reclaimed), event];
    let previous = tail.head ?? anchor.base;
    let lines = '';
    let last!: AuditEvent;
    for (const body of bodies) {
      last = sealEvent(signer, { ...body, previousHash: previous });
      lines += `${JSON.stringify(last)}\n`;
      previous = last.hash;
    }
    await appendFile(absolute, lines, { encoding: 'utf8', flag: 'a' });
    tailCache.set(absolute, { size: tail.size + Buffer.byteLength(lines), head: previous });
    if (created) await persistAnchor(project, shardKey, anchor);
    /* The caller's event is always the last one written, so the returned head is still its own. */
    return last;
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

interface RecordAuditInput {
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

interface AuditPruneResult {
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
    /* Pruning rewrites the shard in place rather than appending, so a reclaim has nowhere to be
       recorded that would not itself be a rewrite; the append path records it instead. */
    const { release } = await acquireLock(project, key);
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
