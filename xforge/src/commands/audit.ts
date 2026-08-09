import type { Diagnostic, FileChange, ProjectContext } from '../types.js';
import { readAuditEvents, retryAuditDelivery, verifyAudit } from '../core/audit.js';
import { atomicWrite } from '../core/files.js';
import { sha256 } from '../core/hash.js';
import { normalizeRelative } from '../core/path-safety.js';
import { assertManaged } from '../core/project-loader.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { diagnostic } from '../core/errors.js';

export async function executeAudit(project: ProjectContext, options: { action: 'status' | 'verify' | 'export' | 'retry'; change?: string; output?: string }): Promise<{
  data: Record<string, unknown>;
  diagnostics: Diagnostic[];
  changes: FileChange[];
}> {
  if (options.action === 'retry' || options.action === 'export' && options.output) assertManaged(project, `audit ${options.action}`);
  const verification = await verifyAudit(project, options.change);
  const all = await readAuditEvents(project);
  const events = options.change ? all.filter((event) => event.change === options.change) : all;
  const diagnostics: Diagnostic[] = verification.diagnostics.map((item) => ({ code: item.code, severity: 'error', message: item.message, details: item.eventId ? { eventId: item.eventId } : undefined }));
  if (options.action === 'verify' && options.change) {
    const resolved = await resolveChangeState(project, options.change);
    if (isStageFlow(resolved.flow) && resolved.flow.governance) {
      const policy = resolved.flow.governance.audit;
      const remoteRequired = policy.remoteDelivery === 'required' || Boolean(project.manifest.audit?.remote?.requiredFor.includes(resolved.flow.policy.assuranceLevel));
      for (const eventType of policy.requiredEventTypes) {
        if (!events.some((event) => event.eventType === eventType)) diagnostics.push(diagnostic('XFORGE_AUDIT_EVENT_MISSING', `Required audit event is missing: ${eventType}.`, `${project.changesPath}/${options.change}/evidence/audit`));
      }
      const coverageGaps = [...new Set(events.flatMap((event) => event.coverage.gaps))];
      if (policy.runtimeCoverage === 'required' && coverageGaps.length > 0) diagnostics.push(diagnostic('XFORGE_AUDIT_RUNTIME_COVERAGE_GAP', `Runtime audit coverage has gaps: ${coverageGaps.join(', ')}.`));
      if (remoteRequired && !project.manifest.audit?.remote) diagnostics.push(diagnostic('XFORGE_AUDIT_REMOTE_NOT_CONFIGURED', 'The selected Flow requires remote audit delivery.'));
      if (remoteRequired && verification.remotePending > 0) diagnostics.push(diagnostic('XFORGE_AUDIT_REMOTE_PENDING', `${verification.remotePending} audit events still require remote delivery.`));
    }
  }
  if (options.action === 'retry') {
    const result = await retryAuditDelivery(project);
    return { data: { ...result, verification: await verifyAudit(project, options.change) }, diagnostics, changes: [] };
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
  return {
    data: options.action === 'verify' ? { ...verification } : {
      change: options.change ?? null, eventCount: events.length, chainHead: verification.head, chainValid: verification.valid,
      remotePending: verification.remotePending, eventTypes: Object.fromEntries([...new Set(events.map((event) => event.eventType))].sort().map((type) => [type, events.filter((event) => event.eventType === type).length])),
      coverageGaps: [...new Set(events.flatMap((event) => event.coverage.gaps))],
      retention: {
        localDays: project.manifest.audit?.localRetentionDays ?? null,
        oldestEvent: events[0]?.timestamp ?? null,
        expiredEvents: project.manifest.audit?.localRetentionDays
          ? events.filter((event) => Date.parse(event.timestamp) < Date.now() - project.manifest.audit!.localRetentionDays * 86_400_000).length
          : 0,
        policy: 'report-only-local-chain; enforce deletion/immutability at the remote sink',
      },
    },
    diagnostics,
    changes: [],
  };
}
