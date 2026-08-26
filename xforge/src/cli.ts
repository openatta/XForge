#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { access } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { CLI_NAME, CLI_VERSION, PROTOCOL_VERSION, TARGETS, type TargetId } from './constants.js';
import { executeArchive } from './commands/archive.js';
import { executeApprove, type ApprovalTerminal } from './commands/approve.js';
import { executeAudit } from './commands/audit.js';
import { executeBrief, renderBriefText } from './commands/brief.js';
import { executeCheck } from './commands/check.js';
import { executeFindingsResolve } from './commands/findings.js';
import { executeVerificationDeclare, executeVerificationDraftReceipt, executeVerificationRetire } from './commands/verification.js';
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
import { outlineSections } from './core/artifact-markers.js';
import { detectScaffoldLanguage, parseScaffoldLanguage } from './core/language.js';
import { envelope, present } from './protocol/envelope.js';
import type { Diagnostic, Envelope, FlowAuthority, NextAction, ScaffoldLanguage } from './types.js';

type CommandName = 'help' | 'version' | 'init' | 'state' | 'install' | 'sync' | 'update' | 'uninstall' | 'check' | 'brief' | 'verification' | 'transition' | 'approve' | 'audit' | 'work-package' | 'hook' | 'archive' | 'doctor' | 'upgrade-scaffold' | 'review' | 'findings';

interface ParsedArguments {
  command: string;
  text: boolean;
  dryRun: boolean;
  verifyDigests: boolean;
  strict: boolean;
  allGates: boolean;
  force: boolean;
  adopt: boolean;
  complete: boolean;
  rollback: boolean;
  withActiveChanges: boolean;
  compact: boolean;
  root?: string;
  stage?: string;
  helpCommand?: string;
  subcommand?: string;
  change?: string;
  kind?: 'skills' | 'agents' | 'rules' | 'policies' | 'hooks' | 'gates' | 'scripts' | 'flows' | 'approvals' | 'mcp-servers';
  target?: TargetId;
  gate?: string;
  to?: string;
  transition?: string;
  policy?: string;
  actor?: string;
  role?: string;
  reason?: string;
  decision?: 'approve' | 'reject';
  attestation?: 'human';
  provider?: string;
  output?: string;
  event?: string;
  packageId?: string;
  language?: ScaffoldLanguage;
  acknowledgeAs?: 'integrator' | 'reviewer';
  evidence?: string;
  attachTriage?: string;
  gateName?: string;
  commandArgv?: string;
  module?: string;
  covers?: string;
  workingDirectory?: string;
  timeoutSeconds?: string;
  notApplicable?: string;
  justification?: string;
  findingId?: string;
  answer?: string;
  scope?: string;
  by?: string;
  receiptId?: string;
  field?: string;
}

const COMMANDS: CommandName[] = ['help', 'version', 'init', 'state', 'install', 'sync', 'update', 'uninstall', 'check', 'brief', 'verification', 'transition', 'approve', 'audit', 'work-package', 'hook', 'archive', 'doctor', 'upgrade-scaffold', 'review', 'findings'];
const VALID_KINDS = ['skills', 'agents', 'rules', 'policies', 'hooks', 'gates', 'scripts', 'flows', 'approvals', 'mcp-servers'] as const;
const VALUE_OPTIONS = ['--root', '--change', '--kind', '--target', '--gate', '--to', '--for', '--policy', '--actor', '--role', '--reason', '--decision', '--attestation', '--provider', '--output', '--event', '--package', '--language', '--as', '--evidence', '--stage', '--attach-triage', '--gate-name', '--command', '--module', '--covers', '--working-directory', '--timeout-seconds', '--not-applicable', '--justification', '--by', '--receipt', '--field', '--id', '--answer', '--scope'] as const;

function isValueOption(token: string): boolean {
  return VALUE_OPTIONS.includes(token as (typeof VALUE_OPTIONS)[number]);
}

/**
 * The command word as `parseArguments` would resolve it, recoverable even when parsing threw.
 * It mirrors that scan exactly — a VALUE_OPTIONS flag swallows the token after it — so the value
 * of an option is never mistaken for the command: `xforge state --change hook` is `state`, not
 * `hook`. A bare `argv.includes('hook')` test would get that wrong and route a plain `state`
 * failure onto the Hook output channel.
 */
function commandPosition(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) return token;
    if (isValueOption(token)) index += 1;
  }
  return undefined;
}

/**
 * One value out of an Envelope's `data`, addressed by a dotted path.
 *
 * Array indices are plain segments (`readyTransitions.0.to`). The walk reports *where* it stopped
 * rather than a bare miss, because the whole point is to be told when the path is wrong instead of
 * receiving an empty string that a shell will happily assign to a variable.
 */
function resolveField(data: unknown, path: string): { found: true; value: unknown } | { found: false; reason: string } {
  let current: unknown = data;
  const walked: string[] = [];
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') {
      return { found: false, reason: `${walked.length ? walked.join('.') : 'data'} is ${current === null ? 'null' : typeof current}, which has no "${segment}".` };
    }
    const container = current as Record<string, unknown>;
    /* `hasOwnProperty`, not `in`: `in` walks the prototype chain, so `--field constructor` answered
       with `function Object() { [native code] }` — a confident value for a path the data does not
       contain, which is the exact failure this option exists to remove. */
    if (!Object.prototype.hasOwnProperty.call(container, segment)) {
      const available = Object.keys(container).slice(0, 12);
      return { found: false, reason: `${walked.length ? walked.join('.') : 'data'} has no "${segment}"${available.length ? ` (it has: ${available.join(', ')})` : ''}.` };
    }
    current = container[segment];
    walked.push(segment);
  }
  return { found: true, value: current };
}

/** Raw value of an option, without validating anything else about the command line. */
function optionValue(argv: string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

/**
 * `--target` for a hook invocation whose full parse threw. The fail-closed decision's shape is
 * per-platform, so defaulting it outright would hand a cursor/opencode/github-copilot host a
 * payload it does not recognise — fail-open again by another route — hence the raw recovery.
 */
function recoveredHookTarget(argv: string[]): TargetId {
  const value = optionValue(argv, '--target');
  /* Last resort only. codex and claude render an identical deny, so this single fallback covers
     both; every other target is reached through the recovery above, since the installed hook
     command always passes `--target` (see adapters/governance.ts). */
  return TARGETS.includes(value as TargetId) ? value as TargetId : 'claude';
}

function recoveredHookEvent(argv: string[]): string {
  const value = optionValue(argv, '--event');
  /* Only an explicitly non-blocking `*.after` event is taken at face value. Anything else —
     missing, misspelled, or truncated — is treated as blocking, so the failure denies rather than
     silently downgrading to the exit-0 after-event path. */
  return value?.includes('after') ? value : 'agent.tool.before';
}

const HELP: Record<CommandName, { usage: string; description: string; options: string[] }> = {
  help: { usage: 'xforge help [command] [--text]', description: 'Show general or command-specific help.', options: ['--text'] },
  version: { usage: 'xforge version [--text]', description: 'Show CLI, protocol, runtime, and build identity.', options: ['--text'] },
  init: { usage: 'xforge [--root <path>] init [--language <en|zh-CN>] [--target <target>] [--dry-run] [--text]', description: 'Initialize the bundled npm Scaffold and optionally project it into one Agent tool.', options: ['--root', '--language', '--target', '--dry-run', '--text'] },
  state: { usage: 'xforge [--root <path>] state [--change <id>] [--kind <kind>] [--target <target>] [--text] [--field <path>]', description: 'Read resolved project and Change state. --field prints one value and nothing else, addressed as a dotted path through data (for example change.governance.revision.contentRevision, or change.governance.readyTransitions.0.to — both need --change). Use it instead of grepping the JSON: several governance fields repeat under every historical receipt, so a line-oriented match returns whichever came first rather than the current one.', options: ['--root', '--change', '--kind', '--target', '--text', '--field'] },
  install: { usage: 'xforge [--root <path>] install [--target <target>] [--adopt] [--dry-run] [--text]', description: 'Install or idempotently reconcile selected project assets.', options: ['--root', '--target', '--adopt', '--dry-run', '--text'] },
  sync: { usage: 'xforge [--root <path>] sync [--target <target>] [--adopt] [--dry-run] [--verify-digests] [--text]', description: 'Incrementally sync localized Scaffold changes to installed targets.', options: ['--root', '--target', '--adopt', '--dry-run', '--verify-digests', '--text'] },
  update: { usage: 'xforge [--root <path>] update [--target <target>] [--adopt] [--dry-run] [--text]', description: 'Fully reconcile installed targets, identities, and Adapter output.', options: ['--root', '--target', '--adopt', '--dry-run', '--text'] },
  uninstall: { usage: 'xforge [--root <path>] uninstall [--target <target>] [--force] [--dry-run] [--text]', description: 'Remove managed target files, refusing on a digest mismatch unless --force.', options: ['--root', '--target', '--force', '--dry-run', '--text'] },
  check: { usage: 'xforge [--root <path>] check [--change <id>] [--gate <id>] [--stage <id> | --all-gates] [--force] [--text]', description: 'Validate project structure, deliveries, and the Gates the current Stage requires. With no Gate selection this also executes the verify commands declared by every work package, which for a large plan is dozens of external commands and minutes of wall time; narrowing with --gate, --stage or --all-gates runs only the selected Gates and skips them.', options: ['--root', '--change', '--gate', '--stage', '--all-gates', '--force', '--text'] },
  verification: {
    usage: 'xforge [--root <path>] verification declare --gate-name <gate> (--command \'["prog","arg"]\' | --not-applicable <marker> --justification <text>) --by <person> [--module <id>] [--covers \'["marker"]\'] [--working-directory <path>] [--timeout-seconds <n>] [--dry-run] [--text]\n       xforge [--root <path>] verification retire --gate-name <gate> (--command \'["prog","arg"]\' | --not-applicable <marker>) --by <person> --reason <text> [--module <id>] [--dry-run] [--text]\n       xforge [--root <path>] verification draft-receipt --change <id> [--text]',
    description: 'Declare how this project runs a declared-verification Gate, without hand-editing the Manifest; retire a declaration that should stop running, keeping the record of who withdrew it and why; or draft the current Stage\'s verification receipt from what XForge already knows. The draft omits `status` and writes nothing: that field is the Stage\'s assertion that the work was verified, and a CLI filling it in would be deciding the thing the receipt exists to record.',
    options: ['--root', '--change', '--gate-name', '--command', '--module', '--covers', '--working-directory', '--timeout-seconds', '--not-applicable', '--justification', '--by', '--reason', '--dry-run', '--text'],
  },
  findings: {
    usage: 'xforge [--root <path>] findings resolve --change <id> --id <finding-id> --answer <text> --by <person> [--dry-run] [--text]',
    description: 'Record a person\'s answer to one Check finding and mark it resolved. Only this one transition: findings are written by the Check Stage, and this closes an entry that already exists. --by is checked against the approvers and Git authors this Change records, so a decision-maker can be cited but not invented.',
    options: ['--root', '--change', '--id', '--answer', '--by', '--dry-run', '--text'],
  },
  brief: { usage: 'xforge [--root <path>] brief --change <id> [--attach-triage <path>] [--text] [--compact]', description: 'Report what a human approval at this Stage turns on, separating computed facts from quoted Artifact text. --compact folds the EXTRACTED block in the text form, listing each quote\'s heading and source line instead of its text; the JSON is unchanged either way.', options: ['--root', '--change', '--attach-triage', '--text', '--compact'] },
  transition: { usage: 'xforge [--root <path>] transition --change <id> --to <stage> [--dry-run] [--text]\n       xforge [--root <path>] transition repair --change <id> --receipt <receiptId> [--dry-run] [--text]', description: 'Evaluate and record a governed Stage transition, or repair the receipt chain by dropping one leaf receipt. Repair is not a --force: it discards a recorded transition, reverting the Change to the Stage that transition left, and records what it discarded in the audit chain. Only a leaf may go — a receipt some later receipt chains to is load-bearing and is refused.', options: ['--root', '--change', '--to', '--receipt', '--dry-run', '--text'] },
  approve: { usage: 'xforge [--root <path>] approve --change <id> --for <transition-id|archive> [--policy <id>] [--provider <mcp-provider-id> | local fields] [--dry-run] [--text]', description: 'Record an interactive human approval at the terminal, or submit/poll an mcp provider. There is no other approval mechanism. --for takes the id of the transition the approval unlocks (the value xforge state reports in nextActions[].command), not a literal word.', options: ['--root', '--change', '--for', '--policy', '--actor', '--role', '--reason', '--decision', '--attestation', '--provider', '--dry-run', '--text'] },
  audit: { usage: 'xforge [--root <path>] audit <status|verify|export|retry|prune> [--change <id>] [--output <path>] [--text]', description: 'Inspect, verify, export, redeliver, or prune the append-only audit chain.', options: ['--root', '--change', '--output', '--text'] },
  'work-package': { usage: 'xforge [--root <path>] work-package <dispatch|draft|acknowledge> --change <id> --package <id> [--as <integrator|reviewer> --evidence <path> [--scope <text>]] [--dry-run] [--text]', description: 'Dispatch a work package, draft its delivery record from what XForge already knows, or acknowledge integration/review evidence. --scope records what the acknowledgement actually covered, in the acknowledger\'s own words; it is optional and never inferred, so an absent scope means nobody said.', options: ['--root', '--change', '--package', '--as', '--evidence', '--scope', '--dry-run', '--text'] },
  hook: { usage: 'xforge hook dispatch --target <target> --event <event>', description: 'Internal platform Hook dispatcher.', options: ['--root', '--target', '--event'] },
  archive: { usage: 'xforge [--root <path>] archive --change <id> [--dry-run] [--text]', description: 'Verify, merge Specs, and atomically archive a Change.', options: ['--root', '--change', '--dry-run', '--text'] },
  'upgrade-scaffold': {
    usage: 'xforge [--root <path>] upgrade-scaffold [--complete | --rollback] [--with-active-changes] [--force] [--dry-run] [--text]',
    description: 'Stage the Scaffold this CLI ships beside the project\'s own and classify every file, so a person or an Agent can merge it.',
    options: ['--root', '--complete', '--rollback', '--with-active-changes', '--force', '--dry-run', '--text'],
  },
  review: {
    usage: 'xforge [--root <path>] review acknowledge --change <id> --evidence <path> [--scope <text>] [--dry-run] [--text]',
    description: "Record that this Change's delivered work was reviewed, for Changes delivered without a work-package plan. The per-package form is `work-package acknowledge --as reviewer`, and this is refused when a plan exists. There is no --by: the actor comes from the environment, because a field inviting a reviewer's name invites a fabricated one.",
    options: ['--root', '--change', '--evidence', '--scope', '--dry-run', '--text'],
  },
  doctor: { usage: 'xforge [--root <path>] doctor [--kind <kind>] [--strict] [--text]', description: 'Report unreferenced and dangling Flow/Skill/Rule/Gate/Hook/PermissionPolicy/Approval/McpServer extensions.', options: ['--root', '--kind', '--strict', '--text'] },
};

function parseArguments(argv: string[]): ParsedArguments {
  const parsed: ParsedArguments = { command: '', text: false, dryRun: false, verifyDigests: false, strict: false, allGates: false, force: false, adopt: false, complete: false, rollback: false, withActiveChanges: false, compact: false };
  const seen = new Set<string>();
  const positionals: string[] = [];
  let helpShortcut = false;
  let versionShortcut = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    if (seen.has(token)) throw new XForgeError(diagnostic('XFORGE_ARGUMENT_DUPLICATE', `Duplicate option: ${token}`));
    seen.add(token);
    if (token === '--help') { helpShortcut = true; continue; }
    if (token === '--version') { versionShortcut = true; continue; }
    if (token === '--text') { parsed.text = true; continue; }
    if (token === '--dry-run') { parsed.dryRun = true; continue; }
    if (token === '--verify-digests') { parsed.verifyDigests = true; continue; }
    if (token === '--strict') { parsed.strict = true; continue; }
    if (token === '--complete') { parsed.complete = true; continue; }
    if (token === '--rollback') { parsed.rollback = true; continue; }
    if (token === '--with-active-changes') { parsed.withActiveChanges = true; continue; }
    if (token === '--all-gates') { parsed.allGates = true; continue; }
    if (token === '--compact') { parsed.compact = true; continue; }
    if (token === '--force') { parsed.force = true; continue; }
    if (token === '--adopt') { parsed.adopt = true; continue; }
    if (!isValueOption(token)) {
      throw new XForgeError(diagnostic('XFORGE_OPTION_UNKNOWN', `Unknown option: ${token}`));
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new XForgeError(diagnostic('XFORGE_OPTION_VALUE_MISSING', `Option requires a value: ${token}`));
    index += 1;
    if (token === '--root') parsed.root = value;
    if (token === '--change') parsed.change = value;
    if (token === '--gate') parsed.gate = value;
    if (token === '--to') parsed.to = value;
    if (token === '--for') parsed.transition = value;
    if (token === '--policy') parsed.policy = value;
    if (token === '--actor') parsed.actor = value;
    if (token === '--role') parsed.role = value;
    if (token === '--reason') parsed.reason = value;
    if (token === '--provider') parsed.provider = value;
    if (token === '--output') parsed.output = value;
    if (token === '--event') parsed.event = value;
    if (token === '--package') parsed.packageId = value;
    if (token === '--language') parsed.language = parseScaffoldLanguage(value);
    if (token === '--evidence') parsed.evidence = value;
    if (token === '--stage') parsed.stage = value;
    if (token === '--gate-name') parsed.gateName = value;
    if (token === '--command') parsed.commandArgv = value;
    if (token === '--module') parsed.module = value;
    if (token === '--covers') parsed.covers = value;
    if (token === '--receipt') parsed.receiptId = value;
    if (token === '--field') parsed.field = value;
    if (token === '--working-directory') parsed.workingDirectory = value;
    if (token === '--timeout-seconds') parsed.timeoutSeconds = value;
    if (token === '--not-applicable') parsed.notApplicable = value;
    if (token === '--justification') parsed.justification = value;
    if (token === '--id') parsed.findingId = value;
    if (token === '--answer') parsed.answer = value;
    if (token === '--scope') parsed.scope = value;
    if (token === '--by') parsed.by = value;
    if (token === '--attach-triage') parsed.attachTriage = value;
    if (token === '--as') {
      if (!['integrator', 'reviewer'].includes(value)) throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_ROLE_UNKNOWN', `Unknown acknowledgement role: ${value}`));
      parsed.acknowledgeAs = value as ParsedArguments['acknowledgeAs'];
    }
    if (token === '--decision') {
      if (!['approve', 'reject'].includes(value)) throw new XForgeError(diagnostic('XFORGE_DECISION_UNKNOWN', `Unknown approval decision: ${value}`));
      parsed.decision = value as ParsedArguments['decision'];
    }
    if (token === '--attestation') {
      if (value !== 'human') throw new XForgeError(diagnostic('XFORGE_ATTESTATION_UNKNOWN', `Unknown attestation: ${value}`));
      parsed.attestation = 'human';
    }
    if (token === '--kind') {
      /*
       * The kinds are plural, and the Skills that tell an Agent to run this say `--kind <resource>`,
       * which invites the singular. A live run typed `--kind skill`, got "Unknown resource kind" with
       * no list of what would have worked, and abandoned the flag. Accepting the singular costs
       * nothing and removes the whole class; the message now names the alternatives either way.
       */
      const canonical = VALID_KINDS.find((kind) => kind === value || kind === `${value}s`);
      if (!canonical) {
        throw new XForgeError(diagnostic('XFORGE_KIND_UNKNOWN', `Unknown resource kind: ${value}. Valid kinds are ${VALID_KINDS.join(', ')}.`));
      }
      parsed.kind = canonical as ParsedArguments['kind'];
    }
    if (token === '--target') {
      if (!TARGETS.includes(value as TargetId)) throw new XForgeError(diagnostic('XFORGE_TARGET_UNKNOWN', `Unknown target: ${value}`));
      parsed.target = value as TargetId;
    }
  }

  if (helpShortcut && versionShortcut) throw new XForgeError(diagnostic('XFORGE_OPTION_NOT_ALLOWED', '--help and --version cannot be combined.'));
  if (helpShortcut) {
    if (positionals.length > 1) throw new XForgeError(diagnostic('XFORGE_ARGUMENT_UNEXPECTED', `Unexpected positional argument: ${positionals[1]}`));
    parsed.command = 'help';
    parsed.helpCommand = positionals[0];
    parsed.text = true;
  } else if (versionShortcut) {
    if (positionals.length > 0) throw new XForgeError(diagnostic('XFORGE_ARGUMENT_UNEXPECTED', `Unexpected positional argument: ${positionals[0]}`));
    parsed.command = 'version';
    parsed.text = true;
  } else if (positionals.length === 0 && seen.size === 0) {
    /*
     * A bare `xforge` used to answer with a JSON envelope whose only content was
     * XFORGE_COMMAND_REQUIRED — a machine-readable way of saying "read the help", to somebody who
     * had just demonstrated they were looking for it. Typing the name of a tool is how a person
     * asks what it does, so it prints the help the same way `xforge help` does.
     *
     * Only when nothing else was given: `xforge --text` or `xforge --root x` are malformed
     * invocations rather than requests for help, and still fail so a script cannot mistake one for
     * a successful run.
     */
    parsed.command = 'help';
    parsed.text = true;
  } else {
    parsed.command = positionals[0] ?? '';
    if (parsed.command === 'help') {
      parsed.helpCommand = positionals[1];
      if (positionals.length > 2) throw new XForgeError(diagnostic('XFORGE_ARGUMENT_UNEXPECTED', `Unexpected positional argument: ${positionals[2]}`));
    } else if (parsed.command === 'audit' || parsed.command === 'hook' || parsed.command === 'work-package' || parsed.command === 'verification' || parsed.command === 'transition' || parsed.command === 'review' || parsed.command === 'findings') {
      /* `transition` joined this list without breaking its original form, because that form carries
         no positional: `transition --change X --to Y` leaves positionals[1] undefined, which is
         exactly what the plain-transition branch below tests for. */
      parsed.subcommand = positionals[1];
      if (positionals.length > 2) throw new XForgeError(diagnostic('XFORGE_ARGUMENT_UNEXPECTED', `Unexpected positional argument: ${positionals[2]}`));
    } else if (positionals.length > 1) {
      throw new XForgeError(diagnostic('XFORGE_ARGUMENT_UNEXPECTED', `Unexpected positional argument: ${positionals[1]}`));
    }
  }

  if (!COMMANDS.includes(parsed.command as CommandName)) {
    throw new XForgeError(diagnostic(
      parsed.command ? 'XFORGE_COMMAND_UNKNOWN' : 'XFORGE_COMMAND_REQUIRED',
      parsed.command ? `Unknown command: ${parsed.command}. Run xforge help for supported commands.` : 'A command is required. Run xforge help for supported commands.',
    ));
  }

  const allowed = new Set(HELP[parsed.command as CommandName].options);
  for (const flag of seen) {
    if (flag === '--help' || flag === '--version') continue;
    if (!allowed.has(flag)) throw new XForgeError(diagnostic('XFORGE_OPTION_NOT_ALLOWED', `${flag} is not valid for ${parsed.command}.`));
  }
  if (parsed.command === 'archive' && !parsed.change) throw new XForgeError(diagnostic('XFORGE_CHANGE_REQUIRED', 'archive requires --change <id>.'));
  if (parsed.command === 'verification') {
    if (!['declare', 'retire', 'draft-receipt'].includes(parsed.subcommand ?? '')) throw new XForgeError(diagnostic('XFORGE_VERIFICATION_ACTION_REQUIRED', 'verification requires the declare, retire or draft-receipt action.'));
    if (parsed.subcommand === 'retire' && (!parsed.gateName || !parsed.by || !parsed.reason)) {
      throw new XForgeError(diagnostic(
        'XFORGE_VERIFICATION_ARGUMENTS_REQUIRED',
        'verification retire requires --gate-name <gate>, --by <person> and --reason <text>. The person and the reason are required for the same reason they are on declare: nothing can decide mechanically whether a check is still worth running, so withdrawing one is a judgement that has to carry a name.',
      ));
    }
    if (parsed.subcommand === 'declare' && (!parsed.gateName || !parsed.by)) throw new XForgeError(diagnostic('XFORGE_VERIFICATION_ARGUMENTS_REQUIRED', 'verification declare requires --gate-name <gate> and --by <person>. The person is required because nothing can decide mechanically whether a command verifies anything; this records who answered.'));
    if (parsed.subcommand === 'draft-receipt' && !parsed.change) throw new XForgeError(diagnostic('XFORGE_CHANGE_REQUIRED', 'verification draft-receipt requires --change <id>.'));
  }
  if (parsed.command === 'findings') {
    if (parsed.subcommand !== 'resolve') throw new XForgeError(diagnostic('XFORGE_FINDINGS_ACTION_REQUIRED', 'findings requires the resolve action. It closes one existing entry; writing findings stays the Check Stage\'s job.'));
    if (!parsed.change || !parsed.findingId || !parsed.answer || !parsed.by) {
      throw new XForgeError(diagnostic(
        'XFORGE_FINDINGS_ARGUMENTS_REQUIRED',
        'findings resolve requires --change <id>, --id <finding-id>, --answer <what was decided> and --by <the person who decided>. The answer and the person are required for the same reason the entry exists: it was pointed at somebody, and a status flag on its own records neither what they said nor who they were.',
      ));
    }
  }
  if (parsed.command === 'review') {
    if (parsed.subcommand !== 'acknowledge') throw new XForgeError(diagnostic('XFORGE_REVIEW_ACTION_REQUIRED', 'review requires the acknowledge action.'));
    if (!parsed.change || !parsed.evidence) throw new XForgeError(diagnostic('XFORGE_REVIEW_ARGUMENTS_REQUIRED', 'review acknowledge requires --change <id> and --evidence <path>.'));
  }
  if (parsed.command === 'brief' && !parsed.change) throw new XForgeError(diagnostic('XFORGE_CHANGE_REQUIRED', 'brief requires --change <id>.'));
  /* Refused rather than ignored: --compact folds a block of the *text* form, so on its own it looks
     like it did something to a JSON envelope that is byte for byte what it always was. */
  if (parsed.compact && !parsed.text) throw new XForgeError(diagnostic('XFORGE_OPTION_NOT_ALLOWED', '--compact only affects the --text form; the JSON envelope always carries every entry. Add --text, or drop --compact.'));
  if (parsed.command === 'transition') {
    if (parsed.subcommand !== undefined && parsed.subcommand !== 'repair') {
      throw new XForgeError(diagnostic('XFORGE_TRANSITION_ACTION_UNKNOWN', `transition takes no action word, or the repair action; got ${parsed.subcommand}.`));
    }
    if (parsed.subcommand === 'repair') {
      if (!parsed.change || !parsed.receiptId) {
        throw new XForgeError(diagnostic('XFORGE_TRANSITION_REPAIR_ARGUMENTS_REQUIRED', 'transition repair requires --change <id> and --receipt <receiptId>. It drops one leaf Transition receipt, named explicitly, because choosing which recorded history to discard is a judgement no default can make.'));
      }
      if (parsed.to) throw new XForgeError(diagnostic('XFORGE_OPTION_NOT_ALLOWED', '--to is not valid for transition repair: a repair discards a recorded transition, it does not perform one.'));
    } else if (!parsed.change || !parsed.to) {
      throw new XForgeError(diagnostic('XFORGE_TRANSITION_ARGUMENTS_REQUIRED', 'transition requires --change <id> and --to <stage>.'));
    }
  }
  if (parsed.command === 'approve' && (!parsed.change || !parsed.transition)) {
    /* Naming what is missing and what was accepted, separately. The old message listed both
       required options whichever one was absent, so somebody who had passed a perfectly valid
       `--policy` had no way to tell whether that was the rejected part without reading the help. */
    const missing = [!parsed.change ? '--change <id>' : null, !parsed.transition ? '--for <transition-id|archive>' : null].filter(Boolean);
    const given = [parsed.change ? '--change' : null, parsed.transition ? '--for' : null, parsed.policy ? '--policy' : null, parsed.provider ? '--provider' : null].filter(Boolean);
    throw new XForgeError(diagnostic(
      'XFORGE_APPROVAL_ARGUMENTS_REQUIRED',
      `approve is missing ${missing.join(' and ')}.${given.length ? ` What you gave is accepted: ${given.join(', ')}.` : ''}`,
    ));
  }
  if (parsed.command === 'audit' && !['status', 'verify', 'export', 'retry', 'prune'].includes(parsed.subcommand ?? '')) throw new XForgeError(diagnostic('XFORGE_AUDIT_ACTION_REQUIRED', 'audit requires status, verify, export, retry, or prune.'));
  if (parsed.command === 'audit' && parsed.output && parsed.subcommand !== 'export') throw new XForgeError(diagnostic('XFORGE_OPTION_NOT_ALLOWED', '--output is only valid for audit export.'));
  if (parsed.command === 'hook' && (parsed.subcommand !== 'dispatch' || !parsed.target || !parsed.event)) throw new XForgeError(diagnostic('XFORGE_HOOK_ARGUMENTS_REQUIRED', 'hook dispatch requires --target and --event.'));
  if (parsed.command === 'work-package') {
    if (!parsed.change || !parsed.packageId || !['dispatch', 'draft', 'acknowledge'].includes(parsed.subcommand ?? '')) {
      throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_ARGUMENTS_REQUIRED', 'work-package requires dispatch, draft, or acknowledge, plus --change and --package.'));
    }
    if (parsed.subcommand === 'acknowledge' && (!parsed.acknowledgeAs || !parsed.evidence)) {
      throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_ACK_ARGUMENTS_REQUIRED', 'work-package acknowledge requires --as <integrator|reviewer> and --evidence <path>.'));
    }
    if (parsed.subcommand !== 'acknowledge' && (parsed.acknowledgeAs || parsed.evidence || parsed.scope)) {
      throw new XForgeError(diagnostic('XFORGE_OPTION_NOT_ALLOWED', '--as, --evidence and --scope are only valid for work-package acknowledge.'));
    }
  }
  return parsed;
}

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

function helpEnvelope(subject?: string): Envelope {
  if (subject && !COMMANDS.includes(subject as CommandName)) {
    throw new XForgeError(diagnostic('XFORGE_HELP_COMMAND_UNKNOWN', `Unknown help command: ${subject}`));
  }
  const commandHelp = subject ? HELP[subject as CommandName] : null;
  return envelope({
    command: 'help',
    root: null,
    data: {
      usage: 'xforge [--root <path>] <command> [options] [--text]',
      commands: Object.fromEntries(COMMANDS.map((command) => [command, HELP[command].description])),
      globalOptions: { '--root <path>': 'Use an exact project root.', '--text': 'Present the same result as readable text.' },
      commandHelp,
    },
  });
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

/** A Flow Stage exactly as `readState` summarises it (see core/state-reader.ts). */
interface StageSummary {
  id: string;
  authority?: FlowAuthority;
  produces?: string[];
}

/**
 * The Stages of the Flow the selected Change is running, taken from the state read that was just
 * performed rather than re-resolved.
 *
 * `nextActions` used to stamp a hardcoded `authority` on the Actions it emits, which made
 * `create-artifact` announce `planning-write` for every Artifact — including the ones whose Stage
 * declares `assurance-write`. Nothing in XForge compares an authority against an operation today, so
 * a hardcoded value cannot restrict anything; all it can do is misinform a reader who believes it,
 * and the Skill text does tell the Agent to match on it. The value therefore comes from the Flow
 * Stage that actually produces the Artifact, or is omitted when no Stage answers for the Action.
 */
function flowStages(data: Record<string, unknown>, flowId: string | undefined): StageSummary[] {
  const flows = (data.flows ?? []) as Array<{ id?: string; stages?: StageSummary[] | null }>;
  return flows.find((flow) => flow.id === flowId)?.stages ?? [];
}

async function dispatch(parsed: ParsedArguments): Promise<Envelope> {
  if (parsed.command === 'help') return helpEnvelope(parsed.helpCommand);
  if (parsed.command === 'version') return versionEnvelope();

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
  if (command === 'state') {
    const result = await executeState(project, { change: parsed.change, kind: parsed.kind, target: parsed.target });
    const nextActions: NextAction[] = [];
    if (project.compatibility.mode === 'portable') nextActions.push({ action: 'resolve-declared-xforge', reason: 'Managed operations require the exact declared CLI identity.' });
    const stateChange = (result.data.change ?? null) as {
      flow?: string;
      nextArtifact?: { id?: string; outputPaths?: string[]; writePath?: string; missingDependencies?: string[]; outline?: string; generates?: string } | null;
      workPackages?: { packages?: Array<{ id: string; inputs: string[]; write_paths: string[]; done_when: string[] }> } | null;
    } | null;
    const stages = flowStages(result.data, stateChange?.flow);
    if (stateChange?.nextArtifact?.id && parsed.change) {
      const artifactId = stateChange.nextArtifact.id;
      /* From the Stage that produces this Artifact, never a constant: a Flow is free to produce a
         check-stage Artifact under assurance-write. A Flow that declares no producing Stage for it
         leaves the field off rather than inventing a level. */
      const authority = stages.find((stage) => (stage.produces ?? []).includes(artifactId))?.authority;
      /* A glob Artifact's outline is a repeating template, not a section set, so it has no literal
         headings to state. `outlineSections` returns none for one either way; the check keeps the
         intent visible. */
      const sections = stateChange.nextArtifact.generates?.includes('*')
        ? []
        : outlineSections(stateChange.nextArtifact.outline ?? '');
      nextActions.push({
        action: 'create-artifact',
        type: 'artifact',
        id: artifactId,
        actor: 'main',
        ...(authority ? { authority } : {}),
        status: 'ready',
        inputs: stateChange.nextArtifact.missingDependencies ?? [],
        /* A not-yet-written Artifact has no outputPaths, which used to leave `writes` empty and the
           destination for the Agent to guess. State the project-relative path instead. */
        writes: stateChange.nextArtifact.outputPaths?.length
          ? stateChange.nextArtifact.outputPaths
          : [stateChange.nextArtifact.writePath].filter((item): item is string => Boolean(item)),
        /* The headings verbatim, so the author is not left inferring them from a Markdown fragment.
           Omitted for a glob Artifact, whose outline is a repeating template rather than a section
           set, and when the Flow declares none. */
        ...(sections.length > 0 ? { requiredSections: sections } : {}),
        doneWhen: [`Artifact ${artifactId} exists and satisfies the active Flow instructions.`],
        requiredEvidence: ['xforge state reports the artifact as done for the current Change revision.'],
        reason: `Next Flow Artifact is ${artifactId}.`,
      });
    }
    const governance = (stateChange as any)?.governance;
    if (governance?.currentStage === 'apply') {
      /* The dispatch happens in the Stage the Change is in, so that Stage's declared authority is
         the one that applies — `implementation-write` only because the shipped Flows say so. */
      const applyAuthority = stages.find((stage) => stage.id === governance.currentStage)?.authority;
      for (const packageId of (stateChange as any)?.workPackages?.ready ?? []) {
        const workPackage = stateChange?.workPackages?.packages?.find((item) => item.id === packageId);
        nextActions.push({
          action: 'dispatch-work-package', type: 'governance', id: packageId, actor: 'main', ...(applyAuthority ? { authority: applyAuthority } : {}), status: 'ready',
          inputs: workPackage?.inputs ?? [], writes: workPackage?.write_paths ?? [], doneWhen: workPackage?.done_when ?? [],
          requiredEvidence: ['revision-bound dispatch receipt', 'Git delivery diff', 'verify command evidence', 'done_when evidence mapping'],
          reworkTo: ['apply'],
          reason: `Work package ${packageId} is ready for a revision-bound dispatch.`,
          command: ['xforge', 'work-package', 'dispatch', '--change', parsed.change!, '--package', packageId],
        });
      }
    }
    for (const pending of governance?.pendingApprovals ?? []) nextActions.push({
      action: 'approve', type: 'approval', id: pending.policyId, actor: 'human', status: 'pending',
      inputs: ['current state revision', `approval policy ${pending.policyId}`], writes: ['approval receipt'],
      doneWhen: [`Approval policy ${pending.policyId} is satisfied for ${pending.transition}.`], requiredEvidence: ['current-revision approval receipt'],
      reason: `Approval ${pending.policyId} is required for ${pending.transition}.`, blockedBy: [`missing:${pending.missing}`],
      command: ['xforge', 'approve', '--change', parsed.change!, '--for', pending.transition, '--policy', pending.policyId],
    });
    for (const transition of governance?.readyTransitions ?? []) nextActions.push({
      action: 'transition', type: 'transition', id: transition.to, actor: 'main', status: transition.ready ? 'ready' : 'blocked',
      inputs: ['current Change state', 'required gates and approvals'], writes: ['transition receipt'],
      doneWhen: [`Current Stage is ${transition.to}.`], requiredEvidence: ['valid transition receipt'], reworkTo: governance?.currentStage ? [governance.currentStage] : [],
      reason: transition.ready ? `Transition to ${transition.to} is ready.` : `Transition to ${transition.to} is blocked.`, blockedBy: transition.blockedBy,
      command: ['xforge', 'transition', '--change', parsed.change!, '--to', transition.to],
    });
    /* `ready-to-archive` is a synthetic terminal Stage, not one of `flow.stages`, so there is no
       Stage to read here. The archive authority comes from `flow.terminal.archive.authority`, which
       flow.schema.json pins to the const `archive-write` — this literal is the schema's only legal
       value for it, not a level invented at this call site. */
    if (governance?.currentStage === 'ready-to-archive') nextActions.push({
      action: 'archive', type: 'archive', actor: 'main', authority: 'archive-write', status: (governance.pendingApprovals ?? []).some((item: any) => item.transition === 'archive') ? 'blocked' : 'ready',
      inputs: ['current-revision verification, approval, gate, and audit evidence'], writes: ['canonical Specs', 'archived Change'],
      doneWhen: ['The Change is archived atomically and canonical Specs are synchronized.'], requiredEvidence: ['archive transaction result'],
      reason: 'The Change reached ReadyToArchive; terminal governance still applies.', command: ['xforge', 'archive', '--change', parsed.change!],
    });
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
    const result = await executeCheck(project, { change: parsed.change, gate: parsed.gate, stage: parsed.stage, allGates: parsed.allGates, force: parsed.force });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'verification') {
    if (parsed.subcommand === 'draft-receipt') {
      const result = await executeVerificationDraftReceipt(project, { change: parsed.change! });
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
      mode, dryRun: parsed.dryRun, force: parsed.force, withActiveChanges: parsed.withActiveChanges,
    });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'findings') {
    const result = await executeFindingsResolve(project, {
      change: parsed.change!, id: parsed.findingId!, answer: parsed.answer!, by: parsed.by!, dryRun: parsed.dryRun,
    });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'brief') {
    const result = await executeBrief(project, { change: parsed.change!, attachTriage: parsed.attachTriage });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'review') {
    const result = await executeReviewAcknowledge(project, { change: parsed.change!, evidence: parsed.evidence!, scope: parsed.scope, dryRun: parsed.dryRun });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'transition') {
    if (parsed.subcommand === 'repair') {
      const result = await repairTransitionChain(project, { change: parsed.change!, receiptId: parsed.receiptId!, dryRun: parsed.dryRun });
      return envelope({ command, root: project.root, ...result });
    }
    const result = await executeTransition(project, { change: parsed.change!, to: parsed.to!, dryRun: parsed.dryRun });
    return envelope({ command, root: project.root, ...result });
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
      const result = await executeWorkPackageDispatch(project, { change: parsed.change!, packageId: parsed.packageId!, dryRun: parsed.dryRun });
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
      process.stdout.write(`${JSON.stringify((result.data as any)?.platformOutput ?? {})}\n`);
      return 0;
    }
    const target = parsed?.target ?? recoveredHookTarget(argv);
    const event = parsed?.event ?? recoveredHookEvent(argv);
    /* The deny is all the host renders, so the diagnostic's own message — which names the file at
       fault and the command that fixes it — has to ride along. Dropping it is what turns a
       one-command configuration problem into "every tool call is refused and nobody knows why". */
    const reason = result.diagnostics.find((item) => item.severity === 'error')?.message
      ?? result.diagnostics[0]?.message;
    process.stdout.write(`${JSON.stringify(hookFailureOutput(target, event, reason))}\n`);
    return event.includes('after') ? 0 : 2;
  }
  const textMode = parsed?.text ?? argv.some((item) => ['--text', '--help', '--version'].includes(item));
  /* Only a successful brief renders: a failed one has `data: null` and its diagnostics are the
     result, which the standard text form already prints. */
  let render: ((data: unknown) => string) | undefined;
  if (parsed?.command === 'brief' && result.ok) {
    render = (data: unknown) => renderBriefText(data as Parameters<typeof renderBriefText>[0], { compact: parsed.compact });
  } else if (parsed?.command === 'state' && result.ok) {
    /* `state`'s `data` is the entire resolved project; printed as JSON it buries the envelope's own
       `Next actions:` block under tens of thousands of characters. See `renderStateText`. */
    render = (data: unknown) => renderStateText(data);
  } else if (parsed?.command === 'upgrade-scaffold' && result.ok) {
    /* The plan is the whole output of a staged upgrade, and a wall of JSON is not a thing anyone
       reads before deciding what to merge. */
    render = (data: unknown) => renderUpgradeText({ data: data as Record<string, unknown>, diagnostics: [], changes: [] });
  }
  /*
   * `--field` prints one value and nothing else, so `$(xforge state --field ...)` is safe.
   *
   * The alternative people actually used was `grep` over the JSON, and it silently returned the
   * wrong answer: `contentRevision` appears once per historical receipt in `xforge state`, so
   * `grep -m1` reported an old revision as the current one and a live run hand-wrote a receipt
   * against it. A miss therefore fails loudly rather than printing an empty line — an empty
   * capture that looks like a value is the failure mode this exists to remove.
   */
  if (parsed?.field && result.ok) {
    const resolved = resolveField(result.data, parsed.field);
    if (!resolved.found) {
      process.stdout.write(present({
        ...result, ok: false,
        diagnostics: [...result.diagnostics, diagnostic(
          'XFORGE_FIELD_NOT_FOUND',
          /* `--text` no longer prints `data` verbatim for every command, so the advice names both
             flags: the shape lives in the JSON envelope, which is what dropping them returns. */
          `No value at --field ${parsed.field}. ${resolved.reason} Run the command without --field and without --text to see the shape of data.`,
        )],
      }, textMode, render));
      return 1;
    }
    const value = resolved.value;
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
