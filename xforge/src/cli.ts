#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { access, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { safeResolve } from './core/path-safety.js';
import { CLI_NAME, CLI_VERSION, PROTOCOL_VERSION, TARGETS, type TargetId } from './constants.js';
import { executeArchive } from './commands/archive.js';
import { executeApprove, type ApprovalTerminal } from './commands/approve.js';
import { executeAudit } from './commands/audit.js';
import { executeCheck } from './commands/check.js';
import { executeStageBundle, renderStageBundleText, renderStageText } from './commands/stage-bundle.js';
import { CLASSIFICATION_KEYS, changeTemplate } from './core/change-template.js';
import { WORK_PACKAGE_PLAN_HEADER_KEYS, workPackagePlanTemplate } from './core/work-package-template.js';
import { knownIdentities } from './core/ledger-identity.js';
import { executeContractList, executeContractStatus, renderContractListText, renderContractStatusText } from './commands/contract.js';
import { executeExplain, renderExplainText } from './commands/explain.js';
import { executeFindingsResolve } from './commands/findings.js';
import { executeVerificationDeclare, executeVerificationDraftReceipt, executeVerificationFinalize, executeVerificationRetire } from './commands/verification.js';
import { executeInstall } from './commands/install.js';
import { executeState, renderStateText } from './commands/state.js';
import { STATE_SECTIONS, type StateSection } from './core/state-reader.js';
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
import type { Diagnostic, Envelope, FileChange, FlowAuthority, NextAction, ProjectContext, ScaffoldLanguage } from './types.js';

type CommandName = 'help' | 'version' | 'init' | 'state' | 'install' | 'sync' | 'update' | 'uninstall' | 'check' | 'stage' | 'advance' | 'stage-bundle' | 'explain' | 'verification' | 'transition' | 'approve' | 'audit' | 'work-package' | 'hook' | 'archive' | 'doctor' | 'upgrade-scaffold' | 'review' | 'findings' | 'contract';

interface ParsedArguments {
  command: string;
  text: boolean;
  dryRun: boolean;
  commit?: boolean;
  verifyDigests: boolean;
  strict: boolean;
  allGates: boolean;
  force: boolean;
  adopt: boolean;
  complete: boolean;
  rollback: boolean;
  withActiveChanges: boolean;
  allowDirty: boolean;
  root?: string;
  stage?: string;
  helpCommand?: string;
  explainCode?: string;
  /** The leaf a group's help was asked for, reported so the answer names what was asked. */
  helpSubcommand?: string;
  subcommand?: string;
  change?: string;
  kind?: 'skills' | 'agents' | 'rules' | 'policies' | 'hooks' | 'gates' | 'scripts' | 'mcp-servers';
  /** `contract list --kind`: a contract dialect, which is an open set and not the one above. */
  contractKind?: string;
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
  /** How much of a working set arrives as text. An intent, not a field list. */
  content?: string;
  /** How much of each Gate's Evidence `check` returns inline. */
  evidenceDetail?: string;
  by?: string;
  status?: string;
  receiptId?: string;
  field?: string;
  /* Every `--field` on the line, in order. `field` stays the last one so the single-value path is
     untouched; `fields` is what the multi-value path reads. */
  fields?: string[];
  /** Every `--include` on the line, `all` already expanded. */
  include?: StateSection[];
}

/**
 * Commands whose first positional names a subcommand rather than an option.
 *
 * Named once because three places ask the same question, and one of them used to ask it wrongly:
 * `--help` accepted exactly one positional, so `xforge work-package acknowledge --help` — the
 * spelling anybody reaches for — died on `Unexpected positional argument: acknowledge` and sent the
 * reader up a level to find the usage by hand. A group's help already covers every subcommand it
 * has, so the leaf resolves to it rather than being refused.
 */
const GROUP_COMMANDS = new Set<string>(['audit', 'hook', 'work-package', 'verification', 'transition', 'review', 'findings', 'contract']);

const COMMANDS: CommandName[] = ['help', 'version', 'init', 'state', 'install', 'sync', 'update', 'uninstall', 'check', 'stage', 'advance', 'stage-bundle', 'explain', 'verification', 'transition', 'approve', 'audit', 'work-package', 'hook', 'archive', 'doctor', 'upgrade-scaffold', 'review', 'findings', 'contract'];
/*
 * `flows` and `approvals` are gone from this list because they were never in it in any working
 * sense. `--kind` filters `data.resources`, whose keys come from `SelectedResources`, and that type
 * has no `flows` and no `approvals` member -- so `--kind flows` walked the valid-kind check, indexed
 * a key that does not exist, and answered `"resources":{}`. A Skill instructed it. An empty object
 * is the worst available answer: it reads as "this project has no Flows" rather than as a mistake.
 * The Flows are reached with `--include flows`, and the refusal now names that.
 */
const VALID_KINDS = ['skills', 'agents', 'rules', 'policies', 'hooks', 'gates', 'scripts', 'mcp-servers'] as const;
/* The only option that may appear more than once. Every other repeat is a mistake -- see the
   duplicate guard in the parse loop. */
const REPEATABLE_OPTIONS = new Set(['--field', '--include']);

const VALUE_OPTIONS = ['--root', '--change', '--kind', '--target', '--gate', '--to', '--for', '--policy', '--actor', '--role', '--reason', '--decision', '--attestation', '--provider', '--output', '--event', '--package', '--language', '--as', '--evidence', '--stage', '--gate-name', '--command', '--module', '--covers', '--working-directory', '--timeout-seconds', '--not-applicable', '--justification', '--by', '--status', '--receipt', '--field', '--id', '--answer', '--scope', '--include', '--content', '--evidence-detail'] as const;

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
      /*
       * Where the name *does* live, when it lives one level down.
       *
       * Two live runs asked for `mandatoryGateEvidence` and got "data has no mandatoryGateEvidence
       * (it has: project, scaffold, …, change)" -- true, and one level short of useful: it is
       * `change.mandatoryGateEvidence`, and the key list printed the container it is inside. The
       * all-or-nothing rule means that guess costs every other field asked for in the same call, so
       * the round trip is not free. One level only: past that the search stops being a correction
       * and starts being a different question.
       */
      const nested = Object.keys(container).find((key) => {
        const child = container[key];
        return child !== null && typeof child === 'object'
          && Object.prototype.hasOwnProperty.call(child as object, segment);
      });
      const hint = nested ? ` Did you mean ${[...walked, nested, segment].join('.')}?` : '';
      return { found: false, reason: `${walked.length ? walked.join('.') : 'data'} has no "${segment}"${available.length ? ` (it has: ${available.join(', ')})` : ''}.${hint}` };
    }
    current = container[segment];
    walked.push(segment);
  }
  return { found: true, value: current };
}

/**
 * One value out of an Envelope, `data` first.
 *
 * `data` is what a caller almost always means, and it stays the default so `--field changes` --
 * a name both levels carry -- keeps resolving to `data.changes` for every existing caller. But the
 * Skills tell a Stage to consume the ready Action for the current revision, and `nextActions` is a
 * sibling of `data` rather than a member of it. Addressing only `data` meant the one thing a Stage
 * was told to read was the one thing it could not ask for, so it fetched the whole envelope
 * instead: 23 of 32 `state` calls in a solid run did exactly that.
 *
 * A miss reports the `data` walk, not the envelope walk, because that is the level the caller meant.
 */
function resolveEnvelopeField(result: Envelope, path: string): { found: true; value: unknown } | { found: false; reason: string } {
  const inData = resolveField(result.data, path);
  if (inData.found) return inData;
  const head = path.split('.')[0]!;
  if (Object.prototype.hasOwnProperty.call(result, head)) return resolveField(result, path);
  return inData;
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
  state: { usage: 'xforge [--root <path>] state [--change <id>] [--kind <kind>] [--include <section>]... [--target <target>] [--text] [--field <path>]...', description: 'Read resolved project and Change state. --field prints one value and nothing else, addressed as a dotted path through data (for example change.governance.revision.contentRevision, or change.governance.readyTransitions.0.to — both need --change). Use it instead of grepping the JSON: several governance fields repeat under every historical receipt, so a line-oriented match returns whichever came first rather than the current one. A path is looked up in data first, then among the envelope own fields, so nextActions and diagnostics are addressable too. Repeat --field to read several values in one call: the answer is then a JSON object keyed by the paths you asked for, and a path that does not resolve fails the whole call rather than answering partially. Six sections are left out by default because none of them change between two reads and all of them are large: the Flow definitions other than the one this Change runs, the target capability matrix, the lockfile digests, the Constitution\'s text, the Transition receipt chain, and each Artifact\'s instruction and outline. Each is restored by name with --include (repeatable, or --include all), and where one is omitted the payload says which option returns it. --kind is unrelated: it filters the resource listing only.', options: ['--root', '--change', '--kind', '--include', '--target', '--text', '--field'] },
  install: { usage: 'xforge [--root <path>] install [--target <target>] [--adopt] [--dry-run] [--text]', description: 'Install or idempotently reconcile selected project assets.', options: ['--root', '--target', '--adopt', '--dry-run', '--text'] },
  sync: { usage: 'xforge [--root <path>] sync [--target <target>] [--adopt] [--dry-run] [--verify-digests] [--text]', description: 'Incrementally sync localized Scaffold changes to installed targets.', options: ['--root', '--target', '--adopt', '--dry-run', '--verify-digests', '--text'] },
  update: { usage: 'xforge [--root <path>] update [--target <target>] [--adopt] [--dry-run] [--text]', description: 'Fully reconcile installed targets, identities, and Adapter output.', options: ['--root', '--target', '--adopt', '--dry-run', '--text'] },
  uninstall: { usage: 'xforge [--root <path>] uninstall [--target <target>] [--force] [--dry-run] [--text]', description: 'Remove managed target files, refusing on a digest mismatch unless --force.', options: ['--root', '--target', '--force', '--dry-run', '--text'] },
  check: { usage: 'xforge [--root <path>] check [--change <id>] [--evidence-detail <summary|full>] [--gate <id>] [--stage <id> | --all-gates] [--force] [--text]', description: 'Validate project structure, deliveries, and the Gates the current Stage requires. With no Gate selection this also executes the verify commands declared by every work package, which for a large plan is dozens of external commands and minutes of wall time; narrowing with --gate, --stage or --all-gates runs only the selected Gates and skips them. Every one of those commands runs in this same working tree, one after another, so a verify command must be safe to re-enter: a suite that writes to a fixed scratch path, or asserts wall-clock throughput, will fail here for reasons that have nothing to do with the code under test. --field takes one value out of the result and prints nothing else, addressed as a dotted path through data (for example gates, or blockedBy); repeat it to read several in one call. Ask for `gates`, not `gates.0.status`: a Stage that declares no Gate answers with an empty list, `gates.0` then resolves to nothing, and the all-or-nothing rule fails the whole call -- turning a check that passed into `ok: false` with `data: null`. This is the largest recurring output a Stage produces, and it is usually consulted for one of them.', options: ['--evidence-detail', '--root', '--change', '--gate', '--stage', '--all-gates', '--force', '--text', '--field'] },
  advance: { usage: 'xforge [--root <path>] advance --change <id> [--to <stage>] [--dry-run] [--text]', description: 'Run this Stage\'s Gates and, if nothing refuses, take the Transition — the pair every Stage ends with, as one call. It is a call-count optimisation and nothing else: the Gate results and the Transition receipt are written separately and audited separately, exactly as when the two commands are run by hand. A failing or stale Gate refuses the Transition and says which one, so this can never move a Change past a Gate that did not pass. --to names the target when more than one Transition is ready; with one ready Transition it is the one taken, and with none this reports what is blocking and writes no receipt.', options: ['--root', '--change', '--to', '--dry-run', '--text'] },
  stage: { usage: 'xforge [--root <path>] stage --change <id> [--content <none|changed|full>] [--text] [--field <path>]...', description: 'Everything this Stage needs, in one reply: where the Change stands, the Action that is ready with its writes, sections, instruction and outline, the text of that Action\'s inputs, the Constitution, and the diagnostics. --content names how much arrives as text and nothing else: changed (the default) sends the Stage\'s own outputs, whatever moved since the Stage was entered, and the Constitution, and offers a digest and section list for the rest; full gives up the digest vouchers and sends everything; none sends the plan alone. It is an intent, not a field list — a caller that has to enumerate what it needs on the way in is being asked the question it came here to have answered. --field is for the way back out: the same dotted-path selection every other read command takes, for re-reading one value from a reply already received. Withholding it did not stop callers narrowing this reply, it stopped them narrowing it cheaply -- a measured run read one stage reply with two calls, `| head -c 6000` then `| tail -c 4500`, the second re-running the whole command, and hand-parsed it with python on a third.', options: ['--root', '--change', '--content', '--text', '--field'] },
  'stage-bundle': { usage: 'xforge [--root <path>] stage-bundle --change <id> [--text]', description: 'List which of this Change\'s Artifacts have moved since the current Stage was entered, and which a digest can stand in for. A Transition receipt records the commit its Stage began at, so the set that changed is computable rather than assumed; the Stage\'s own outputs and the Constitution are always listed to be read, and an uncommitted edit anywhere under the Change voids every digest because git compares commits and cannot see one.', options: ['--root', '--change', '--text'] },
  explain: { usage: 'xforge explain <XFORGE_CODE> [--text]', description: 'Say what a diagnostic code means: its severity, and every message it can carry, from a catalogue frozen into this build. One code is raised from more than one place and each says something slightly different; which of those a reader has not met is what tells them the code has another cause. No project is required.', options: ['--text'] },
  verification: {
    usage: 'xforge [--root <path>] verification declare --gate-name <gate> (--command \'["prog","arg"]\' | --not-applicable <marker> --justification <text>) --by <person> [--module <id>] [--covers \'["marker"]\'] [--working-directory <path>] [--timeout-seconds <n>] [--dry-run] [--text]\n       xforge [--root <path>] verification retire --gate-name <gate> (--command \'["prog","arg"]\' | --not-applicable <marker>) --by <person> --reason <text> [--module <id>] [--dry-run] [--text]\n       xforge [--root <path>] verification draft-receipt --change <id> [--text]\n       xforge [--root <path>] verification finalize --change <id> --status passed --by <person> [--dry-run] [--text]',
    description: 'Declare how this project runs a declared-verification Gate, without hand-editing the Manifest; retire a declaration that should stop running, keeping the record of who withdrew it and why; or draft the current Stage\'s verification receipt from what XForge already knows. The draft omits `status` and writes nothing: that field is the Stage\'s assertion that the work was verified, and a CLI filling it in would be deciding the thing the receipt exists to record. finalize writes the same facts for you once you supply that assertion yourself, as --status passed signed with --by. It is not a shortcut past the check: before recording that a Gate passed it re-reads that Gate\'s Evidence from disk, and it writes nothing at all if any Gate the Stage cites is stale against the current content revision, failed, or never ran — naming the re-run, the fix, or the first run, because those are three different problems. passed is the only status it writes; a Stage that did not verify does not file a receipt at all.',
    options: ['--root', '--change', '--gate-name', '--command', '--module', '--covers', '--working-directory', '--timeout-seconds', '--not-applicable', '--justification', '--by', '--status', '--reason', '--dry-run', '--text', '--field'],
  },
  findings: {
    usage: 'xforge [--root <path>] findings resolve --change <id> --id <finding-id> --answer <text> --by <person> [--dry-run] [--text]',
    description: 'Record a person\'s answer to one Check finding and mark it resolved. Only this one transition: findings are written by the Check Stage, and this closes an entry that already exists. --by is checked against the approvers and Git authors this Change records, so a decision-maker can be cited but not invented.',
    options: ['--root', '--change', '--id', '--answer', '--by', '--dry-run', '--text', '--field'],
  },
  transition: { usage: 'xforge [--root <path>] transition --change <id> --to <stage> [--dry-run] [--text]\n       xforge [--root <path>] transition repair --change <id> --receipt <receiptId> [--dry-run] [--text]', description: 'Evaluate and record a governed Stage transition, or repair the receipt chain by dropping one leaf receipt. Repair is not a --force: it discards a recorded transition, reverting the Change to the Stage that transition left, and records what it discarded in the audit chain. Only a leaf may go — a receipt some later receipt chains to is load-bearing and is refused. --field takes one value out of the result and prints nothing else, addressed as a dotted path through data; repeat it to read several in one call.', options: ['--root', '--change', '--to', '--receipt', '--dry-run', '--text', '--field'] },
  approve: { usage: 'xforge [--root <path>] approve --change <id> --for <transition-id|archive> [--policy <id>] [--provider <mcp-provider-id> | local fields] [--dry-run] [--text]', description: 'Record an interactive human approval at the terminal, or submit/poll an mcp provider. There is no other approval mechanism. --for takes the id of the transition the approval unlocks (the value xforge state reports in nextActions[].command), not a literal word.', options: ['--root', '--change', '--for', '--policy', '--actor', '--role', '--reason', '--decision', '--attestation', '--provider', '--dry-run', '--text'] },
  audit: { usage: 'xforge [--root <path>] audit <status|verify|export|retry|prune> [--change <id>] [--output <path>] [--text]', description: 'Inspect, verify, export, redeliver, or prune the append-only audit chain. --field takes one value out of the result and prints nothing else, addressed as a dotted path through data; repeat it to read several in one call.', options: ['--root', '--change', '--output', '--text', '--field'] },
  'work-package': { usage: 'xforge [--root <path>] work-package <dispatch|draft|acknowledge> --change <id> --package <id> [--as <integrator|reviewer> --evidence <path> [--scope <text>]] [--commit] [--dry-run] [--text]', description: 'Dispatch a work package, draft its delivery record from what XForge already knows, or acknowledge integration/review evidence. dispatch --commit commits the receipt and the audit index it just wrote, and nothing else, because the delivery is measured from the commit containing that receipt and work sharing or preceding it falls outside the range; without the flag the reply says to do the same by hand. It is the only place XForge writes Git history, and only when asked. --scope records what the acknowledgement actually covered, in the acknowledger\'s own words; it is optional and never inferred, so an absent scope means nobody said. --field takes one value out of the result and prints nothing else, addressed as a dotted path through data; repeat it to read several in one call.', options: ['--root', '--change', '--package', '--as', '--evidence', '--scope', '--commit', '--dry-run', '--text', '--field'] },
  contract: {
    usage: 'xforge [--root <path>] contract list [--kind <kind>] [--text] [--field <path>]...\n       xforge [--root <path>] contract status [--text] [--field <path>]...',
    description: 'list: what the contract baseline records — every contract element, by the `<kind>:<selector>` id a delta has to address it by, and the module each one belongs to. Read-only, and there is no command beside it that writes an element: the baseline advances by a merged contract delta and by nothing else, so a second writer would undo the one property it has. --kind filters to one dialect and still lists a domain that matches nothing, because "records no element of this kind" and "does not exist" are different answers. status: what every Change in flight declares it will do to that baseline, and which elements more than one of them claims — the question no Gate can answer, because a content revision is computed per Change and a Gate runs inside one. It reports and never blocks: an expand half and a contract half of one migration look exactly like a collision, and whichever Change archives second is the one that would otherwise find out at merge time.',
    options: ['--root', '--kind', '--text', '--field'],
  },
  hook: { usage: 'xforge hook dispatch --target <target> --event <event>', description: 'Internal platform Hook dispatcher.', options: ['--root', '--target', '--event'] },
  archive: { usage: 'xforge [--root <path>] archive --change <id> [--dry-run] [--text]', description: 'Verify, merge Specs, and atomically archive a Change. --field takes one value out of the result and prints nothing else, addressed as a dotted path through data; repeat it to read several in one call.', options: ['--root', '--change', '--dry-run', '--text', '--field'] },
  'upgrade-scaffold': {
    usage: 'xforge [--root <path>] upgrade-scaffold [--complete | --rollback] [--with-active-changes] [--allow-dirty] [--force] [--dry-run] [--text]',
    description: 'Stage the Scaffold this CLI ships beside the project\'s own and classify every file, so a person or an Agent can merge it. Staging refuses while the managed paths have uncommitted changes, because the commit it records is the restore point underneath the snapshot; --allow-dirty stages without one.',
    options: ['--root', '--complete', '--rollback', '--with-active-changes', '--allow-dirty', '--force', '--dry-run', '--text'],
  },
  review: {
    usage: 'xforge [--root <path>] review acknowledge --change <id> --evidence <path> [--scope <text>] [--dry-run] [--text]',
    description: "Record that this Change's delivered work was reviewed, for Changes delivered without a work-package plan. The per-package form is `work-package acknowledge --as reviewer`, and this is refused when a plan exists. There is no --by: the actor comes from the environment, because a field inviting a reviewer's name invites a fabricated one.",
    options: ['--root', '--change', '--evidence', '--scope', '--dry-run', '--text'],
  },
  doctor: { usage: 'xforge [--root <path>] doctor [--kind <kind>] [--strict] [--text]', description: 'Report unreferenced and dangling Flow/Skill/Rule/Gate/Hook/PermissionPolicy/Approval/McpServer extensions.', options: ['--root', '--kind', '--strict', '--text'] },
};

function parseArguments(argv: string[]): ParsedArguments {
  const parsed: ParsedArguments = { command: '', text: false, dryRun: false, verifyDigests: false, strict: false, allGates: false, force: false, adopt: false, complete: false, rollback: false, withActiveChanges: false, allowDirty: false };
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
    /* Duplicates are an error everywhere else because the outcome would be a silent last-wins: the
       caller wrote two values and one vanished. `--field` is the exception by design -- repeating
       it asks for several values in one call, so nothing is discarded. */
    if (seen.has(token) && !REPEATABLE_OPTIONS.has(token)) throw new XForgeError(diagnostic('XFORGE_ARGUMENT_DUPLICATE', `Duplicate option: ${token}`));
    seen.add(token);
    if (token === '--help') { helpShortcut = true; continue; }
    if (token === '--version') { versionShortcut = true; continue; }
    if (token === '--text') { parsed.text = true; continue; }
    if (token === '--dry-run') { parsed.dryRun = true; continue; }
    if (token === '--commit') { parsed.commit = true; continue; }
    if (token === '--verify-digests') { parsed.verifyDigests = true; continue; }
    if (token === '--strict') { parsed.strict = true; continue; }
    if (token === '--complete') { parsed.complete = true; continue; }
    if (token === '--rollback') { parsed.rollback = true; continue; }
    if (token === '--with-active-changes') { parsed.withActiveChanges = true; continue; }
    if (token === '--allow-dirty') { parsed.allowDirty = true; continue; }
    if (token === '--all-gates') { parsed.allGates = true; continue; }
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
    if (token === '--field') { parsed.field = value; (parsed.fields ??= []).push(value); }
    if (token === '--working-directory') parsed.workingDirectory = value;
    if (token === '--timeout-seconds') parsed.timeoutSeconds = value;
    if (token === '--not-applicable') parsed.notApplicable = value;
    if (token === '--justification') parsed.justification = value;
    if (token === '--id') parsed.findingId = value;
    if (token === '--answer') parsed.answer = value;
    if (token === '--scope') parsed.scope = value;
    if (token === '--content') parsed.content = value;
    if (token === '--evidence-detail') parsed.evidenceDetail = value;
    if (token === '--by') parsed.by = value;
    if (token === '--status') parsed.status = value;
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
    if (token === '--include') {
      /*
       * Same singular tolerance as `--kind`, for the same reason, plus `all` for the caller who
       * wants the payload `state` returned before these sections were made opt-in.
       */
      if (value === 'all') { parsed.include = [...STATE_SECTIONS]; continue; }
      const canonical = STATE_SECTIONS.find((section) => section === value || section === `${value}s`
        || section.toLowerCase() === value.toLowerCase());
      if (!canonical) {
        throw new XForgeError(diagnostic('XFORGE_INCLUDE_UNKNOWN', `Unknown section: ${value}. Valid sections are ${STATE_SECTIONS.join(', ')}, or all.`));
      }
      (parsed.include ??= []).push(canonical);
    }
    if (token === '--kind') {
      /*
       * Stored raw and resolved after the command is known, because two commands take `--kind` over
       * two universes and this loop runs before `parsed.command` is assigned. `state` filters the
       * resource listing, a closed set the CLI can name alternatives from; `contract list` filters
       * by contract dialect, which is whatever a project's own adapters print. Validating the second
       * against the first is what produced "Unknown resource kind: sql".
       */
      parsed.contractKind = value;
    }
    if (token === '--target') {
      if (!TARGETS.includes(value as TargetId)) throw new XForgeError(diagnostic('XFORGE_TARGET_UNKNOWN', `Unknown target: ${value}`));
      parsed.target = value as TargetId;
    }
  }

  if (helpShortcut && versionShortcut) throw new XForgeError(diagnostic('XFORGE_OPTION_NOT_ALLOWED', '--help and --version cannot be combined.'));
  if (helpShortcut) {
    /* A second positional is the subcommand, and only where the first names a group: `xforge state
       garbage --help` is still a typo worth reporting, while `verification declare --help` is not. */
    const leafHelp = positionals.length === 2 && GROUP_COMMANDS.has(positionals[0] ?? '');
    if (positionals.length > 1 && !leafHelp) throw new XForgeError(diagnostic('XFORGE_ARGUMENT_UNEXPECTED', `Unexpected positional argument: ${positionals[1]}`));
    parsed.command = 'help';
    parsed.helpCommand = positionals[0];
    if (leafHelp) parsed.helpSubcommand = positionals[1];
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
    /*
     * `--kind` resolved now that the universe is known. Anything but `contract` means the resource
     * listing, and the singular is accepted: the Skills that tell an Agent to run this say
     * `--kind <resource>`, a live run typed `--kind skill`, got "Unknown resource kind" with no list
     * of what would have worked, and abandoned the flag.
     */
    if (parsed.contractKind !== undefined && parsed.command !== 'contract') {
      const value = parsed.contractKind;
      const canonical = VALID_KINDS.find((kind) => kind === value || kind === `${value}s`);
      if (!canonical) {
        /* `flows` and `approvals` used to be accepted here and answer with nothing, so a caller
           who learned them from an older Skill is sent to the option that does answer. */
        const redirect = ['flows', 'flow', 'approvals', 'approval'].includes(value)
          ? ` ${value.replace(/s$/, '')}s are not a resource kind — use \`xforge state --include flows\`.`
          : '';
        throw new XForgeError(diagnostic('XFORGE_KIND_UNKNOWN', `Unknown resource kind: ${value}. Valid kinds are ${VALID_KINDS.join(', ')}.${redirect}`));
      }
      parsed.kind = canonical as ParsedArguments['kind'];
      parsed.contractKind = undefined;
    }
    if (parsed.command === 'help') {
      parsed.helpCommand = positionals[1];
      const leafHelp = positionals.length === 3 && GROUP_COMMANDS.has(positionals[1] ?? '');
      if (leafHelp) parsed.helpSubcommand = positionals[2];
      if (positionals.length > 2 && !leafHelp) throw new XForgeError(diagnostic('XFORGE_ARGUMENT_UNEXPECTED', `Unexpected positional argument: ${positionals[2]}`));
    } else if (parsed.command === 'explain') {
      parsed.explainCode = positionals[1];
      if (positionals.length > 2) throw new XForgeError(diagnostic('XFORGE_ARGUMENT_UNEXPECTED', `Unexpected positional argument: ${positionals[2]}`));
    } else if (GROUP_COMMANDS.has(parsed.command)) {
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
    /*
     * A Skill's name is not a command, and saying so beats listing everything.
     *
     * Three of four measured Check runs opened with `xforge status`, which does not exist. Nothing
     * about that is a guess at a command name: `xforge-status` is a shipped Skill, and a Skill and a
     * command are different kinds of thing that share a vocabulary. The old message answered by
     * pointing at `help`, so each of those runs spent a second call reading the command table to
     * learn that the thing it wanted was not there at all.
     */
    const skillNamed = parsed.command && !COMMANDS.includes(parsed.command as CommandName)
      ? ['propose', 'clarify', 'design', 'check', 'apply', 'verify', 'status', 'revise', 'scaffold', 'kanban', 'architect', 'upgrade-scaffold'].includes(parsed.command)
      : false;
    throw new XForgeError(diagnostic(
      parsed.command ? 'XFORGE_COMMAND_UNKNOWN' : 'XFORGE_COMMAND_REQUIRED',
      parsed.command
        ? skillNamed
          ? `Unknown command: ${parsed.command}. \`xforge-${parsed.command}\` is a Skill, not a CLI command — a Skill is instructions you read and follow, and it is the one that runs \`xforge\` commands. What you probably want here is \`xforge stage --change <id>\` for where a Change stands and what to do next, or \`xforge state\` for the portfolio. Run xforge help for the full command table.`
          : `Unknown command: ${parsed.command}. Run xforge help for supported commands.`
        : 'A command is required. Run xforge help for supported commands.',
    ));
  }

  const allowed = new Set(HELP[parsed.command as CommandName].options);
  for (const flag of seen) {
    if (flag === '--help' || flag === '--version') continue;
    if (!allowed.has(flag)) throw new XForgeError(diagnostic('XFORGE_OPTION_NOT_ALLOWED', `${flag} is not valid for ${parsed.command}.`));
  }
  if (parsed.command === 'stage-bundle' && !parsed.change) throw new XForgeError(diagnostic('XFORGE_CHANGE_REQUIRED', 'stage-bundle requires --change <id>.'));
  if (parsed.command === 'stage' && !parsed.change) throw new XForgeError(diagnostic('XFORGE_CHANGE_REQUIRED', 'stage requires --change <id>.'));
  if (parsed.command === 'advance' && !parsed.change) throw new XForgeError(diagnostic('XFORGE_CHANGE_REQUIRED', 'advance requires --change <id>.'));
  if (parsed.content !== undefined && !['none', 'changed', 'full'].includes(parsed.content)) {
    throw new XForgeError(diagnostic('XFORGE_OPTION_VALUE_INVALID', `--content takes none, changed, or full; got ${parsed.content}. It names how much of the working set arrives as text, not which fields to include.`));
  }
  if (parsed.evidenceDetail !== undefined && !['summary', 'full'].includes(parsed.evidenceDetail)) {
    throw new XForgeError(diagnostic('XFORGE_OPTION_VALUE_INVALID', `--evidence-detail takes summary or full; got ${parsed.evidenceDetail}.`));
  }
  if (parsed.evidenceDetail !== undefined && parsed.command !== 'check') {
    throw new XForgeError(diagnostic('XFORGE_OPTION_NOT_ALLOWED', `--evidence-detail is only valid for check; ${parsed.command} returns no Gate Evidence.`));
  }
  if (parsed.content !== undefined && parsed.command !== 'stage') {
    throw new XForgeError(diagnostic('XFORGE_OPTION_NOT_ALLOWED', `--content is only valid for stage; ${parsed.command} does not carry a working set.`));
  }
  if (parsed.command === 'archive' && !parsed.change) throw new XForgeError(diagnostic('XFORGE_CHANGE_REQUIRED', 'archive requires --change <id>.'));
  if (parsed.command === 'verification') {
    if (!['declare', 'retire', 'draft-receipt', 'finalize'].includes(parsed.subcommand ?? '')) throw new XForgeError(diagnostic('XFORGE_VERIFICATION_ACTION_REQUIRED', 'verification requires the declare, retire, draft-receipt or finalize action.'));
    if (parsed.subcommand === 'retire' && (!parsed.gateName || !parsed.by || !parsed.reason)) {
      throw new XForgeError(diagnostic(
        'XFORGE_VERIFICATION_ARGUMENTS_REQUIRED',
        'verification retire requires --gate-name <gate>, --by <person> and --reason <text>. The person and the reason are required for the same reason they are on declare: nothing can decide mechanically whether a check is still worth running, so withdrawing one is a judgement that has to carry a name.',
      ));
    }
    if (parsed.subcommand === 'declare' && (!parsed.gateName || !parsed.by)) throw new XForgeError(diagnostic('XFORGE_VERIFICATION_ARGUMENTS_REQUIRED', 'verification declare requires --gate-name <gate> and --by <person>. The person is required because nothing can decide mechanically whether a command verifies anything; this records who answered.'));
    if (parsed.subcommand === 'draft-receipt' && !parsed.change) throw new XForgeError(diagnostic('XFORGE_CHANGE_REQUIRED', 'verification draft-receipt requires --change <id>.'));
    if (parsed.subcommand === 'finalize') {
      if (!parsed.change) throw new XForgeError(diagnostic('XFORGE_CHANGE_REQUIRED', 'verification finalize requires --change <id>.'));
      /* The same refusal declare and retire make, for the same reason: the Gates are machine-decided
         but that the Stage verified the work is not, so an unsigned receipt would record an
         assertion nobody made. --status is required alongside it rather than defaulted, because a
         default would let the command supply the claim as well as file it. */
      if (!parsed.status || !parsed.by) {
        throw new XForgeError(diagnostic(
          'XFORGE_VERIFICATION_ARGUMENTS_REQUIRED',
          'verification finalize requires --status passed and --by <person>. Nothing can decide mechanically that this Stage verified the work, so the receipt has to carry a name, and the assertion has to be stated rather than assumed.',
        ));
      }
    }
    if (parsed.status !== undefined && parsed.subcommand !== 'finalize') throw new XForgeError(diagnostic('XFORGE_OPTION_NOT_ALLOWED', '--status is only valid for verification finalize.'));
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
    if (parsed.subcommand !== 'dispatch' && parsed.commit) {
      throw new XForgeError(diagnostic('XFORGE_OPTION_NOT_ALLOWED', '--commit is only valid for work-package dispatch, which is the one command whose output has to be committed before the next step runs.'));
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

function helpEnvelope(subject?: string, subcommand?: string): Envelope {
  if (subject && !COMMANDS.includes(subject as CommandName)) {
    throw new XForgeError(diagnostic('XFORGE_HELP_COMMAND_UNKNOWN', `Unknown help command: ${subject}`));
  }
  const commandHelp = subject ? HELP[subject as CommandName] : null;
  /*
   * The index of every command answers "what can this thing do". `help <command>` is a different
   * question, and it was answering both: the full descriptions of all twenty-two commands ahead of
   * the one that was asked for. Several of those descriptions are paragraphs, so the index was 75%
   * of the reply — an end-to-end run spent more context on three `help` calls than on the ten
   * `state --field` calls the whole cost argument in XFORGE.md is built around.
   *
   * Asking about one command now lists the others by name only, which still answers "what else is
   * there" and costs a line instead of a page. Bare `help` is unchanged: there, the index is the
   * answer.
   */
  return envelope({
    command: 'help',
    root: null,
    data: {
      usage: 'xforge [--root <path>] <command> [options] [--text]',
      /*
       * Narrowed under a different name, not the same name with a different type.
       *
       * `commands` was a `Record<name, description>` for the index and became a `string[]` when a
       * subject was named, so a caller doing `data.commands["state"]` got a description in one case
       * and `undefined` in the other, and `Object.keys` returned names or array indices depending
       * on which call it had made. A key that is absent is a fact a caller can test; a key whose
       * type changes underneath it is not.
       */
      ...(subject
        ? { otherCommands: COMMANDS.filter((command) => command !== subject) }
        : { commands: Object.fromEntries(COMMANDS.map((command) => [command, HELP[command].description])) }),
      globalOptions: { '--root <path>': 'Use an exact project root.', '--text': 'Present the same result as readable text.' },
      commandHelp,
      /* Reported rather than dropped: a reader who asked about one subcommand and is handed the
         group's usage should be able to see that is what happened, not wonder whether the leaf was
         understood. The group's usage covers every subcommand it has, so the answer is complete. */
      ...(subcommand ? { subcommand, subcommandNote: `Usage is documented per command group; the block above covers every ${subject} subcommand, including ${subcommand}.` } : {}),
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
  /* Declared here because `stage` reports them, and they were arriving as `undefined` from a type
     that named three of the fields the payload actually carries. */
  gates?: string[];
  reworkTo?: string[];
  exit?: { conditions?: Record<string, unknown>; gates?: string[] };
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


/**
 * Everything the caller could do next, computed from a resolved state payload.
 *
 * Extracted so that commands which *change* something can answer with it too. `transition` used to
 * return `nextActions: []` -- a successful Stage move read as "nothing left to do", and the only way
 * to learn the new Stage's Actions was a fresh `state` call. Across twenty recorded runs `state` was
 * half of every governance call, and four measured Stages spent 58-81% of their calls on orientation;
 * re-asking after every write is a large part of that.
 *
 * The rule this establishes: a command that moves the Change hands back the post-condition, so the
 * Agent never has to ask what it just did.
 */
async function nextActionsFor(
  project: ProjectContext,
  data: Record<string, any>,
  changeId: string | undefined,
): Promise<NextAction[]> {
  const nextActions: NextAction[] = [];
  /* Hoisted: both the Change and the work-package plan are written under it, and a second copy of
     the fallback string is a second thing to keep in step with the Manifest. */
  const changesPath = (data.project as { paths?: { changes?: { value?: string } } } | undefined)?.paths?.changes?.value ?? 'xforge/changes';
  if (project.compatibility.mode === 'portable') nextActions.push({ action: 'resolve-declared-xforge', reason: 'Managed operations require the exact declared CLI identity.' });
  const stateChange = (data.change ?? null) as {
    flow?: string;
    path?: string;
    artifacts?: Array<{ id: string; outputPaths?: string[]; writePath?: string }>;
    nextArtifact?: { id?: string; outputPaths?: string[]; writePath?: string; missingDependencies?: string[]; outline?: string; generates?: string; requires?: string[] } | null;
    workPackages?: { packages?: Array<{ id: string; inputs: string[]; write_paths: string[]; done_when: string[] }> } | null;
  } | null;
  const stages = flowStages(data, stateChange?.flow);
  /*
   * Starting a Change, as an Action rather than as prose.
   *
   * Every other step of a governed Flow is a typed Action; this one was a YAML block inside
   * `xforge-propose` and the destination was left for the Agent to assemble from the Changes
   * path. Offered only at the portfolio view, which is where the question "should this become a
   * Change" is actually asked -- inside a Change, the answer is already yes.
   */
  if (!changeId) {
    const projectFacts = data.project as { modules?: Array<{ id: string }> } | undefined;
    nextActions.push({
      action: 'create-change',
      type: 'artifact',
      actor: 'main',
      authority: 'planning-write',
      status: 'ready',
      inputs: [],
      writes: [`${changesPath}/<change-id>/change.yaml`],
      template: changeTemplate(project.manifest.flow, (projectFacts?.modules ?? []).map((module) => module.id)),
      doneWhen: [
        'change.yaml exists under a new kebab-case Change id in the resolved Changes directory.',
        `Every classification key is answered from the work: ${CLASSIFICATION_KEYS.join(', ')}.`,
      ],
      requiredEvidence: ['xforge state --change <id> resolves the Change and reports its first ready Artifact.'],
      reason: 'A governed Change begins with change.yaml; no other Action creates one.',
    });
  }
  if (stateChange?.nextArtifact?.id && changeId) {
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
    /*
     * A glob Artifact's destination, answered rather than handed back as the glob.
     *
     * `writePath` for `delta-specs` is the glob the Flow declares, which is a pattern and not a place. Four
     * measured runs produced three different paths from it -- `specs/root/spec.md`,
     * `specs/root/task-ledger.md`, `specs/task-ledger/spec.md` -- and two of them went reading the
     * CLI's own compiled source to decide, spending 13% of the Stage's calls on the question. The
     * paths are not interchangeable: `core/spec-merger.ts` reads the segment as a capability name and
     * archive merges the delta into the canonical Specs at that relative path, so three answers are
     * three different canonical files that nothing ever compares.
     *
     * What the product can state is the part it knows: which capabilities this project already
     * records. The naming rule itself belongs to the Flow's `instruction`, beside the rest of the
     * Artifact's shape; this adds the project's own facts to it, which is the half a Flow cannot
     * carry.
     */
    const capabilities = [...new Set(((data.specs ?? []) as string[])
      .map((entry) => entry.replace(/\.md$/, ''))
      .map((entry) => entry.endsWith('/spec') ? entry.slice(0, -'/spec'.length) : entry))].sort();
    const globDestination = stateChange.nextArtifact.generates?.includes('*') && stateChange.nextArtifact.outputPaths?.length === 0
      ? capabilities.length > 0
        ? `Write it under a capability this project already records: ${capabilities.join(', ')}. Inventing a second name for one of these splits the canonical Spec in two.`
        : 'This project records no canonical Spec yet, so the capability named in this path becomes the first one, and every later Change touching the same behaviour has to match it.'
      : null;
    nextActions.push({
      action: 'create-artifact',
      type: 'artifact',
      id: artifactId,
      actor: 'main',
      ...(authority ? { authority } : {}),
      status: 'ready',
      /*
       * What to read, not what is absent.
       *
       * This was `missingDependencies`, which is empty exactly when the Action is ready — so the
       * one field a Skill is told to reread was `[]` at every moment it could have been acted on.
       * Twelve Skills carry "reread every Action input from disk" and it pointed at nothing, which
       * left the Agent to fall back on rereading the whole Change: the cost `stage-bundle` was
       * built to measure. The real answer is the Artifact's satisfied `requires`, resolved to the
       * project-relative files they actually produced.
       */
      inputs: (stateChange.nextArtifact.requires ?? []).flatMap((required) => {
        const dependency = stateChange.artifacts?.find((artifact) => artifact.id === required);
        if (!dependency) return [];
        const changeRoot = stateChange.path;
        if (dependency.outputPaths?.length && changeRoot) return dependency.outputPaths.map((output) => `${changeRoot}/${output}`);
        return dependency.writePath ? [dependency.writePath] : [];
      }),
      /* A not-yet-written Artifact has no outputPaths, which used to leave `writes` empty and the
         destination for the Agent to guess. State the project-relative path instead. */
      writes: stateChange.nextArtifact.outputPaths?.length
        ? stateChange.nextArtifact.outputPaths
        : [stateChange.nextArtifact.writePath].filter((item): item is string => Boolean(item)),
      /* The headings verbatim, so the author is not left inferring them from a Markdown fragment.
         Omitted for a glob Artifact, whose outline is a repeating template rather than a section
         set, and when the Flow declares none. */
      ...(sections.length > 0 ? { requiredSections: sections } : {}),
      doneWhen: [
        `Artifact ${artifactId} exists and satisfies the active Flow instructions.`,
        ...(globDestination ? [globDestination] : []),
      ],
      requiredEvidence: ['xforge state reports the artifact as done for the current Change revision.'],
      reason: `Next Flow Artifact is ${artifactId}.`,
    });
  }
  const governance = (stateChange as any)?.governance;
  if (governance?.currentStage === 'apply') {
    /* The dispatch happens in the Stage the Change is in, so that Stage's declared authority is
       the one that applies — `implementation-write` only because the shipped Flows say so. */
    const applyAuthority = stages.find((stage) => stage.id === governance.currentStage)?.authority;
    /*
     * The Stage offers a plan before it offers a dispatch.
     *
     * `state.workPackages` is null both when no plan exists and when one exists that the schema
     * refused, and the template is the right answer to both: the second case is overwhelmingly a
     * plan written without `apiVersion` and `kind`, because those keys were documented nowhere an
     * Agent reads. An Agent that wrote a headerless plan now gets XFORGE_SCHEMA_INVALID and, beside
     * it, the shape that satisfies the schema.
     *
     * Offered only where a plan is legal to write. A persistent plan is one of two ways to run this
     * Stage -- direct serial work is the other -- so this is `status: 'pending'`, an Action the
     * Stage may take rather than one it owes.
     */
    if (!(stateChange as any)?.workPackages) {
      nextActions.push({
        action: 'create-work-packages', type: 'artifact', actor: 'main', ...(applyAuthority ? { authority: applyAuthority } : {}), status: 'pending',
        inputs: [],
        writes: [`${changesPath}/${changeId}/work-packages.yaml`],
        template: workPackagePlanTemplate(),
        doneWhen: [
          `work-packages.yaml carries ${WORK_PACKAGE_PLAN_HEADER_KEYS.join(' and ')} beside packages, and nothing else: the schema is additionalProperties: false and refuses the plan outright without them.`,
          'Every path a package writes falls inside its own write_paths, and no two packages claim one path.',
        ],
        requiredEvidence: ['xforge state --change <id> reports the plan resolved, with a ready set.'],
        reason: 'This Stage can be run from a persistent plan; no plan is resolvable for this Change.',
      });
    }
    for (const packageId of (stateChange as any)?.workPackages?.ready ?? []) {
      const workPackage = stateChange?.workPackages?.packages?.find((item) => item.id === packageId);
      nextActions.push({
        action: 'dispatch-work-package', type: 'governance', id: packageId, actor: 'main', ...(applyAuthority ? { authority: applyAuthority } : {}), status: 'ready',
        inputs: workPackage?.inputs ?? [], writes: workPackage?.write_paths ?? [], doneWhen: workPackage?.done_when ?? [],
        requiredEvidence: ['revision-bound dispatch receipt', 'Git delivery diff', 'verify command evidence', 'done_when evidence mapping'],
        reworkTo: ['apply'],
        reason: `Work package ${packageId} is ready for a revision-bound dispatch.`,
        command: ['xforge', 'work-package', 'dispatch', '--change', changeId!, '--package', packageId],
      });
    }
  }
  for (const pending of governance?.pendingApprovals ?? []) nextActions.push({
    action: 'approve', type: 'approval', id: pending.policyId, actor: 'human', status: 'pending',
    inputs: ['current state revision', `approval policy ${pending.policyId}`], writes: ['approval receipt'],
    doneWhen: [`Approval policy ${pending.policyId} is satisfied for ${pending.transition}.`], requiredEvidence: ['current-revision approval receipt'],
    reason: `Approval ${pending.policyId} is required for ${pending.transition}.`, blockedBy: [`missing:${pending.missing}`],
    command: ['xforge', 'approve', '--change', changeId!, '--for', pending.transition, '--policy', pending.policyId],
  });
  /*
   * A Gate that has not run yet, as something to do rather than something to be stuck behind.
   *
   * A blocked transition reports `gate:<id>:missing`, and no Action named the command that clears
   * it -- the answer lived only in the Skills' prose. An Agent following the Invariant every Skill
   * carries, "run the command state.nextActions gives you", had a `ready: false` transition, a block
   * it could read, and nothing to run. A cold end-to-end run reported exactly that and stopped.
   *
   * Only `missing` gets an Action. `failed` is a Gate that ran and said no, and re-running it
   * changes nothing until the content does; offering the same command there would suggest the
   * refusal is a retry away from clearing.
   */
  const missingGates = [...new Set((governance?.readyTransitions ?? [])
    .flatMap((entry: any) => entry.blockedBy ?? [])
    .filter((block: string) => block.startsWith('gate:') && block.endsWith(':missing'))
    .map((block: string) => block.slice('gate:'.length, -':missing'.length)))] as string[];
  if (changeId) for (const gateId of missingGates) nextActions.push({
    action: 'run-gates', type: 'gate', id: gateId, actor: 'main', status: 'ready',
    inputs: [], writes: [`${stateChange?.path ?? ''}/evidence/${gateId}.json`],
    doneWhen: [`Gate ${gateId} has Evidence bound to the current content revision.`],
    requiredEvidence: [`evidence/${gateId}.json written by xforge check at the current content revision`],
    reason: `Gate ${gateId} has not run at this content revision, which is what blocks the Transition.`,
    command: ['xforge', 'check', '--change', changeId, '--gate', gateId],
  });

  for (const transition of governance?.readyTransitions ?? []) nextActions.push({
    action: 'transition', type: 'transition', id: transition.to, actor: 'main', status: transition.ready ? 'ready' : 'blocked',
    inputs: ['current Change state', 'required gates and approvals'], writes: ['transition receipt'],
    doneWhen: [`Current Stage is ${transition.to}.`], requiredEvidence: ['valid transition receipt'], reworkTo: governance?.currentStage ? [governance.currentStage] : [],
    reason: transition.ready ? `Transition to ${transition.to} is ready.` : `Transition to ${transition.to} is blocked.`, blockedBy: transition.blockedBy,
    command: ['xforge', 'transition', '--change', changeId!, '--to', transition.to],
  });
  /*
   * The one-call form, offered where it is the whole remaining job.
   *
   * `advance` runs this Stage's Gates and takes the Transition if none refuses -- the CLI's own
   * description calls it "a call-count optimisation and nothing else". `xforge-apply` tells an Agent
   * to leave with it. And `nextActions`, which is where the Skills say to take a command from, never
   * mentioned it: a Stage blocked only by Gates it can run was told to make N `check` calls and then
   * a `transition`, and the `transition` it was handed would refuse until those N had happened. Two
   * commands for one act, and the one the product named was the one that fails first.
   *
   * Offered only when every remaining blocker is a Gate this Stage can actually clear. An approval,
   * an artifact or a condition in the set means `advance` cannot finish the job either, and naming
   * it there would point at a command that refuses for a reason the reader has already been told.
   * `:failed` is excluded on the same reading the `run-gates` block above uses: that Gate ran and
   * said no, and re-running changes nothing until the content does.
   *
   * Additive. The `run-gates` and `transition` rows stay, because both remain true -- a reader who
   * wants the Gate results separately, or who is scripting the two halves, is not being told to stop.
   */
  const clearableByAdvance = (block: string): boolean => /^gate:.+:(missing|stale)$/.test(block);
  if (changeId) for (const transition of governance?.readyTransitions ?? []) {
    const blocks: string[] = transition.blockedBy ?? [];
    if (blocks.length === 0 || !blocks.every(clearableByAdvance)) continue;
    const gates = blocks.map((block) => block.slice('gate:'.length, block.lastIndexOf(':')));
    nextActions.push({
      action: 'advance', type: 'transition', id: transition.to, actor: 'main', status: 'ready',
      inputs: ['current Change state'], writes: ['gate evidence', 'transition receipt'],
      doneWhen: [`Current Stage is ${transition.to}.`],
      requiredEvidence: ['current-revision Gate Evidence and a valid transition receipt'],
      reason: `Only Gates this Stage runs (${[...new Set(gates)].join(', ')}) stand between here and ${transition.to}. advance runs them and takes the Transition if none refuses, in one call instead of ${gates.length + 1}.`,
      command: ['xforge', 'advance', '--change', changeId, '--to', transition.to],
    });
  }
  /*
   * The receipt, when the receipt is what stands between this Stage and the next.
   *
   * This was four paragraphs of Skill prose -- what `finalize` writes, why it is not a shortcut
   * past the check, and that `draft-receipt` exists for the hand-assembled case. All of it was
   * resident in every verify Stage and re-sent on every turn of it, to be acted on at one moment.
   * A blocked transition already names the condition; the instruction belongs on that signal.
   *
   * `--by` ships as a placeholder and `--status` does not, which is not an inconsistency: they are
   * different kinds of field. `passed` is the only status `finalize` accepts -- anything else is
   * refused at `commands/verification.ts:586` -- so substituting it decides nothing. `--by` names
   * the person asserting it, is written to `finalizedBy` unvalidated, and is the one field an
   * Agent filling in for itself would be recording an authorisation nobody gave.
   */
  if (governance?.currentStage && changeId) {
    const blockedOnReceipt = (governance.readyTransitions ?? []).some((transition: any) =>
      (transition.blockedBy ?? []).some((item: string) => item.startsWith('condition:verificationReceipt:')));
    if (blockedOnReceipt) nextActions.push({
      action: 'finalize-verification', type: 'governance', actor: 'human', status: 'ready',
      inputs: ['this Stage\'s Gate Evidence at the current content revision'], writes: ['verification receipt'],
      doneWhen: ['The Stage\'s verificationReceipt exit condition is satisfied.'],
      requiredEvidence: ['current-revision verification receipt'],
      reason: `The verification receipt is what blocks this Stage. XForge already holds the change, contentRevision, gitHead and cited Gate set, and writes them from the same resolved Gate Evidence the exit condition is decided against — do not transcribe them, and do not assemble the receipt by hand. It is not a shortcut past the check: the Gate Evidence is re-read from disk first, and nothing is written if any cited Gate is stale, failed, or never ran. Supply --by yourself: it names the person asserting the verification, and is the field this command will not compute. Use \`xforge verification draft-receipt --change ${changeId}\` to compute the same facts without writing.`,
      command: ['xforge', 'verification', 'finalize', '--change', changeId, '--status', 'passed', '--by', '<the person asserting it>'],
    });
  }
  /* `ready-to-archive` is a synthetic terminal Stage, not one of `flow.stages`, so there is no
     Stage to read here. The archive authority comes from `flow.terminal.archive.authority`, which
     flow.schema.json pins to the const `archive-write` — this literal is the schema's only legal
     value for it, not a level invented at this call site. */
  if (governance?.currentStage === 'ready-to-archive') nextActions.push({
    action: 'archive', type: 'archive', actor: 'main', authority: 'archive-write', status: (governance.pendingApprovals ?? []).some((item: any) => item.transition === 'archive') ? 'blocked' : 'ready',
    inputs: ['current-revision verification, approval, gate, and audit evidence'], writes: ['canonical Specs', 'archived Change'],
    doneWhen: ['The Change is archived atomically and canonical Specs are synchronized.'], requiredEvidence: ['archive transaction result'],
    reason: 'The Change reached ReadyToArchive; terminal governance still applies.', command: ['xforge', 'archive', '--change', changeId!],
  });
  return nextActions;
}

/**
 * A mutating command's reply, with the post-condition attached.
 *
 * Every command here already returns its own `nextActions` where it has something specific to say --
 * a refusal's remedy, an approval the transition still needs. This adds what none of them said: where
 * the Change now stands and what its next Action is. The command's own entries come first, because
 * they are about what just happened; the state's follow.
 *
 * Resolving state costs one extra in-process read and saves the caller a round trip, which is the
 * trade this whole change is built on: a turn re-sends the entire conversation, a second file read
 * does not.
 */
async function withPostState(
  project: ProjectContext,
  changeId: string | undefined,
  result: { data?: unknown; diagnostics?: Diagnostic[]; changes?: FileChange[]; nextActions?: NextAction[] },
  dryRun?: boolean,
): Promise<{ data?: unknown; diagnostics?: Diagnostic[]; changes?: FileChange[]; nextActions: NextAction[] }> {
  const own = result.nextActions ?? [];
  /*
   * A rehearsal has no post-condition. `--dry-run` reports what a command *would* do and leaves the
   * Change exactly where it was, so the state after it is the state before it -- which the caller
   * either already has or can ask for. Attaching it would be the clearest case of the thing this
   * change exists to stop: paying to send data nobody reads.
   */
  if (dryRun) return { ...result, nextActions: own };
  /*
   * Nothing is attached to a refusal. A command that was refused changed nothing, so it has no
   * post-condition to report -- and a menu of onward moves printed under a refusal reads as though
   * some of them were now available. What the caller needs there is the refusal and its remedy,
   * which the command already returned.
   */
  if ((result.diagnostics ?? []).some((entry) => entry.severity === 'error')) return { ...result, nextActions: own };
  try {
    const state = await executeState(project, { change: changeId });
    const following = await nextActionsFor(project, state.data as Record<string, any>, changeId);
    /* De-duplicated on the identity a reader acts by. A command that already named the transition it
       just unblocked should not have the state repeat it as a second, identical entry. */
    const seen = new Set(own.map((entry) => `${entry.action}:${entry.id ?? ''}`));
    /*
     * Only what can be acted on. `state` lists blocked transitions too, because "why can I not go
     * forward" is a question it exists to answer; repeating them after every write would be the
     * unused half of every reply, and this whole change is an argument about not paying for data
     * nobody reads. A caller who wants the blocked set asks `state` for it.
     */
    const actionable = following.filter((entry) => entry.status === undefined || entry.status === 'ready' || entry.status === 'pending');
    return { ...result, nextActions: [...own, ...actionable.filter((entry) => !seen.has(`${entry.action}:${entry.id ?? ''}`))] };
  } catch {
    /* A state that cannot resolve after a write is itself worth not hiding, but it is the command's
       result that the caller asked for -- returning it unadorned beats failing the whole call. */
    return { ...result, nextActions: own };
  }
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
    /*
     * The two calls every Stage ends with, made one.
     *
     * Across twelve measured Stages the count of governance calls that actually move the Change was
     * fixed -- two at Propose, three at Check and Verify -- and `check` immediately followed by
     * `transition` was in every one of them. That pairing is not a habit an instruction created; it
     * is what the Flow requires, because Gate Evidence binds to the content revision and a
     * Transition refuses without it.
     *
     * What this deliberately does not do is merge the records. The Gate run writes its Evidence and
     * the Transition writes its receipt, separately, with the same digests and the same audit
     * entries as when a person runs both by hand. Collapsing them into one record would make "the
     * Gate passed" and "the Stage moved" indistinguishable, which is the one thing a governance
     * chain must never lose. A Gate that fails refuses the Transition and names itself.
     */
    const gates = await executeCheck(project, { change: parsed.change });
    const refusing = gates.diagnostics.filter((entry) => entry.severity === 'error');
    const state = await executeState(project, { change: parsed.change });
    const governance = (state.data as any)?.change?.governance;
    const ready = (governance?.readyTransitions ?? []).filter((entry: any) => entry.ready);
    const target = parsed.to ?? (ready.length === 1 ? ready[0].to : undefined);

    if (refusing.length > 0) {
      return envelope({
        command, root: project.root, ok: false,
        data: { change: parsed.change, stage: governance?.currentStage ?? null, transitioned: null, gates: (gates.data as any)?.gates ?? [] },
        diagnostics: [...gates.diagnostics, diagnostic(
          'XFORGE_ADVANCE_GATES_REFUSED',
          `Gates refused, so no Transition was attempted and no receipt was written: ${refusing.map((entry) => entry.code).join(', ')}. Fix what they name and run advance again.`,
          `${(state.data as any)?.change?.path ?? ''}`,
        )],
        nextActions: gates.nextActions,
      });
    }
    if (!target) {
      const blocked = (governance?.readyTransitions ?? []).flatMap((entry: any) => entry.blockedBy ?? []);
      return envelope({
        command, root: project.root,
        data: { change: parsed.change, stage: governance?.currentStage ?? null, transitioned: null, gates: (gates.data as any)?.gates ?? [], blockedBy: blocked },
        diagnostics: [...gates.diagnostics, diagnostic(
          'XFORGE_ADVANCE_NO_READY_TRANSITION',
          ready.length > 1
            ? `Gates passed and more than one Transition is ready (${ready.map((entry: any) => entry.to).join(', ')}); name one with --to. Choosing between a forward move and a rework route is not a default this can pick.`
            : `Gates passed and no Transition is ready${blocked.length ? `: ${blocked.join(', ')}` : ''}. Nothing was written.`,
          `${(state.data as any)?.change?.path ?? ''}`,
          'info',
        )],
        nextActions: await nextActionsFor(project, state.data as Record<string, any>, parsed.change),
      });
    }
    const moved = await executeTransition(project, { change: parsed.change!, to: target, dryRun: parsed.dryRun });
    const after = await withPostState(project, parsed.change, moved, parsed.dryRun);
    /*
     * `transitioned` reports what happened, not what was attempted.
     *
     * It was set to the target unconditionally, so a Transition the CLI had just refused came back
     * as `transitioned: "design"` with the refusal sitting in the diagnostics beside it. The refusal
     * itself was correct -- `executeTransition` blocks on missing Artifacts exactly as it does when
     * run by hand -- but a caller reading the field it was given would have believed the Change
     * moved. A merged command that misreports its own outcome is worse than the two calls it saves.
     */
    const refused = (moved.diagnostics ?? []).some((entry) => entry.severity === 'error');
    return envelope({
      command, root: project.root,
      data: { change: parsed.change, transitioned: refused ? null : target, gates: (gates.data as any)?.gates ?? [], transition: after.data },
      diagnostics: [...gates.diagnostics, ...(after.diagnostics ?? [])],
      changes: after.changes,
      nextActions: after.nextActions,
    });
  }
  if (command === 'stage') {
    /*
     * One reply instead of a Stage's worth of questions.
     *
     * Measured over twelve runs of three Stages, 70% of every call was orientation: opening the
     * Change's files, re-listing the directory, and asking `state` again. None of it is optional
     * work — an Agent cannot write the next Artifact without its inputs — but all of it was being
     * paid for one turn at a time, and a turn re-sends the whole conversation while a second read
     * inside one process does not.
     *
     * So this composes what was already computable: the reading plan and its text from
     * `stage-bundle`, the resolved state, and the Action that is ready with everything the author
     * needs to satisfy it. The parts are unchanged; what changes is that they arrive together.
     */
    const bundle = await executeStageBundle(project, {
      change: parsed.change!,
      content: parsed.content as 'none' | 'changed' | 'full' | undefined,
    });
    const state = await executeState(project, { change: parsed.change });
    const actions = await nextActionsFor(project, state.data as Record<string, any>, parsed.change);
    const change = (state.data as any)?.change ?? null;
    /*
     * The Artifact this Stage owes, computed from the Stage rather than borrowed from `nextArtifact`.
     *
     * `nextArtifact` is scoped to the planning Artifacts — everything a Flow produces before `apply`
     * — because that is what it was built for. At Verify that leaves it null while the Stage plainly
     * owes an `assurance`, so the working set answered "no Action" at a Stage that has one, which is
     * worse than the prose it replaced. A Stage-scoped command should answer from the Stage's own
     * `produces`, and that is also the more general rule: it happens to agree with `nextArtifact`
     * everywhere `nextArtifact` applies.
     */
    /* From the receipts state already resolved, not a second walk: `control-plane` computes this
       same set to validate against, and a Change with neither receipts nor commits has none —
       which is itself the answer a ledger author needs. */
    const identities = await knownIdentities(project, parsed.change!, (change?.governance?.approvals ?? []) as never)
      .then((known) => [...known.values].sort())
      .catch(() => []);
    const stageProduces = new Set(flowStages(state.data as Record<string, unknown>, change?.flow).find((entry) => entry.id === bundle.data.stage)?.produces ?? []);
    let ready = actions.find((entry) => entry.type === 'artifact' && entry.status === 'ready') ?? null;
    if (!ready) {
      const owed = (change?.artifacts ?? []).find((artifact: any) => stageProduces.has(artifact.id) && artifact.status === 'ready');
      if (owed) {
        const sections = String(owed.generates ?? '').includes('*') ? [] : outlineSections(owed.outline ?? '');
        ready = {
          action: 'create-artifact', type: 'artifact', id: owed.id, actor: 'main', status: 'ready',
          inputs: (owed.requires ?? []).flatMap((required: string) => {
            const dependency = (change?.artifacts ?? []).find((artifact: any) => artifact.id === required);
            if (!dependency) return [];
            if (dependency.outputPaths?.length && change?.path) return dependency.outputPaths.map((output: string) => `${change.path}/${output}`);
            return dependency.writePath ? [dependency.writePath] : [];
          }),
          writes: owed.outputPaths?.length ? owed.outputPaths : [owed.writePath].filter(Boolean),
          ...(sections.length > 0 ? { requiredSections: sections } : {}),
          doneWhen: [`Artifact ${owed.id} exists and satisfies the active Flow instructions.`],
          requiredEvidence: ['xforge state reports the artifact as done for the current Change revision.'],
          reason: `Stage ${bundle.data.stage} produces ${owed.id}, and it is not written yet.`,
        };
      }
    }
    /*
     * The budget is on the reply, because the reply is what has to arrive.
     *
     * It was on the read bytes, which is not the same number: a plan of 15.7KB of file contents
     * assembles into a 25.8KB reply once the Action, the outlines of everything else the Stage owes,
     * the Stage's declarations and the diagnostics are around it. That passed a 24KB content budget
     * and then overflowed the host anyway — a measured run spent two calls reading its own spilled
     * output back, which is the exact failure the guard was added to prevent, one layer up.
     *
     * So it is measured here, where the whole payload exists, and the contents are the part that
     * gives way: everything else in this reply is what the caller cannot reconstruct from disk.
     */
    const stageData = {
        change: parsed.change,
        flow: change?.flow ?? null,
        stage: bundle.data.stage,
        revision: change?.governance?.revision ?? null,
        action: ready,
        /*
         * Every Artifact this Stage still owes, with its shape — not just the one that is ready.
         *
         * The Check Stage produces three, and this described one. The other two are ledgers whose
         * whole content is a YAML shape, and that shape lived only in the Flow file — so all four
         * measurement runs opened `xforge/flows/solid.yaml` right after calling this, each slicing
         * the artifacts section. Reporting `produces: [a, b, c]` without saying what b and c are is
         * a list of names, and a name is not something you can write from.
         *
         * The same mistake one level in from the last one: the ready Action was taken from
         * `nextArtifact`, which stops before `apply`, and was fixed by reading the Stage's own
         * `produces`. This reads all of them rather than the first.
         */
        owes: (change?.artifacts ?? [])
          .filter((artifact: any) => (stageProduces.has(artifact.id)) && artifact.status !== 'done')
          .map((artifact: any) => ({
            id: artifact.id,
            status: artifact.status,
            writes: artifact.outputPaths?.length ? artifact.outputPaths : [artifact.writePath].filter(Boolean),
            description: artifact.description ?? null,
            instruction: artifact.instruction ?? null,
            outline: artifact.outline ?? null,
            requiredSections: String(artifact.generates ?? '').includes('*') ? [] : outlineSections(artifact.outline ?? ''),
            missingDependencies: artifact.missingDependencies ?? [],
          })),
        otherActions: actions.filter((entry) => entry !== ready),
        blockedBy: (change?.governance?.readyTransitions ?? []).flatMap((entry: any) => entry.blockedBy ?? []),
        /*
         * What this Stage declares, so the Flow file does not have to be opened to find out.
         *
         * Twenty recorded runs read `xforge/flows/*.yaml` twelve times for 132KB — 12% of every
         * byte that entered context through a file read — to learn an outline or which Gates a
         * Stage runs. `owes` already carries the outline -- the Action does not, and this comment
         * said it did until an audit read the two against `NextAction`; this carries the rest of
         * what a Stage is, which is the other half of the question those reads were asking.
         */
        stageDeclares: (() => {
          const definition = flowStages(state.data as Record<string, unknown>, change?.flow).find((entry) => entry.id === bundle.data.stage);
          return definition
            ? {
              produces: definition.produces ?? [],
              gates: [...new Set([...(definition.gates ?? []), ...(definition.exit?.gates ?? [])])],
              exitConditions: Object.keys(definition.exit?.conditions ?? {}),
              reworkTo: definition.reworkTo ?? [],
              authority: definition.authority ?? null,
            }
            : null;
        })(),
        /*
         * Which names a ledger will accept, said by the only thing that knows.
         *
         * `resolvedBy`, `decidedBy` and `approvedBy` are checked against the approvers on this
         * Change's receipts and its Git authors, and a name outside that set is refused. Nothing
         * reported the set, so all four measurement runs worked it out the same way — `git log
         * --format='%an <%ae>' | sort -u` — reconstructing by hand a list the CLI holds in memory
         * while it validates against it.
         *
         * Reporting it does not widen what is accepted; the check is unchanged. It stops an author
         * having to guess at the bar they are being held to, which is how a ledger ends up naming
         * somebody who is not there.
         */
        /*
       * What this Stage's work actually is, when the work is not an Artifact.
       *
       * `apply` produces nothing in the Flow's sense, so a working set organised around `produces`
       * told it "no Artifact is ready" and stopped — on the Stage that carries the largest share of
       * the work in the whole flow: dispatch, parallel workers, delivery records, integration,
       * done_when evidence. The plan for all of it is `work-packages.yaml`, which appeared in the
       * reading list as one more file with a digest beside it, named as nothing in particular.
       *
       * The CLI already resolves every part of this to answer `state`: which packages are ready,
       * what each one may write, what it must satisfy, which can run at once, and which paths no
       * package accounts for. The same mistake as the last two — reporting a Stage by its Artifacts
       * when the Stage's substance is somewhere else.
       */
      work: change?.workPackages
        ? {
          path: change.workPackages.path,
          baseCommit: change.workPackages.baseCommit,
          ready: change.workPackages.ready ?? [],
          waves: change.workPackages.waves ?? [],
          parallelCandidates: change.workPackages.parallelCandidates ?? [],
          protectedWritePaths: change.workPackages.protectedWritePaths ?? [],
          unattributedPaths: change.workPackages.unattributedPaths ?? [],
          packages: (change.workPackages.packages ?? []).map((entry: any) => ({
            id: entry.id,
            status: entry.status,
            role: entry.role ?? null,
            goal: entry.goal,
            dependsOn: entry.depends_on ?? [],
            inputs: entry.inputs ?? [],
            writePaths: entry.write_paths ?? [],
            verify: entry.verify ?? [],
            doneWhen: entry.done_when ?? [],
            missingDependencies: entry.missingDependencies ?? [],
            delivered: Boolean(entry.delivery),
            acknowledgements: entry.acknowledgements ?? null,
          })),
        }
        : null,
      ledgerIdentities: identities,
        since: bundle.data.since,
        worktreeClean: bundle.data.worktreeClean,
        read: bundle.data.read,
        vouched: bundle.data.vouched,
      bytes: bundle.data.bytes,
    };
    /*
     * The budget is on the reply, because the reply is what has to arrive.
     *
     * It was on the read bytes, which is a different number: 15.7KB of file contents assembles into
     * a 25.8KB reply once the Action, the outlines of everything else the Stage owes, the Stage's
     * declarations and the diagnostics are around it. That passed a content budget and overflowed
     * the host anyway — a measured run spent two calls reading its own spilled output back, which is
     * the failure the guard exists to prevent.
     *
     * The contents give way and nothing else does: everything else here is what a caller cannot
     * reconstruct from disk, while the contents are files it can open. `--content full` is still
     * honoured, because that caller asked.
     */
    /*
     * A ready work package's declared `inputs` are read here, whether or not they changed.
     *
     * `stage-bundle` decides what to send by what *moved* since the Stage was entered, which is the
     * right rule for an Artifact and the wrong one at Apply: the delta Spec and the Design were
     * written two Stages ago and have not moved since, so they were vouched for with a digest and a
     * heading list while being exactly the two files the Worker cannot write a line without. All
     * four baseline runs opened them by hand, 3-4 calls each, and the alternative on offer --
     * `--content full` -- also sends the proposal, the check report, and change.yaml, which Apply
     * does not read.
     *
     * The plan already names what this Stage's work needs. Nothing has to be guessed, and it stays
     * scoped to the packages that are actually ready, so a large plan does not send every input for
     * work that has not started.
     */
    if (change?.workPackages) {
      const readyIds = new Set(change.workPackages.ready ?? []);
      const declared = new Set<string>();
      for (const entry of (change.workPackages.packages ?? []) as Array<{ id: string; inputs?: string[] }>) {
        if (!readyIds.has(entry.id)) continue;
        for (const input of entry.inputs ?? []) declared.add(input);
      }
      const carried = new Set(stageData.read.map((entry) => entry.path));
      for (const relative of declared) {
        if (carried.has(relative)) continue;
        try {
          const source = await readFile(await safeResolve(project.root, relative), 'utf8');
          stageData.read.push({ path: relative, reason: 'declared-input', ...(parsed.content === 'none' ? {} : { text: source }) });
          stageData.bytes.read += Buffer.byteLength(source);
        } catch {
          /* An input the plan names but the tree does not have is the plan's problem, and
             `check` already reports it as one. Saying it twice here would not help. */
          continue;
        }
      }
      stageData.vouched = stageData.vouched.filter((entry) => !declared.has(entry.path));
    }
    const stageDiagnostics = [...bundle.diagnostics, ...state.diagnostics];
    const BUDGET = 20_000;
    /*
     * Measured on what is sent, not on `data` alone.
     *
     * The budget existed to keep the reply small enough to arrive, but it sized `stageData` while
     * the envelope also carries the diagnostics and `nextActions` -- about 4.5KB at Apply. So a
     * reply measured at 15.7KB went out at 20.2KB, past the 20KB it had just declared itself under.
     * The comment above says the budget is on the reply; this makes that true.
     */
    const measure = () => JSON.stringify({ data: stageData, diagnostics: stageDiagnostics, nextActions: actions }).length;
    const size = measure();
    if (parsed.content !== 'full' && size > BUDGET) {
      /*
       * Shed the largest first, and keep whatever still fits.
       *
       * This dropped every text the moment one file pushed the reply over, so a 12KB Design took
       * the 3KB Constitution down with it and the caller opened both. Nothing about the budget
       * requires that: the reply is too big by some amount, and dropping the biggest contributor
       * usually clears it while the small load-bearing files still arrive. The caller opens what
       * the diagnostic names, which is now a shorter list than it was.
       */
      const dropped: string[] = [];
      const order = stageData.read
        .map((entry, index) => ({ index, size: typeof entry.text === 'string' ? entry.text.length : 0 }))
        .filter((entry) => entry.size > 0)
        .sort((left, right) => right.size - left.size);
      /*
       * Re-measured after each drop rather than subtracted.
       *
       * Subtracting the raw text length under-counts what the text costs once it is JSON-escaped --
       * by about 4KB on the Apply reply -- so the loop stopped one file early and the reply went out
       * 231 bytes over the budget it had just announced it was under. The number is also printed,
       * and a printed number that was never measured is the failure this codebase keeps meeting.
       * Serialising a handful of times costs nothing next to being wrong about it.
       */
      let current = size;
      for (const candidate of order) {
        if (current <= BUDGET) break;
        const entry = stageData.read[candidate.index]!;
        dropped.push(entry.path);
        delete (entry as { text?: string }).text;
        current = measure();
      }
      if (dropped.length > 0) stageDiagnostics.push(diagnostic(
        'XFORGE_STAGE_CONTENT_OVER_BUDGET',
        `This reply would be ${size} bytes, past the ${BUDGET} that reliably arrives inline, so the largest contents were left out until it fit -- it is now about ${current}. Everything else under READ still carries its text. Open these, or ask for --content full: ${dropped.join(', ')}.`,
        `${change?.path ?? ''}`,
        'info',
      ));
    }
    return envelope({
      command,
      root: project.root,
      data: stageData,
      diagnostics: stageDiagnostics,
      nextActions: actions,
    });
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
      process.stdout.write(`${JSON.stringify((result.data as any)?.platformOutput ?? {})}\n`);
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

  if (parsed?.field) {
    const paths = parsed.fields ?? [parsed.field];
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
      /*
       * The values that did resolve, kept -- while the call still fails.
       *
       * Not the whole envelope: the caller narrowed to these values and named one wrongly, and
       * answering with the entire resolved project costs an Agent ~12K tokens of context for a typo.
       * But `data: null` threw away the correct answers too, and a caller that wanted four values
       * and mistyped one had to ask again for the three it had already been given. Across one
       * measured `solid` run that happened five times and discarded fifteen resolved values -- once
       * eight of ten, for two bad paths.
       *
       * The rule this is often mistaken for is worth stating exactly. `resolutions` is computed for
       * every path before anything prints, so a partial answer is never dressed as a whole one; what
       * must not happen is a caller "receiving three of four values and a zero exit" and carrying on
       * as though it had four. The danger there is the exit code, not the data. `ok` stays false,
       * the exit stays 1, and every missing path still gets its own diagnostic -- so the reply
       * cannot read as success, and the work already done is not thrown away with the typo.
       */
      const resolved = resolutions.filter((item) => item.resolved.found);
      process.stdout.write(present({
        ...result, ok: false,
        data: resolved.length > 0
          ? Object.fromEntries(resolved.map((item) => [item.path, (item.resolved as { value: unknown }).value]))
          : null,
        diagnostics: [...result.diagnostics, ...failed.map((item) => diagnostic(
          'XFORGE_FIELD_NOT_FOUND',
          /* `--text` no longer prints `data` verbatim for every command, so the advice names both
             flags: the shape lives in the JSON envelope, which is what dropping them returns. */
          `No value at --field ${item.path}. ${(item.resolved as { reason: string }).reason} The paths that did resolve are under data; run the command without --field and without --text to see the shape of the rest.`,
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
