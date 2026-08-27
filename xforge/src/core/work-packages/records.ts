import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type {
  Diagnostic, ProjectContext, WorkPackageAckReceipt, WorkPackageDelivery, WorkPackageDispatchReceipt,
} from '../../types.js';
import { XForgeError, diagnostic } from '../errors.js';
import { sha256, stableStringify } from '../hash.js';
import { safeResolve } from '../path-safety.js';
import { validateSchema } from '../validator.js';
import { loadYaml } from '../yaml.js';
import type { AcknowledgementAttestations } from '../audit.js';

/**
 * Reading what a work package's execution left on disk, and refusing what does not check out.
 *
 * The three record kinds a package produces -- a dispatch receipt, a delivery, an acknowledgement --
 * are one story told in three files, and each is only worth what its validation is worth. Every
 * loader here therefore drops a record it cannot vouch for rather than passing it on with a caveat:
 * a digest that does not recompute, a subject naming another Change, an identifier disagreeing with
 * the path it was found at.
 *
 * Separated from the resolver because this is the read layer and nothing else. It decides whether a
 * record is a record; whether the work is acceptable is decided further on, against the plan.
 */

/** Carries a load failure's own diagnostics; anything else is a bug rather than a bad record. */
export function appendErrorDiagnostics(diagnostics: Diagnostic[], error: unknown): void {
  if (error instanceof XForgeError) diagnostics.push(...error.diagnostics);
  else throw error;
}

/** The package directory a `evidence/agents/<pkg>/<file>` path names. */
function directoryIdOf(name: string): string {
  return name.split('/')[2] ?? '<package>';
}

export async function loadDeliveries(
  project: ProjectContext,
  changeId: string,
  knownPackages: Set<string>,
): Promise<{ deliveries: Map<string, WorkPackageDelivery[]>; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const deliveries = new Map<string, WorkPackageDelivery[]>();
  const changeRoot = `${project.changesPath}/${changeId}`;
  const changeDirectory = await safeResolve(project.root, changeRoot);
  const names = (await fg('evidence/agents/*/*.yaml', {
    cwd: changeDirectory,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true,
  })).sort();
  const executionKeys = new Set<string>();

  for (const name of names) {
    const projectPath = `${changeRoot}/${name}`;
    let delivery: WorkPackageDelivery;
    try {
      delivery = await loadYaml<WorkPackageDelivery>(await safeResolve(project.root, projectPath), projectPath);
    } catch (error) {
      appendErrorDiagnostics(diagnostics, error);
      continue;
    }
    const schemaDiagnostics = await validateSchema('work-package-delivery', delivery, projectPath);
    diagnostics.push(...schemaDiagnostics);
    if (schemaDiagnostics.some((item) => item.severity === 'error')) {
      /*
       * Says which file does not belong here, rather than only which fields it lacks.
       *
       * Everything directly under `evidence/agents/<package>/` with a `.yaml` extension is read as a
       * delivery record, and a review transcript parked there is therefore validated as one. The
       * resulting report is accurate and useless: it asks for a dispatch receipt, non-empty
       * `changed_paths` and per-criterion `done_when_evidence`, none of which a read-only review can
       * ever have. A live Major run spent six rounds — including bisecting by moving files out of
       * the directory and back — to find that the file simply should not have been there. The
       * Skill now writes transcripts to `review/<execution>.md`; this is for the ones already on
       * disk, and for anything else that lands in the delivery slot by accident.
       */
      if (/(^|\/)review[-.]/.test(name)) diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_DELIVERY_SLOT_MISUSED',
        `${projectPath} sits where delivery records live, so it was validated as one, and the errors above are about the delivery shape rather than about this file. A read-only review transcript belongs in evidence/agents/${directoryIdOf(name)}/review/ with a .md extension, where nothing parses it as a delivery; move it there and acknowledge it with --as reviewer --evidence <the new path>.`,
        projectPath,
        'error',
      ));
      continue;
    }

    const parts = name.split('/');
    const directoryId = parts[2]!;
    const fileExecutionId = path.posix.basename(name, '.yaml');
    if (delivery.package_id !== directoryId) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DELIVERY_PATH_MISMATCH', `Delivery package_id must match its evidence directory. ${NOT_A_DELIVERY}`, projectPath));
    }
    if (delivery.execution_id !== fileExecutionId) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DELIVERY_PATH_MISMATCH', `Delivery execution_id must match its evidence filename. ${NOT_A_DELIVERY}`, projectPath));
    }
    if (!knownPackages.has(delivery.package_id)) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DELIVERY_UNKNOWN', `Delivery references unknown work package ${delivery.package_id}.`, projectPath));
      continue;
    }
    const executionKey = `${delivery.package_id}:${delivery.execution_id}`;
    if (executionKeys.has(executionKey)) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_EXECUTION_DUPLICATE', `Duplicate work package execution ${executionKey}.`, projectPath));
      continue;
    }
    executionKeys.add(executionKey);
    const list = deliveries.get(delivery.package_id) ?? [];
    list.push(delivery);
    deliveries.set(delivery.package_id, list);
  }
  return { deliveries, diagnostics };
}

export function latestDelivery(deliveries: WorkPackageDelivery[] | undefined): WorkPackageDelivery | null {
  if (!deliveries?.length) return null;
  return [...deliveries].sort((left, right) => {
    const byTime = Date.parse(left.recorded_at) - Date.parse(right.recorded_at);
    return byTime === 0 ? left.execution_id.localeCompare(right.execution_id) : byTime;
  }).at(-1) ?? null;
}

export async function loadDispatches(
  project: ProjectContext,
  changeId: string,
  knownPackages: Set<string>,
  /** Restricts the scan to one package's receipts; without it every package in the plan is read. */
  onlyPackage?: string,
): Promise<{ dispatches: Map<string, WorkPackageDispatchReceipt[]>; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const dispatches = new Map<string, WorkPackageDispatchReceipt[]>();
  const changeRoot = `${project.changesPath}/${changeId}`;
  const changeDirectory = await safeResolve(project.root, changeRoot);
  const names = (await fg(onlyPackage ? `evidence/agents/${onlyPackage}/dispatch/*.json` : 'evidence/agents/*/dispatch/*.json', {
    cwd: changeDirectory,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true,
  })).sort();
  for (const name of names) {
    const projectPath = `${changeRoot}/${name}`;
    try {
      const dispatch = JSON.parse(await readFile(await safeResolve(project.root, projectPath), 'utf8')) as WorkPackageDispatchReceipt;
      const schemaDiagnostics = await validateSchema('work-package-dispatch', dispatch, projectPath);
      diagnostics.push(...schemaDiagnostics);
      if (schemaDiagnostics.some((item) => item.severity === 'error')) continue;
      const parts = name.split('/');
      const directoryId = parts[2]!;
      const executionId = path.posix.basename(name, '.json');
      const { digest, ...unsigned } = dispatch;
      if (dispatch.change !== changeId || dispatch.packageId !== directoryId || dispatch.executionId !== executionId) {
        diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DISPATCH_PATH_MISMATCH', 'Dispatch identifiers must match their Change and evidence path.', projectPath));
        continue;
      }
      if (digest !== sha256(stableStringify(unsigned))) {
        diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DISPATCH_DIGEST_INVALID', 'Work package dispatch receipt digest is invalid.', projectPath));
        continue;
      }
      if (!knownPackages.has(dispatch.packageId)) {
        diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DISPATCH_UNKNOWN', `Dispatch references unknown work package ${dispatch.packageId}.`, projectPath));
        continue;
      }
      const list = dispatches.get(dispatch.packageId) ?? [];
      list.push(dispatch);
      dispatches.set(dispatch.packageId, list);
    } catch (error) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_DISPATCH_INVALID', `Dispatch receipt is invalid: ${(error as Error).message}`, projectPath));
    }
  }
  return { dispatches, diagnostics };
}

/**
 * The most recent dispatch receipt for one package, validated exactly as `resolveWorkPackages`
 * validates it. Used by `work-package draft` to read back the bindings XForge itself issued, rather
 * than asking an Agent to copy four opaque digests out of a receipt by hand.
 */
/**
 * The other reading of this refusal, which the message never offered.
 *
 * Everything with a `.yaml` extension directly under `evidence/agents/<package>/` is read as a
 * delivery record, so a file that is *not* one arrives here as a malformed delivery rather than as
 * a file in the wrong place. A live Major put a Reviewer's verbatim transcript at
 * `review-<execution>.yaml`, got this refusal plus EXECUTION_DUPLICATE, and spent six rounds
 * locating the cause — including a bisect by moving files out of the directory and back. The Skills
 * name the subdirectory route now, so the common path no longer reaches this; anyone arriving from
 * another direction still deserves to be told which of the two problems they have.
 */
const NOT_A_DELIVERY = 'If this file is not a delivery record — a review or integration transcript, say — it is in the wrong place rather than malformed: everything ending .yaml directly under evidence/agents/<package>/ is parsed as a delivery. Put it in a subdirectory such as evidence/agents/<package>/review/, which nothing parses as one.';

export async function latestDispatchFor(
  project: ProjectContext,
  changeId: string,
  packageId: string,
  knownPackages?: Set<string>,
): Promise<{ dispatch: WorkPackageDispatchReceipt | null; diagnostics: Diagnostic[] }> {
  /*
   * Scoped to the one package, because `loadDispatches` walks every package's receipts.
   *
   * It used to be handed `new Set([packageId])` as the known-package set while still scanning
   * `evidence/agents/<id>/dispatch/*.json`, so every *other* package's receipt was reported as
   * `XFORGE_WORK_PACKAGE_DISPATCH_UNKNOWN` — an error, carried into the envelope by
   * `work-package draft`. The count scaled with the plan: a live Major run with thirteen packages
   * got twelve errors on every draft, whichever package it asked for, and wrote all thirteen
   * delivery records by hand as a result. `draft` reads back one execution's bindings; validating
   * the rest of the plan is `check`'s job, and it still does it.
   */
  const loaded = await loadDispatches(project, changeId, knownPackages ?? new Set([packageId]), packageId);
  return { dispatch: latestDispatch(loaded.dispatches.get(packageId)), diagnostics: loaded.diagnostics };
}

export function latestDispatch(dispatches: WorkPackageDispatchReceipt[] | undefined): WorkPackageDispatchReceipt | null {
  if (!dispatches?.length) return null;
  return [...dispatches].sort((left, right) => {
    const byTime = Date.parse(left.issuedAt) - Date.parse(right.issuedAt);
    return byTime === 0 ? left.executionId.localeCompare(right.executionId) : byTime;
  }).at(-1) ?? null;
}

/** The lifecycle status an acknowledgement in each role is allowed to claim. */
const ACK_ROLE_STATUS: Record<WorkPackageAckReceipt['as'], WorkPackageAckReceipt['status']> = {
  integrator: 'integrated',
  reviewer: 'reviewed',
};

/**
 * Loads `WorkPackageAckReceipt` files, the Git-tracked counterpart to the (gitignored) local audit
 * chain's `work-package.reviewed`/`work-package.integrated` events.
 *
 * `.audit/` is gitignored project-wide (see `xforge/scaffold/payload/xforge/.audit/.gitignore`), so
 * a fresh `git clone` has no local audit history at all. Without a Git-tracked receipt, every
 * previously reviewed/integrated work package would silently read back as merely `succeeded` on a
 * clone — the review/integration record would be invisibly lost.
 *
 * Every property a receipt commits to is computable offline by whoever wrote the file, so none of
 * them can establish that an acknowledgement actually happened. The audit chain does: a receipt
 * counts only when `readAcknowledgementAttestations` finds the matching `work-package.reviewed`/
 * `.integrated` event (see its doc comment for the fresh-clone escape). Everything else here is a
 * consistency check that decides whether a file is worth considering at all.
 *
 * A receipt written before attestation shipped carries an audit event whose `inputDigest` covered
 * the evidence path too, which no reader can recompute from the receipt, so it reads as unattested.
 * That fails closed — the package reads back at its pre-receipt status with a warning naming the
 * file — and re-running `acknowledge` re-establishes it. Widening the rule to "some acknowledgement
 * event exists for this Change" would restore those receipts but accept forged ones alongside them,
 * because the index event summary carries no package or role to bind a receipt to.
 *
 * Those checks all diagnose at `warning`, unlike the delivery and dispatch loaders above, and the
 * asymmetry is deliberate. A delivery or a dispatch receipt is load-bearing: the gate result depends
 * on it, so a broken one must stop the run. An ack receipt is a redundant mirror of the audit chain,
 * so skipping a broken one degrades to the audit-event path instead of losing a safety property —
 * whereas erroring means an ordinary rework (dropping a package from `work-packages.yaml` while its
 * receipt file is still on disk, or a half-written JSON file under `ack/`) fails `xforge check` and
 * blocks every transition for a file that can only ever *add* status, never remove a check.
 */
export async function loadAckReceipts(
  project: ProjectContext,
  changeId: string,
  knownPackages: Set<string>,
  deliveries: Map<string, WorkPackageDelivery[]>,
  attestations: AcknowledgementAttestations,
): Promise<{ receipts: Map<string, WorkPackageAckReceipt[]>; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const receipts = new Map<string, WorkPackageAckReceipt[]>();
  const changeRoot = `${project.changesPath}/${changeId}`;
  const changeDirectory = await safeResolve(project.root, changeRoot);
  const names = (await fg('evidence/agents/*/ack/*.json', {
    cwd: changeDirectory,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true,
  })).sort();
  for (const name of names) {
    const projectPath = `${changeRoot}/${name}`;
    let receipt: WorkPackageAckReceipt;
    try {
      receipt = JSON.parse(await readFile(await safeResolve(project.root, projectPath), 'utf8')) as WorkPackageAckReceipt;
    } catch (error) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_ACK_RECEIPT_INVALID', `Acknowledgement receipt is not valid JSON: ${(error as Error).message}`, projectPath, 'warning'));
      continue;
    }
    /* Downgraded for the same reason as the checks below: a malformed ack file is skipped, not fatal. */
    const schemaDiagnostics = await validateSchema('work-package-ack-receipt', receipt, projectPath);
    const schemaFailed = schemaDiagnostics.some((item) => item.severity === 'error');
    diagnostics.push(...schemaDiagnostics.map((item) => ({ ...item, severity: 'warning' as const })));
    if (schemaFailed) continue;
    const { digest, ...unsigned } = receipt;
    if (digest !== sha256(stableStringify(unsigned))) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_ACK_RECEIPT_DIGEST_INVALID', 'Acknowledgement receipt digest is invalid.', projectPath, 'warning'));
      continue;
    }
    const parts = name.split('/');
    const directoryId = parts[2]!;
    const fileName = path.posix.basename(name, '.json');
    if (receipt.change !== changeId || receipt.packageId !== directoryId || fileName !== `${receipt.executionId}-${receipt.as}`) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_ACK_RECEIPT_PATH_MISMATCH', 'Acknowledgement receipt identifiers must match its Change and evidence path.', projectPath, 'warning'));
      continue;
    }
    /*
     * The filename check above binds the file to `as`, but nothing bound `as` to `status` — so an
     * `as: integrator` receipt could claim `status: reviewed` and skip the independent review step
     * the reviewer role exists to record. `acknowledge` only ever writes the pairing below.
     */
    if (receipt.status !== ACK_ROLE_STATUS[receipt.as]) {
      diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_ACK_RECEIPT_ROLE_MISMATCH',
        `Acknowledgement receipt as "${receipt.as}" must record status "${ACK_ROLE_STATUS[receipt.as]}", not "${receipt.status}".`,
        projectPath,
        'warning',
        { as: receipt.as, status: receipt.status },
      ));
      continue;
    }
    if (!knownPackages.has(receipt.packageId)) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_ACK_RECEIPT_UNKNOWN', `Acknowledgement receipt references unknown work package ${receipt.packageId}.`, projectPath, 'warning'));
      continue;
    }
    const matchingDelivery = deliveries.get(receipt.packageId)?.find((item) => item.execution_id === receipt.executionId);
    if (!matchingDelivery || sha256(stableStringify(matchingDelivery)) !== receipt.deliveryDigest) {
      diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_ACK_RECEIPT_DELIVERY_MISMATCH',
        `Acknowledgement receipt for ${receipt.packageId} does not match a known delivery for execution ${receipt.executionId}.`,
        projectPath,
        'warning',
      ));
      continue;
    }
    if (!attestations.attests(receipt.digest)) {
      /* A receipt the chain never attested reads as a forgery: it must not drive status, and it is
         dropped here rather than filtered later so nothing downstream can expose it as real. */
      diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_ACK_UNATTESTED',
        `Acknowledgement receipt for ${receipt.packageId} (${receipt.as}) is not attested by the audit chain and is ignored.`,
        projectPath,
        'warning',
        { packageId: receipt.packageId, as: receipt.as, actor: receipt.actor.id },
      ));
      continue;
    }
    const list = receipts.get(receipt.packageId) ?? [];
    list.push(receipt);
    receipts.set(receipt.packageId, list);
  }
  return { receipts, diagnostics };
}

