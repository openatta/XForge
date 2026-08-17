import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, FileChange, ProjectContext, VerificationEntry } from '../types.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { sha256 } from '../core/hash.js';
import { assertManaged } from '../core/project-loader.js';
import { validateSchema } from '../core/validator.js';
import { dumpYaml } from '../core/yaml.js';
import { parse as parseYaml } from 'yaml';

/**
 * Writes `manifest.verification` on the project's behalf, instead of asking an Agent to hand-edit
 * YAML into the one file it cannot afford to break.
 *
 * The Manifest is the governance dispatcher's input. When it does not parse or does not validate,
 * the dispatcher fails closed and denies every tool call — correctly, since it cannot vouch for a
 * policy set it cannot read. The consequence is a deadlock: the editor that broke the file is now
 * unable to open it. A live run reached exactly that state, having declared the right command but
 * indented it one level short, which swallowed `scaffold.mcpServers` into the new block:
 *
 *     verification:
 *       unit-tests:
 *         - command: [npm, test]
 *       mcpServers:            # belonged to scaffold:
 *         - enterprise-approvals
 *
 * `XFORGE_SCHEMA_INVALID`, then nothing worked, including the repair.
 *
 * XForge does not implement CRUD for every resource (`docs/XFORGE_PRODUCT_SPEC.md` §5.9), and this
 * is not a general exception to that. It is the same reasoning that already makes `approve`,
 * `transition` and `work-package` commands rather than files an Agent writes: correctness that
 * cannot be left to hand-editing, in a place where being wrong is expensive to undo. Everything a
 * project *authors* — Proposals, Specs, Designs, Skills — stays hand-written.
 *
 * Two properties make this worth the command:
 *
 * - **The result is validated before it is written.** A declaration that would produce a Manifest
 *   the dispatcher cannot load is refused, so this command cannot create the deadlock it exists to
 *   prevent.
 * - **Everything else in the file is preserved byte for byte.** Only the `verification:` block is
 *   rewritten, so comments, key order and formatting survive — the same discipline
 *   `reconcileDeclaredCliVersion` follows for the three version pins.
 */

export interface VerificationDeclareOptions {
  gate: string;
  /** JSON array of argv, e.g. `["cargo","test"]`. */
  command?: string;
  module?: string;
  covers?: string;
  workingDirectory?: string;
  timeoutSeconds?: string;
  /** Marker path this Gate deliberately does not cover; mutually exclusive with `command`. */
  notApplicable?: string;
  justification?: string;
  by: string;
  dryRun: boolean;
}

function parseArgv(raw: string, option: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch {
    throw new XForgeError(diagnostic(
      'XFORGE_VERIFICATION_COMMAND_INVALID',
      `${option} must be a JSON array of arguments, for example --command '["cargo","test"]'. A plain string is refused because splitting it would guess where the arguments are, and a command with a quoted argument would be split wrongly and silently.`,
    ));
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new XForgeError(diagnostic(
      'XFORGE_VERIFICATION_COMMAND_INVALID',
      `${option} must be a non-empty JSON array of non-empty strings, for example --command '["cargo","test"]'.`,
    ));
  }
  return parsed as string[];
}

/**
 * Replaces the top-level `verification:` block, or appends one, leaving the rest of the file alone.
 *
 * The block is machine-owned, so re-serializing it costs nothing. Every other line is carried
 * across untouched, which is what keeps a project's own comments — and the ones this repository's
 * own tests assert survive an upgrade — from being erased by a YAML round trip.
 */
function withVerificationBlock(source: string, verification: Record<string, VerificationEntry[]>): string {
  const withoutBlock = source.replace(/^verification:\n(?:[ \t]+[^\n]*\n|\n(?=[ \t]))*/m, '');
  const trimmed = withoutBlock.replace(/\n+$/, '\n');
  if (Object.keys(verification).length === 0) return trimmed;
  return `${trimmed}${dumpYaml({ verification })}`;
}

export async function executeVerificationDeclare(
  project: ProjectContext,
  options: VerificationDeclareOptions,
): Promise<{ data: Record<string, unknown>; diagnostics: Diagnostic[]; changes: FileChange[] }> {
  assertManaged(project, 'verification declare');
  if (Boolean(options.command) === Boolean(options.notApplicable)) {
    throw new XForgeError(diagnostic(
      'XFORGE_VERIFICATION_ARGUMENTS_REQUIRED',
      'Declare exactly one of --command (this is how the Gate runs) or --not-applicable (this Gate deliberately does not cover that toolchain).',
    ));
  }
  if (options.notApplicable && !options.justification) {
    throw new XForgeError(diagnostic(
      'XFORGE_VERIFICATION_ARGUMENTS_REQUIRED',
      '--not-applicable requires --justification. A toolchain left uncovered without a stated reason is indistinguishable from one nobody noticed.',
    ));
  }

  const declaredAt = new Date().toISOString();
  const entry: VerificationEntry = options.command
    ? {
      command: parseArgv(options.command, '--command'),
      ...(options.module ? { module: options.module } : {}),
      ...(options.covers ? { covers: parseArgv(options.covers, '--covers') } : {}),
      ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      ...(options.timeoutSeconds ? { timeoutSeconds: Number(options.timeoutSeconds) } : {}),
      declaredBy: options.by,
      declaredAt,
    }
    : { notApplicable: options.notApplicable!, justification: options.justification!, declaredBy: options.by, declaredAt };

  const relative = 'xforge/manifest.yaml';
  const absolute = path.join(project.root, 'xforge', 'manifest.yaml');
  const source = await readFile(absolute, 'utf8');
  const current = (parseYaml(source) ?? {}) as { verification?: Record<string, VerificationEntry[]> };
  const verification = { ...(current.verification ?? {}) };
  verification[options.gate] = [...(verification[options.gate] ?? []), entry];

  const next = withVerificationBlock(source, verification);

  /*
   * Validated before it reaches disk. This command exists because a malformed Manifest locks an
   * Agent out of repairing it, so producing one here would defeat the entire point — a refusal
   * costs a retry, a bad write costs the session.
   */
  const parsed = (() => {
    try { return parseYaml(next); }
    catch (error) { throw new XForgeError(diagnostic('XFORGE_VERIFICATION_WRITE_REFUSED', `Declaring this would produce a Manifest that no longer parses (${(error as Error).message}); nothing was written.`, relative)); }
  })();
  const schemaDiagnostics = await validateSchema('manifest', parsed, relative);
  if (schemaDiagnostics.some((item) => item.severity === 'error')) {
    throw new XForgeError([
      diagnostic('XFORGE_VERIFICATION_WRITE_REFUSED', 'Declaring this would produce a Manifest that fails validation, which would make the governance dispatcher deny every tool call. Nothing was written.', relative),
      ...schemaDiagnostics,
    ], { root: project.root });
  }

  if (!options.dryRun) await atomicWrite(project.root, relative, next);
  return {
    data: { gate: options.gate, entry, dryRun: options.dryRun, declarations: verification[options.gate]!.length },
    diagnostics: [],
    changes: next === source ? [] : [{ action: 'modify', path: relative, digest: sha256(next), source: `verification:${options.gate}` }],
  };
}
