#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { access } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { CLI_NAME, CLI_VERSION, PROTOCOL_VERSION } from './constants.js';
import { executeArchive } from './commands/archive.js';
import { executeApprove, type ApprovalTerminal } from './commands/approve.js';
import { executeAudit } from './commands/audit.js';
import { executeCheck } from './commands/check.js';
import { executeAdvance } from './commands/advance.js';
import { executeStage } from './commands/stage.js';
import { nextActionsFor, withPostState } from './commands/next-actions.js';
import { executeStageBundle, renderStageBundleText, renderStageText } from './commands/stage-bundle.js';
import { executeContractList, executeContractStatus, renderContractListText, renderContractStatusText } from './commands/contract.js';
import { executeExplain, renderExplainText } from './commands/explain.js';
import { executeFindingsResolve } from './commands/findings.js';
import { executeVerificationDeclare, executeVerificationDraftReceipt, executeVerificationFinalize, executeVerificationRetire } from './commands/verification.js';
import { executeInstall } from './commands/install.js';
import { executeState, renderStateText } from './commands/state.js';
import { executeSync } from './commands/sync.js';
import { executeUninstall } from './commands/uninstall.js';
import { executeUpdate } from './commands/update.js';
import { executeTransition, repairTransitionChain } from './commands/transition.js';
import { executeReviewAcknowledge } from './commands/review.js';
import { executeHookDispatch, hookFailureOutput, hookPlatformOutput, repairAffordance } from './commands/hook.js';
import { executeInit } from './commands/init.js';
import { executeWorkPackageAcknowledge, executeWorkPackageDispatch, executeWorkPackageDraft } from './commands/work-package.js';
import { executeDoctor } from './commands/doctor.js';
import { executeUpgrade, renderUpgradeText } from './commands/upgrade.js';
import { XForgeError, diagnostic } from './core/errors.js';
import { actualGitIdentity, runtimeCliIntegrity, runtimeInstallation } from './core/identity.js';
import { loadProject } from './core/project-loader.js';
import { detectScaffoldLanguage } from './core/language.js';
import { envelope, present } from './protocol/envelope.js';
import { resolveEnvelopeField } from './protocol/field-path.js';
import { commandPosition, helpEnvelope, parseArguments, recoveredHookEvent, recoveredHookTarget, type CommandName, type ParsedArguments } from './cli/arguments.js';
import type { Diagnostic, Envelope, NextAction, ScaffoldLanguage } from './types.js';




async function fileExists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function selectInitLanguage(root: string, explicit?: ScaffoldLanguage): Promise<ScaffoldLanguage | undefined> {
  if (explicit) return explicit;
  if (await fileExists(path.join(root, 'xforge', 'manifest.yaml'))) return undefined;
  const detected = detectScaffoldLanguage();
  if (detected) return detected;
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    throw new XForgeError(diagnostic(
      'XFORGE_LANGUAGE_REQUIRED',
      'Scaffold language could not be detected in a non-interactive session. Re-run init with --language en or --language zh-CN.',
    ), {
      root,
      nextActions: [{
        action: 'select-language',
        type: 'maintenance',
        actor: 'human',
        status: 'blocked',
        reason: 'Choose the language used for installed sub-Agent and Skill instructions.',
        command: ['xforge', 'init', '--language', '<en|zh-CN>'],
      }],
    });
  }
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    while (true) {
      const answer = (await terminal.question('Select XForge Agent/Skill language: [1] English  [2] 中文: ')).trim();
      if (answer === '1' || /^en(?:glish)?$/i.test(answer)) return 'en';
      if (answer === '2' || /^(?:zh(?:-cn)?|中文)$/i.test(answer)) return 'zh-CN';
      process.stderr.write('Please enter 1 for English or 2 for 中文.\n');
    }
  } finally {
    terminal.close();
  }
}


function versionEnvelope(): Envelope {
  return envelope({
    command: 'version',
    root: null,
    data: {
      name: CLI_NAME,
      version: CLI_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      nodeVersion: process.version,
      /* Null on an installed copy, and that is the honest answer — see `actualGitIdentity`. */
      buildIdentity: actualGitIdentity(),
      installation: runtimeInstallation(),
      integrity: runtimeCliIntegrity(),
      /*
       * Which file is actually answering. A global install and a project-local one resolve the
       * same command name, so when a project reports XFORGE_CLI_IDENTITY_MISMATCH the first
       * question is which of them ran — and every other field here describes the build rather than
       * where it was found.
       */
      executablePath: process.argv[1] ?? null,
    },
  });
}

async function dispatch(parsed: ParsedArguments): Promise<Envelope> {
  if (parsed.command === 'help') return helpEnvelope(parsed.helpCommand, parsed.helpSubcommand);
  if (parsed.command === 'version') return versionEnvelope();
  if (parsed.command === 'explain') {
    /* Beside `help` and `version` because it answers about the CLI rather than about a project: a
       reader who hit a code in a directory that is not an XForge project still needs the answer. */
    if (!parsed.explainCode) throw new XForgeError(diagnostic('XFORGE_ARGUMENT_REQUIRED', 'explain requires a diagnostic code, for example `xforge explain XFORGE_GATE_EVIDENCE_STALE`.'));
    const result = await executeExplain({ code: parsed.explainCode });
    return envelope({ command: 'explain', root: null, ...result });
  }

  if (parsed.command === 'init') {
    const root = path.resolve(process.cwd(), parsed.root ?? '.');
    const language = await selectInitLanguage(root, parsed.language);
    const result = await executeInit(root, { target: parsed.target, language, dryRun: parsed.dryRun });
    return envelope({ command: 'init', root, ...result });
  }

  const root = parsed.root ? path.resolve(process.cwd(), parsed.root) : process.cwd();

  /*
   * The hook payload is read before the project is, because the project is what may be broken.
   *
   * A Manifest that does not validate makes `loadProject` throw, which is earlier than any
   * dispatcher logic and therefore denies every tool call — including the read and the `xforge`
   * invocation that would repair it. Two live runs died in that deadlock. Knowing which tool is
   * being attempted is what makes it escapable, and that knowledge is on stdin.
   */
  let hookPayload: Record<string, unknown> | null = null;
  if (parsed.command === 'hook') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const source = Buffer.concat(chunks).toString('utf8').trim();
    hookPayload = source ? JSON.parse(source) as Record<string, unknown> : {};
  }

  let project: Awaited<ReturnType<typeof loadProject>>;
  try {
    project = await loadProject(root, { exactRoot: Boolean(parsed.root) });
  } catch (error) {
    const payload = hookPayload as Record<string, any> | null;
    const repair = payload && parsed.target
      ? repairAffordance(parsed.target, String(payload.tool_name ?? payload.toolName ?? payload.tool ?? payload.name ?? 'unknown'),
        (payload.tool_input ?? payload.toolArgs ?? payload.input ?? payload.args ?? {}) as Record<string, any>)
      : null;
    if (!repair) throw error;
    const detail = error instanceof XForgeError ? error.diagnostics[0]?.message ?? 'the project could not be loaded' : (error as Error).message;
    const reason = `${detail} — this call is permitted only because it is ${repair}, which is how that gets diagnosed and fixed. Every other tool call stays denied until it is.`;
    return envelope({
      command: 'hook',
      root: null,
      data: { platformOutput: hookPlatformOutput(parsed.target!, parsed.event!, 'allow', reason, false) },
    });
  }
  const command = parsed.command as Exclude<CommandName, 'help' | 'version' | 'init'>;
  if (command === 'contract') {
    if (parsed.subcommand === 'list') {
      const result = await executeContractList(project, { kind: parsed.contractKind });
      return envelope({ command: 'contract', root: project.root, data: result.data, diagnostics: result.diagnostics });
    }
    if (parsed.subcommand === 'status') {
      const result = await executeContractStatus(project);
      return envelope({ command: 'contract', root: project.root, data: result.data, diagnostics: result.diagnostics });
    }
    throw new XForgeError(diagnostic('XFORGE_SUBCOMMAND_UNKNOWN', `Unknown contract subcommand: ${parsed.subcommand ?? '(none)'}. They are \`list\` and \`status\`.`));
  }
  if (command === 'state') {
    const result = await executeState(project, { change: parsed.change, kind: parsed.kind, target: parsed.target, include: parsed.include });
    const nextActions = await nextActionsFor(project, result.data as Record<string, any>, parsed.change);
    return envelope({ command, root: project.root, data: result.data, diagnostics: result.diagnostics, nextActions });
  }
  if (command === 'install') {
    const result = await executeInstall(project, { target: parsed.target, dryRun: parsed.dryRun, adopt: parsed.adopt });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'sync') {
    const result = await executeSync(project, { target: parsed.target, dryRun: parsed.dryRun, verifyDigests: parsed.verifyDigests, adopt: parsed.adopt });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'update') {
    const result = await executeUpdate(project, { target: parsed.target, dryRun: parsed.dryRun, adopt: parsed.adopt });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'uninstall') {
    const result = await executeUninstall(project, { target: parsed.target, dryRun: parsed.dryRun, force: parsed.force });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'check') {
    const result = await executeCheck(project, { change: parsed.change, gate: parsed.gate, stage: parsed.stage, allGates: parsed.allGates, force: parsed.force, evidence: parsed.evidenceDetail as 'summary' | 'full' | undefined });
    return envelope({ command, root: project.root, ...await withPostState(project, parsed.change, result, parsed.dryRun) });
  }
  if (command === 'advance') {
    const result = await executeAdvance(project, { change: parsed.change!, to: parsed.to, dryRun: parsed.dryRun });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'stage') {
    const result = await executeStage(project, { change: parsed.change!, content: parsed.content });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'stage-bundle') {
    const result = await executeStageBundle(project, { change: parsed.change!, content: 'none' });
    return envelope({
      command,
      root: project.root,
      ...result,
      diagnostics: [...result.diagnostics, diagnostic(
        'XFORGE_STAGE_BUNDLE_SUPERSEDED',
        'stage-bundle lists which files to read; `xforge stage --change <id>` lists them and sends their text, together with the ready Action and the diagnostics — which is the whole reason the list was wanted. This still works and is not going away in this release.',
        null as unknown as string,
        'info',
      )],
    });
  }
  if (command === 'verification') {
    if (parsed.subcommand === 'draft-receipt') {
      const result = await executeVerificationDraftReceipt(project, { change: parsed.change! });
      return envelope({ command, root: project.root, ...result });
    }
    if (parsed.subcommand === 'finalize') {
      const result = await executeVerificationFinalize(project, {
        change: parsed.change!, status: parsed.status!, by: parsed.by!, dryRun: parsed.dryRun,
      });
      return envelope({ command, root: project.root, ...result });
    }
    if (parsed.subcommand === 'retire') {
      const result = await executeVerificationRetire(project, {
        gate: parsed.gateName!, command: parsed.commandArgv, notApplicable: parsed.notApplicable,
        module: parsed.module, by: parsed.by!, reason: parsed.reason!, dryRun: parsed.dryRun,
      });
      return envelope({ command, root: project.root, ...result });
    }
    const result = await executeVerificationDeclare(project, {
      gate: parsed.gateName!, command: parsed.commandArgv, module: parsed.module, covers: parsed.covers,
      workingDirectory: parsed.workingDirectory, timeoutSeconds: parsed.timeoutSeconds,
      notApplicable: parsed.notApplicable, justification: parsed.justification, by: parsed.by!, dryRun: parsed.dryRun,
    });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'upgrade-scaffold') {
    if (parsed.complete && parsed.rollback) {
      throw new XForgeError(diagnostic(
        'XFORGE_UPGRADE_MODE_AMBIGUOUS',
        'Pass at most one of --complete and --rollback. Completing an upgrade and abandoning it are opposite decisions, and nothing here can choose between them.',
      ));
    }
    const mode = parsed.complete ? 'complete' : parsed.rollback ? 'rollback' : 'stage';
    const result = await executeUpgrade(project, {
      mode, dryRun: parsed.dryRun, force: parsed.force, withActiveChanges: parsed.withActiveChanges, allowDirty: parsed.allowDirty,
    });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'findings') {
    const result = await executeFindingsResolve(project, {
      change: parsed.change!, id: parsed.findingId!, answer: parsed.answer!, by: parsed.by!, dryRun: parsed.dryRun,
    });
    return envelope({ command, root: project.root, ...await withPostState(project, parsed.change, result, parsed.dryRun) });
  }
  if (command === 'review') {
    const result = await executeReviewAcknowledge(project, { change: parsed.change!, evidence: parsed.evidence!, scope: parsed.scope, dryRun: parsed.dryRun });
    return envelope({ command, root: project.root, ...await withPostState(project, parsed.change, result, parsed.dryRun) });
  }
  if (command === 'transition') {
    if (parsed.subcommand === 'repair') {
      const result = await repairTransitionChain(project, { change: parsed.change!, receiptId: parsed.receiptId!, dryRun: parsed.dryRun });
      return envelope({ command, root: project.root, ...await withPostState(project, parsed.change, result, parsed.dryRun) });
    }
    const result = await executeTransition(project, { change: parsed.change!, to: parsed.to!, dryRun: parsed.dryRun });
    return envelope({ command, root: project.root, ...await withPostState(project, parsed.change, result, parsed.dryRun) });
  }
  if (command === 'approve') {
    /*
     * The local approval path requires this process to be attached to a terminal on both ends, and
     * reads the decision word from that terminal rather than from argv. Be precise about what that
     * establishes: an interactive session existed and something answered the prompts. It is not
     * proof of human identity. A pty (`script -q`, `expect`, node-pty) satisfies both isTTY checks
     * and can answer the questions, and the receipt it produces is indistinguishable from one a
     * person typed — so this check raises the cost of a self-approval and makes it a deliberate,
     * recorded act; it does not make one impossible. XForge's default posture is honest-agent
     * governance: the local path is trustworthy to exactly the degree the operator's environment is.
     *
     * There is deliberately no manifest switch to relax this. Any such switch would live inside the
     * tree the governed Agent writes, which makes it the Agent's own decision whether governance
     * applies to it. A policy that needs a stronger property than "an interactive session made this
     * call" should require an mcp provider whose secret and endpoint live outside the Agent's reach;
     * only there is the decision made somewhere the Agent cannot write.
     */
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    /* Only the local path prompts; --provider never touches the terminal. */
    const wantsLocal = !parsed.provider;
    let terminal: ApprovalTerminal | undefined;
    let close: (() => void) | undefined;
    if (wantsLocal && interactive) {
      const reader = createInterface({ input: process.stdin, output: process.stderr });
      let ended = false;
      reader.once('close', () => { ended = true; });
      const endedError = (): XForgeError => new XForgeError(diagnostic(
        'XFORGE_APPROVAL_INTERACTIVE_REQUIRED',
        'The approval dialogue needs a live terminal; input ended before a decision was given.',
      ));
      terminal = {
        present(message: string) { process.stderr.write(`${message}\n`); },
        async question(prompt: string) {
          if (ended) throw endedError();
          /* stdin can be /dev/null even when isTTY passes upstream: never await a line that can no
             longer arrive, or the CLI hangs instead of refusing. */
          return Promise.race([
            reader.question(prompt),
            new Promise<string>((_resolve, reject) => reader.once('close', () => reject(endedError()))),
          ]);
        },
      };
      close = () => reader.close();
    }
    try {
      const result = await executeApprove(project, { change: parsed.change!, transition: parsed.transition!, policy: parsed.policy, actor: parsed.actor, role: parsed.role, reason: parsed.reason, decision: parsed.decision, attestation: parsed.attestation, provider: parsed.provider, interactive, dryRun: parsed.dryRun, terminal });
      return envelope({ command, root: project.root, ...result });
    } finally {
      close?.();
    }
  }
  if (command === 'audit') {
    const result = await executeAudit(project, { action: parsed.subcommand as 'status' | 'verify' | 'export' | 'retry' | 'prune', change: parsed.change, output: parsed.output });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'work-package') {
    if (parsed.subcommand === 'dispatch') {
      const result = await executeWorkPackageDispatch(project, { change: parsed.change!, packageId: parsed.packageId!, commit: parsed.commit === true, dryRun: parsed.dryRun });
      return envelope({ command, root: project.root, ...result });
    }
    if (parsed.subcommand === 'draft') {
      const result = await executeWorkPackageDraft(project, { change: parsed.change!, packageId: parsed.packageId! });
      return envelope({ command, root: project.root, ...result });
    }
    const result = await executeWorkPackageAcknowledge(project, { change: parsed.change!, packageId: parsed.packageId!, role: parsed.acknowledgeAs!, evidence: parsed.evidence!, scope: parsed.scope, dryRun: parsed.dryRun });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'hook') {
    const result = await executeHookDispatch(project, { target: parsed.target!, event: parsed.event!, payload: hookPayload ?? {} });
    return envelope({ command, root: project.root, data: result });
  }
  if (command === 'doctor') {
    const result = await executeDoctor(project, { kind: parsed.kind, strict: parsed.strict });
    return envelope({ command, root: project.root, ...result });
  }
  const result = await executeArchive(project, parsed.change!, parsed.dryRun);
  return envelope({ command, root: project.root, ...result });
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedArguments | null = null;
  let result: Envelope;
  try {
    parsed = parseArguments(argv);
    result = await dispatch(parsed);
  } catch (error) {
    const command = parsed?.command ?? argv.find((item) => !item.startsWith('--')) ?? '';
    let diagnostics: Diagnostic[];
    let nextActions: NextAction[] = [];
    let root: string | null = null;
    if (error instanceof XForgeError) {
      diagnostics = error.diagnostics;
      nextActions = error.nextActions;
      root = error.root;
    } else {
      diagnostics = [diagnostic('XFORGE_INTERNAL_ERROR', (error as Error).message || 'Unexpected internal error.')];
    }
    result = envelope({ command, root, data: null, diagnostics, nextActions, ok: false });
  }
  /*
   * The Hook contract: stdout is exactly one JSON line in the platform's own output shape, and a
   * failed dispatch exits 2 (0 for `after` events, whose failure must not break the platform's own
   * bookkeeping). This branch must also fire when argument parsing itself threw — a full Envelope
   * on the platform output channel is read as a decision object with no opinion, i.e. a
   * misconfigured hook command would silently permit every tool call.
   */
  if (parsed?.command === 'hook' || (parsed === null && commandPosition(argv) === 'hook')) {
    if (result.ok) {
      process.stdout.write(`${JSON.stringify((result.data as { platformOutput?: unknown } | null)?.platformOutput ?? {})}\n`);
      return 0;
    }
    const target = parsed?.target ?? recoveredHookTarget(argv);
    const event = parsed?.event ?? recoveredHookEvent(argv);
    /* The deny is all the host renders, so the diagnostic's own message — which names the file at
       fault and the command that fixes it — has to ride along. Dropping it is what turns a
       one-command configuration problem into "every tool call is refused and nobody knows why". */
    /*
     * A CLI too old for the project explains every other complaint it makes, so it goes first.
     *
     * An older build validates the project's files against its own older schemas, so the first
     * error it finds is that `lock.yaml` carries fields it does not know. That describes the
     * reader, not the project -- and as a hook's deny reason it sends an operator to edit a
     * governance file that is not wrong. A live run met it: a 0.7.20 binary on PATH against a 0.8.1
     * project, every tool call denied, cause given as `/paths must NOT have additional properties`.
     */
    const reason = result.diagnostics.find((item) => item.code === 'XFORGE_CLI_IDENTITY_MISMATCH')?.message
      ?? result.diagnostics.find((item) => item.severity === 'error')?.message
      ?? result.diagnostics[0]?.message;
    process.stdout.write(`${JSON.stringify(hookFailureOutput(target, event, reason))}\n`);
    return event.includes('after') ? 0 : 2;
  }
  const textMode = parsed?.text ?? argv.some((item) => ['--text', '--help', '--version'].includes(item));
  /*
   * `--field` prints one value and nothing else, so `$(xforge state --field ...)` is safe.
   *
   * The alternative people actually used was `grep` over the JSON, and it silently returned the
   * wrong answer: `contentRevision` appears once per historical receipt in `xforge state`, so
   * `grep -m1` reported an old revision as the current one and a live run hand-wrote a receipt
   * against it. A miss therefore fails loudly rather than printing an empty line — an empty
   * capture that looks like a value is the failure mode this exists to remove.
   */
  /* Only a successful run renders: a failed one has `data: null` and its diagnostics are the
     result, which the standard text form already prints. */
  let render: ((data: unknown) => string) | undefined;
  if (parsed?.command === 'explain' && result.ok) {
    render = (data: unknown) => renderExplainText(data as Record<string, unknown>);
  } else if (parsed?.command === 'contract' && result.ok) {
    /* A list of ids is what a person came for; as JSON it is the same list behind two levels of
       nesting, and the ids are what gets copied into a delta by hand. */
    render = parsed.subcommand === 'status'
      ? (data: unknown) => renderContractStatusText({ ok: true, data, diagnostics: [] } as Parameters<typeof renderContractStatusText>[0])
      : (data: unknown) => renderContractListText({ ok: true, data, diagnostics: [] } as Parameters<typeof renderContractListText>[0]);
  } else if (parsed?.command === 'stage' && result.ok) {
    /* The plan, without the contents. A measured run reached for `--text` here and got the JSON with
       a heading on it -- larger than the JSON, for a reader who wanted less. */
    render = (data: unknown) => renderStageText(data as Parameters<typeof renderStageText>[0]);
  } else if (parsed?.command === 'stage-bundle' && result.ok) {
    /* The reading plan is the entire output; as JSON it is a list of paths nobody scans. */
    render = (data: unknown) => renderStageBundleText(data as Parameters<typeof renderStageBundleText>[0]);
  } else if (parsed?.command === 'state' && result.ok) {
    /* `state`'s `data` is the entire resolved project; printed as JSON it buries the envelope's own
       `Next actions:` block under tens of thousands of characters. See `renderStateText`. */
    render = (data: unknown) => renderStateText(data);
  } else if (parsed?.command === 'upgrade-scaffold' && result.ok) {
    /* The plan is the whole output of a staged upgrade, and a wall of JSON is not a thing anyone
       reads before deciding what to merge. */
    render = (data: unknown) => renderUpgradeText({ data: data as Record<string, unknown>, diagnostics: [], changes: [] });
  }

  if (parsed?.fields?.length) {
    const paths = parsed.fields;
    /* Resolve them all before printing anything: a caller that received three of four values and a
       zero exit would carry on believing it had four. */
    const resolutions = paths.map((path) => ({ path, resolved: resolveEnvelopeField(result, path) }));
    /*
     * A failed call answers the question it was asked, not every question.
     *
     * `--field` used to apply only to `ok` results, so a refusal printed the whole resolved project
     * — and the call an Agent makes right after a refusal is `--field diagnostics`, asking what went
     * wrong. A measured Major run spent 105KB, 27% of everything the CLI said to it, receiving the
     * entire project five times in answer to a request for one value. That is the same cost the
     * typo path below was written to avoid, on the path that is actually taken more often.
     *
     * What a refusal must never do is read like a success: `ok` stays false, every diagnostic is
     * kept, and the exit code is still 1. Only `data` narrows. A path that does not resolve is
     * reported as such rather than sent back as `null`, because a failed call often has not built
     * the section being asked about, and "absent" and "null" are different answers.
     */
    if (!result.ok) {
      const missing = resolutions.filter((item) => !item.resolved.found);
      /*
       * Only what came out of `data` is echoed into it. A path is looked up in `data` first and
       * then among the envelope's own fields, so `--field diagnostics` resolves to the list this
       * envelope is already printing -- copying it into `data` would answer one question twice,
       * which on a refusal is most of the reply.
       */
      const fromData = resolutions.filter((item) => item.resolved.found
        && (paths.length > 1
          /*
           * A set that was asked for as a set comes back as a set.
           *
           * The rule below -- echo only what came out of `data` -- is right for one field, where
           * copying `diagnostics` into `data` would answer the same question twice. It is wrong for
           * several: `--field nextActions --field diagnostics --field project --field flows` on a
           * refusal put four of them under `data` and left two at the envelope's top level, with
           * nothing in the reply saying which was where. Three separate readers written against
           * this in one afternoon each read the half they were not looking at as "no answer".
           */
          || (result.data !== null && typeof result.data === 'object'
            && Object.hasOwn(result.data as object, item.path.split('.')[0]!))));
      process.stdout.write(present({
        ...result,
        data: fromData.length > 0
          ? Object.fromEntries(fromData.map((item) => [item.path, (item.resolved as { value: unknown }).value]))
          : null,
        diagnostics: [...result.diagnostics, ...missing.map((item) => diagnostic(
          'XFORGE_FIELD_NOT_FOUND',
          `No value at --field ${item.path}: this call did not succeed, so that part of the answer was never built. ${(item.resolved as { reason: string }).reason} The diagnostics above say why the call failed; run it without --field to see the whole envelope.`,
        ))],
      }, textMode, render));
      return 1;
    }
    const failed = resolutions.filter((item) => !item.resolved.found);
    /*
     * A write that happened is never reported as a failure because of how somebody asked to read it.
     *
     * `transition --to apply --field change.governance.currentStage` writes the receipt and then
     * looks up a path a transition envelope does not carry -- it reports `change` as an id, not the
     * resolved Change -- so the lookup failed after the commit and the call answered `ok:false`,
     * `data:null`, exit 1. A live run read that as a refusal, and `transition && <next>` breaks on a
     * transition that worked, which is the exact pattern XFORGE.md tells Agents to use.
     *
     * So when the command wrote something, the narrowing is abandoned rather than the result: the
     * whole envelope is printed, `ok` stays true, the exit code stays 0, and the diagnostic says
     * which path did not resolve and what the envelope does carry. Nothing is silently dropped --
     * the caller gets more than it asked for, with the reason, instead of being told its write
     * failed.
     */
    if (failed.length > 0 && result.changes.length > 0) {
      process.stdout.write(present({
        ...result,
        diagnostics: [...result.diagnostics, ...failed.map((item) => diagnostic(
          'XFORGE_FIELD_NOT_FOUND',
          `No value at --field ${item.path}. ${(item.resolved as { reason: string }).reason} This command wrote its result, so the whole envelope is printed rather than the values you asked for — the write is recorded either way.`,
        ))],
      }, textMode, render));
      return 0;
    }
    if (failed.length > 0) {
      process.stdout.write(present({
        ...result, ok: false,
      /*
       * `data: null`, and the reason is not the obvious one.
       *
       * The caller narrowed to these values and named one wrongly, and answering with the entire
       * resolved project costs an Agent ~12K tokens of context for a typo. The diagnostics below
       * already say the shape is not here and how to ask for it.
       *
       * Returning the paths that *did* resolve was tried, on the reasoning that a caller asking for
       * four values and mistyping one should not have to ask again for the three it had been given
       * -- one measured run discarded fifteen resolved values that way, once eight of ten. It was
       * reverted. Four prior runs raised `XFORGE_FIELD_NOT_FOUND` 4, 4, 4 and 5 times over the same
       * five Stages; with the resolved values kept, the next run raised it **10**, with turns +19%
       * and cost +10% against the arm it was measured against.
       *
       * Making a wrong guess cheap removes the pressure to guess right. The waste was never the
       * discarded values -- it is the guess, and each one is a whole turn whose refusal returns the
       * entire envelope regardless. Paying for the typo once is what keeps the count at four.
       */
      data: null,
        diagnostics: [...result.diagnostics, ...failed.map((item) => diagnostic(
          'XFORGE_FIELD_NOT_FOUND',
          /* `--text` no longer prints `data` verbatim for every command, so the advice names both
             flags: the shape lives in the JSON envelope, which is what dropping them returns. */
          `No value at --field ${item.path}. ${(item.resolved as { reason: string }).reason} Run the command without --field and without --text to see the shape of data.`,
        ))],
      }, textMode, render));
      return 1;
    }
    if (paths.length > 1) {
      /* Keyed by the path the caller wrote, not by the leaf name: two paths can end in the same
         segment, and a caller matching on what it asked for cannot be wrong about which is which. */
      const values = Object.fromEntries(resolutions.map((item) => [item.path, (item.resolved as { value: unknown }).value]));
      process.stdout.write(`${JSON.stringify(values)}\n`);
      return 0;
    }
    const value = (resolutions[0]!.resolved as { value: unknown }).value;
    process.stdout.write(`${value === null || typeof value === 'object' ? JSON.stringify(value) : String(value)}\n`);
    return 0;
  }
  process.stdout.write(present(result, textMode, render));
  return result.ok ? 0 : 1;
}

/*
 * Run only when this file is what node was asked to execute.
 *
 * `runCli` has always been exported, but importing the module ran the whole CLI as a side effect,
 * so the only way to exercise it was to spawn a process. The test suite does that 592 times, at
 * roughly 0.3s of interpreter start-up each -- about half the suite's total runtime spent starting
 * node rather than testing anything.
 *
 * Both sides are realpath'd because an npm bin symlink puts the link path in `argv[1]` and the real
 * path in `import.meta.url`, which compare unequal while naming the same file.
 */
const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) process.exitCode = await runCli();
