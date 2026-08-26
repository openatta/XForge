import type { AuditEvent, Diagnostic, FileChange, ProjectContext } from '../types.js';
import {
  expiredAuditEvents,
  pruneExpiredAuditEvents,
  readAuditEvents,
  readChangeAuditEvents,
  retryAuditDelivery,
  verifyAudit,
} from '../core/audit.js';
import { atomicWrite } from '../core/files.js';
import { sha256 } from '../core/hash.js';
import { normalizeRelative } from '../core/path-safety.js';
import { assertManaged } from '../core/project-loader.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { diagnostic } from '../core/errors.js';

function byTimestamp(events: AuditEvent[]): AuditEvent[] {
  return [...events].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

export async function executeAudit(project: ProjectContext, options: { action: 'status' | 'verify' | 'export' | 'retry' | 'prune'; change?: string; output?: string }): Promise<{
  data: Record<string, unknown>;
  diagnostics: Diagnostic[];
  changes: FileChange[];
}> {
  if (options.action === 'retry' || options.action === 'prune' || options.action === 'export' && options.output) assertManaged(project, `audit ${options.action}`);
  const verification = await verifyAudit(project, options.change);
  const all = await readAuditEvents(project);
  const events = options.change ? all.filter((event) => event.change === options.change) : all;
  /* On a machine that never ran the flow the local chain is absent; the committed per-Change index
     is then the source of truth for which audit events exist. */
  const facts = options.change ? await readChangeAuditEvents(project, options.change) : null;
  const diagnostics: Diagnostic[] = verification.diagnostics.map((item) => ({ code: item.code, severity: 'error', message: item.message, details: item.eventId ? { eventId: item.eventId } : undefined }));
  for (const item of facts?.diagnostics ?? []) {
    if (item.code === 'XFORGE_AUDIT_INDEX_TAMPERED') diagnostics.push({ code: item.code, severity: 'error', message: item.message });
  }
  /**
   * What `remotePending` means for *this* Change, resolved once and reported rather than left to be
   * inferred from a bare number.
   *
   * `remotePending` is emitted unconditionally, but the only thing that makes it a blocker is a
   * policy the reader cannot see from here. The shipped default is `remoteDelivery: optional` with
   * `audit.remote.requiredFor: []`, so the ordinary case is a large pending count that means
   * nothing at all — and a reader who cannot tell that from the output has to choose between
   * chasing a non-problem and ignoring a real one.
   */
  let remoteDelivery: Record<string, unknown> | null = null;
  if (options.action === 'verify' && options.change) {
    const resolved = await resolveChangeState(project, options.change);
    if (isStageFlow(resolved.flow) && resolved.flow.governance) {
      /*
       * The same resolution `core/control-plane.ts`'s `terminalGovernanceBlocks` uses, and it has to
       * be: this command is what a Skill tells the Agent to run before archiving, so validating a
       * different policy than archive enforces makes it a false all-clear. In the shipped `quick`
       * Flow the two disagree by exactly one event — the flow-level block omits `approval.decided`
       * and the terminal policy requires it — so `audit verify` passed and archive then refused.
       */
      const policy = resolved.flow.terminal?.archive?.auditPolicy ?? resolved.flow.governance.audit;
      const present = new Set(facts?.eventTypes ?? events.map((event) => event.eventType));
      const remoteRequired = policy.remoteDelivery === 'required' || Boolean(project.manifest.audit?.remote?.requiredFor.includes(resolved.flow.policy.assuranceLevel));
      for (const eventType of policy.requiredEventTypes) {
        if (!present.has(eventType)) diagnostics.push(diagnostic('XFORGE_AUDIT_EVENT_MISSING', `Required audit event is missing: ${eventType}.`, `${project.changesPath}/${options.change}/evidence/audit`));
      }
      const coverageGaps = facts?.coverageGaps ?? [...new Set(events.flatMap((event) => event.coverage.gaps))];
      if (policy.runtimeCoverage === 'required' && coverageGaps.length > 0) diagnostics.push(diagnostic('XFORGE_AUDIT_RUNTIME_COVERAGE_GAP', `Runtime audit coverage has gaps: ${coverageGaps.join(', ')}.`));
      if (remoteRequired && !project.manifest.audit?.remote) diagnostics.push(diagnostic('XFORGE_AUDIT_REMOTE_NOT_CONFIGURED', 'The selected Flow requires remote audit delivery.'));
      if (remoteRequired && verification.remotePending > 0) diagnostics.push(diagnostic('XFORGE_AUDIT_REMOTE_PENDING', `${verification.remotePending} audit events still require remote delivery.`));
      const endpointEnv = project.manifest.audit?.remote?.endpointEnv ?? null;
      remoteDelivery = {
        required: remoteRequired,
        pending: verification.remotePending,
        policy: policy.remoteDelivery ?? null,
        requiredForAssuranceLevels: project.manifest.audit?.remote?.requiredFor ?? [],
        endpointEnv,
        endpointConfigured: Boolean(endpointEnv && process.env[endpointEnv]),
      };
      /*
       * Said out loud, on the same principle as `check`'s XFORGE_CHECK_PASSED_WITH_WARNINGS: the
       * number is in the output either way, and a number nobody can interpret is read as a problem
       * or as nothing at random. `info`, because at this level it is neither a blocker nor advice —
       * there is nothing to fix.
       */
      if (!remoteRequired && verification.remotePending > 0) diagnostics.push(diagnostic(
        'XFORGE_AUDIT_REMOTE_PENDING_OPTIONAL',
        `${verification.remotePending} audit event(s) are undelivered to a remote sink. Remote delivery is optional at assurance level ${resolved.flow.policy.assuranceLevel} (Flow remoteDelivery: ${policy.remoteDelivery ?? 'unset'}, manifest audit.remote.requiredFor: ${(project.manifest.audit?.remote?.requiredFor ?? []).join(', ') || 'empty'}), so these events live in the local chain only and do not block archive. To deliver them, set ${endpointEnv ?? 'audit.remote.endpointEnv'} and run \`xforge audit retry\`.`,
        `${project.changesPath}/${options.change}/evidence/audit`,
        'info',
      ));
    }
  }
  if (options.action === 'retry') {
    const result = await retryAuditDelivery(project);
    /* Retention is destructive, so it only runs when the Manifest opts in. */
    const pruned = project.manifest.audit?.localRetentionEnforce ? await pruneExpiredAuditEvents(project) : null;
    return { data: { ...result, pruned, verification: await verifyAudit(project, options.change) }, diagnostics, changes: [] };
  }
  /* Pruning deletes local history, so it gets its own explicit command rather than riding along
     with `retry`. Retention must still be declared by the Manifest — the command executes the
     configured policy, it does not invent one. */
  if (options.action === 'prune') {
    if (!project.manifest.audit?.localRetentionDays) {
      return {
        data: { pruned: null, reason: 'not-configured' },
        diagnostics: [...diagnostics, diagnostic('XFORGE_AUDIT_RETENTION_NOT_CONFIGURED', 'audit prune requires audit.localRetentionDays in the Manifest.', 'xforge/manifest.yaml')],
        changes: [],
      };
    }
    const expired = await expiredAuditEvents(project);
    const pruned = await pruneExpiredAuditEvents(project);
    return {
      data: { pruned, expiredBefore: expired, verification: await verifyAudit(project, options.change) },
      diagnostics,
      changes: [],
    };
  }
  if (options.action === 'export') {
    const content = `${JSON.stringify({ apiVersion: 'xforge.dev/v1alpha2', kind: 'AuditExport', generatedAt: new Date().toISOString(), change: options.change ?? null, events }, null, 2)}\n`;
    const changes: FileChange[] = [];
    if (options.output) {
      const output = normalizeRelative(options.output, 'audit export output');
      await atomicWrite(project.root, output, content);
      changes.push({ action: 'create', path: output, digest: sha256(content), source: 'audit:export' });
    }
    return { data: { verification, events: options.output ? undefined : events, output: options.output ?? null }, diagnostics, changes };
  }
  const ordered = byTimestamp(events);
  return {
    data: options.action === 'verify' ? { ...verification, remoteDelivery, change: facts ? { source: facts.source, trusted: facts.trusted, chain: facts.chain } : null } : {
      change: options.change ?? null, eventCount: facts?.eventCount ?? events.length, chainHead: verification.head, chainValid: verification.valid,
      remotePending: verification.remotePending,
      eventTypes: Object.fromEntries([...new Set(events.map((event) => event.eventType))].sort().map((type) => [type, events.filter((event) => event.eventType === type).length])),
      coverageGaps: facts?.coverageGaps ?? [...new Set(events.flatMap((event) => event.coverage.gaps))],
      source: facts?.source ?? 'log',
      shards: verification.shards ?? null,
      retention: {
        localDays: project.manifest.audit?.localRetentionDays ?? null,
        oldestEvent: ordered[0]?.timestamp ?? null,
        expiredEvents: await expiredAuditEvents(project),
        enforced: project.manifest.audit?.localRetentionEnforce === true,
        prunedFromChain: facts?.chain.prunedCount ?? 0,
        policy: 'anchored prefix pruning keeps the per-Change chain verifiable; the committed index retains the event-type summary',
      },
    },
    diagnostics,
    changes: [],
  };
}
