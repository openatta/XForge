import { TARGETS, type TargetId } from '../constants.js';
import { STATE_SECTIONS, type StateSection } from '../core/state-reader.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { parseScaffoldLanguage } from '../core/language.js';
import { envelope } from '../protocol/envelope.js';
import type { Envelope, ScaffoldLanguage } from '../types.js';

/**
 * The command line: what the options are, what each command requires of them, and the help that
 * describes both.
 *
 * Separated from `cli.ts` because that file was doing three unrelated jobs — parsing argv, routing
 * a parsed command to the layer that answers it, and rendering the answer — and only the middle
 * one is what a reader opens `cli.ts` to find. Nothing here changed in the move: the option tables,
 * the duplicate guard, the group-command help resolution and the per-command requirement checks are
 * the same code, in the file whose subject they are.
 *
 * The requirement checks stay written out as statements rather than folded into a table. Most of
 * them carry a message that says *why* the option is required — `verification declare` explains
 * that nothing can decide mechanically whether a command verifies anything — and a table of
 * (command, option, message) triples would keep the message and lose the sentence it belongs to.
 */

export type CommandName = 'help' | 'version' | 'init' | 'state' | 'install' | 'sync' | 'update' | 'uninstall' | 'check' | 'stage' | 'advance' | 'stage-bundle' | 'explain' | 'verification' | 'transition' | 'approve' | 'audit' | 'work-package' | 'hook' | 'archive' | 'doctor' | 'upgrade-scaffold' | 'review' | 'findings' | 'contract';

export interface ParsedArguments {
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
  /**
   * Every `--field` on the line, in order.
   *
   * One array and no scalar beside it. A `field` holding the last value survived the move to
   * repeatable `--field` as the "untouched single-value path", and by then nothing took that path:
   * the two were written together and read as `fields ?? [field]`, whose right-hand side could not
   * be reached because an option value is refused when it is empty. Two fields that cannot disagree
   * are one field and a second thing to keep in step.
   */
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
export function commandPosition(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) return token;
    if (isValueOption(token)) index += 1;
  }
  return undefined;
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
export function recoveredHookTarget(argv: string[]): TargetId {
  const value = optionValue(argv, '--target');
  /* Last resort only. codex and claude render an identical deny, so this single fallback covers
     both; every other target is reached through the recovery above, since the installed hook
     command always passes `--target` (see adapters/governance.ts). */
  return TARGETS.includes(value as TargetId) ? value as TargetId : 'claude';
}

export function recoveredHookEvent(argv: string[]): string {
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
  stage: { usage: 'xforge [--root <path>] stage --change <id> [--content <none|changed|full>] [--text] [--field <path>]...', description: 'Everything this Stage needs, in one reply: where the Change stands, the Action that is ready with its writes, sections, instruction and outline, the text of that Action\'s inputs, the Constitution, and the diagnostics. --content names how much arrives as text and nothing else. The default is none: the reply names the inputs, gives each one\'s size and section headings, and says which moved since the Stage began, without sending any of them. It was changed once — the Stage\'s own outputs, whatever moved, and the Constitution, with their text — and a measured Solid run delivered 75,774 bytes that way and then watched the Agent re-open the same documents 29 times for 220,839 bytes more, so both copies sat in context and the second cost 3.3x the first. changed and full still do what they say; full gives up the digest vouchers and sends everything. One exception the default keeps: a ready work package\'s declared inputs travel with their text unless you ask for none explicitly, because at Apply they are what the work is written from. It is an intent, not a field list — a caller that has to enumerate what it needs on the way in is being asked the question it came here to have answered. --field is for the way back out: the same dotted-path selection every other read command takes, for re-reading one value from a reply already received. Withholding it did not stop callers narrowing this reply, it stopped them narrowing it cheaply -- a measured run read one stage reply with two calls, `| head -c 6000` then `| tail -c 4500`, the second re-running the whole command, and hand-parsed it with python on a third.', options: ['--root', '--change', '--content', '--text', '--field'] },
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

export function parseArguments(argv: string[]): ParsedArguments {
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
    if (token === '--field') (parsed.fields ??= []).push(value);
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
      ? ['propose', 'clarify', 'design', 'check', 'apply', 'verify', 'status', 'revise', 'scaffold', 'kanban', 'upgrade-scaffold'].includes(parsed.command)
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
export function helpEnvelope(subject?: string, subcommand?: string): Envelope {
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