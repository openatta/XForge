import type { Diagnostic, FileChange, GateEvidence, ProjectContext } from '../types.js';
import { checkStructure } from '../core/checker.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { assertManaged } from '../core/project-loader.js';
import { workPackageVerificationGates } from '../core/work-packages.js';
import { runGate } from '../runners/gate.js';

export interface CheckOptions {
  change?: string;
  gate?: string;
}

export interface CheckData {
  structure: { passed: boolean };
  change: string | null;
  workPackages: Array<{ packageId: string; command: string; status: 'passed' | 'failed'; evidence: GateEvidence }>;
  gates: Array<{ id: string; status: 'passed' | 'failed'; evidence: GateEvidence | null }>;
}

export async function executeCheck(project: ProjectContext, options: CheckOptions): Promise<{
  data: CheckData;
  diagnostics: Diagnostic[];
  changes: FileChange[];
}> {
  assertManaged(project, 'check');
  const structure = await checkStructure(project, options.change);
  const diagnostics = [...structure.diagnostics];
  const staleLockCodes = new Set(['XFORGE_LOCK_SCAFFOLD_MISMATCH', 'XFORGE_LOCK_PATHS_MISMATCH', 'XFORGE_LOCK_RESOURCES_MISMATCH']);
  if (diagnostics.some((item) => staleLockCodes.has(item.code))) {
    diagnostics.push(diagnostic('XFORGE_LOCK_STALE', 'Run xforge install to resolve and lock current Manifest paths, Scaffold, and resources before check.', 'xforge/lock.yaml'));
  }
  const changes: FileChange[] = [];
  const hasStructureErrors = diagnostics.some((item) => item.severity === 'error');
  const gateResults: CheckData['gates'] = [];
  const workPackageResults: CheckData['workPackages'] = [];

  let gateIds: string[] = [];
  if (options.gate) gateIds = [options.gate];
  else if (options.change && structure.change) gateIds = structure.change.archive.mandatoryGates;

  if (gateIds.length > 0 && !options.change) {
    const external = gateIds.some((id) => structure.resources.gates.get(id)?.value.spec.builtin !== 'structure');
    if (external) diagnostics.push(diagnostic('XFORGE_CHANGE_REQUIRED', 'A Change is required to run a Gate and save Evidence.'));
  }

  if (!hasStructureErrors && options.change && structure.change?.workPackages) {
    for (const verification of workPackageVerificationGates(structure.change.workPackages)) {
      const result = await runGate(project, options.change, verification.gate, true);
      changes.push(result.change);
      if (result.evidence.status === 'failed') diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_VERIFY_FAILED',
        `Work package ${verification.packageId} verification failed: ${verification.command}`,
        result.change.path,
        'error',
        { exitCode: result.evidence.exitCode, timedOut: result.evidence.timedOut },
      ));
      workPackageResults.push({
        packageId: verification.packageId,
        command: verification.command,
        status: result.evidence.status,
        evidence: result.evidence,
      });
    }
  }

  if (!hasStructureErrors && (!gateIds.length || options.change || gateIds.every((id) => structure.resources.gates.get(id)?.value.spec.builtin === 'structure'))) {
    for (const id of gateIds) {
      const resource = structure.resources.gates.get(id);
      if (!resource) {
        diagnostics.push(diagnostic('XFORGE_GATE_NOT_FOUND', `Selected Gate does not exist or is not enabled: ${id}`, 'xforge/manifest.yaml'));
        gateResults.push({ id, status: 'failed', evidence: null });
        continue;
      }
      if (!options.change) {
        gateResults.push({ id, status: 'passed', evidence: null });
        continue;
      }
      const result = await runGate(project, options.change, resource.value, true);
      changes.push(result.change);
      if (result.diagnostic) diagnostics.push(result.diagnostic);
      gateResults.push({ id, status: result.evidence.status, evidence: result.evidence });
    }
  }

  return {
    data: { structure: { passed: !hasStructureErrors }, change: options.change ?? null, workPackages: workPackageResults, gates: gateResults },
    diagnostics,
    changes,
  };
}
