#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { CLI_NAME, CLI_VERSION, PROTOCOL_VERSION, TARGETS, type TargetId } from './constants.js';
import { executeArchive } from './commands/archive.js';
import { executeCheck } from './commands/check.js';
import { executeInstall } from './commands/install.js';
import { executeState } from './commands/state.js';
import { executeSync } from './commands/sync.js';
import { executeUninstall } from './commands/uninstall.js';
import { executeUpdate } from './commands/update.js';
import { XForgeError, diagnostic } from './core/errors.js';
import { actualGitIdentity, runtimeCliIntegrity } from './core/identity.js';
import { loadProject } from './core/project-loader.js';
import { envelope, present } from './protocol/envelope.js';
import type { Diagnostic, Envelope, NextAction } from './types.js';

type CommandName = 'help' | 'version' | 'state' | 'install' | 'sync' | 'update' | 'uninstall' | 'check' | 'archive';

interface ParsedArguments {
  command: string;
  text: boolean;
  dryRun: boolean;
  verifyDigests: boolean;
  root?: string;
  helpCommand?: string;
  change?: string;
  kind?: 'skills' | 'agents' | 'rules' | 'hooks' | 'gates' | 'scripts';
  target?: TargetId;
  gate?: string;
}

const COMMANDS: CommandName[] = ['help', 'version', 'state', 'install', 'sync', 'update', 'uninstall', 'check', 'archive'];
const VALID_KINDS = ['skills', 'agents', 'rules', 'hooks', 'gates', 'scripts'] as const;
const VALUE_OPTIONS = ['--root', '--change', '--kind', '--target', '--gate'] as const;

const HELP: Record<CommandName, { usage: string; description: string; options: string[] }> = {
  help: { usage: 'xforge help [command] [--text]', description: 'Show general or command-specific help.', options: ['--text'] },
  version: { usage: 'xforge version [--text]', description: 'Show CLI, protocol, runtime, and build identity.', options: ['--text'] },
  state: { usage: 'xforge [--root <path>] state [--change <id>] [--kind <kind>] [--target <target>] [--text]', description: 'Read resolved project and Change state.', options: ['--root', '--change', '--kind', '--target', '--text'] },
  install: { usage: 'xforge [--root <path>] install [--target <target>] [--dry-run] [--text]', description: 'Install or idempotently reconcile selected project assets.', options: ['--root', '--target', '--dry-run', '--text'] },
  sync: { usage: 'xforge [--root <path>] sync [--target <target>] [--dry-run] [--verify-digests] [--text]', description: 'Incrementally sync localized Scaffold changes to installed targets.', options: ['--root', '--target', '--dry-run', '--verify-digests', '--text'] },
  update: { usage: 'xforge [--root <path>] update [--target <target>] [--dry-run] [--text]', description: 'Fully reconcile installed targets, identities, and Adapter output.', options: ['--root', '--target', '--dry-run', '--text'] },
  uninstall: { usage: 'xforge [--root <path>] uninstall [--target <target>] [--dry-run] [--text]', description: 'Safely remove digest-matching managed target files.', options: ['--root', '--target', '--dry-run', '--text'] },
  check: { usage: 'xforge [--root <path>] check [--change <id>] [--gate <id>] [--text]', description: 'Validate project structure, deliveries, and Gates.', options: ['--root', '--change', '--gate', '--text'] },
  archive: { usage: 'xforge [--root <path>] archive --change <id> [--dry-run] [--text]', description: 'Verify, merge Specs, and atomically archive a Change.', options: ['--root', '--change', '--dry-run', '--text'] },
};

function parseArguments(argv: string[]): ParsedArguments {
  const parsed: ParsedArguments = { command: '', text: false, dryRun: false, verifyDigests: false };
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
    if (!VALUE_OPTIONS.includes(token as (typeof VALUE_OPTIONS)[number])) {
      throw new XForgeError(diagnostic('XFORGE_OPTION_UNKNOWN', `Unknown option: ${token}`));
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new XForgeError(diagnostic('XFORGE_OPTION_VALUE_MISSING', `Option requires a value: ${token}`));
    index += 1;
    if (token === '--root') parsed.root = value;
    if (token === '--change') parsed.change = value;
    if (token === '--gate') parsed.gate = value;
    if (token === '--kind') {
      if (!VALID_KINDS.includes(value as (typeof VALID_KINDS)[number])) throw new XForgeError(diagnostic('XFORGE_KIND_UNKNOWN', `Unknown resource kind: ${value}`));
      parsed.kind = value as ParsedArguments['kind'];
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
  } else {
    parsed.command = positionals[0] ?? '';
    if (parsed.command === 'help') {
      parsed.helpCommand = positionals[1];
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
  return parsed;
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
      buildIdentity: actualGitIdentity(),
      integrity: runtimeCliIntegrity(),
    },
  });
}

async function dispatch(parsed: ParsedArguments): Promise<Envelope> {
  if (parsed.command === 'help') return helpEnvelope(parsed.helpCommand);
  if (parsed.command === 'version') return versionEnvelope();

  const root = parsed.root ? path.resolve(process.cwd(), parsed.root) : process.cwd();
  const project = await loadProject(root, { exactRoot: Boolean(parsed.root) });
  const command = parsed.command as Exclude<CommandName, 'help' | 'version'>;
  if (command === 'state') {
    const result = await executeState(project, { change: parsed.change, kind: parsed.kind, target: parsed.target });
    const nextActions: NextAction[] = [];
    if (project.compatibility.mode === 'portable') nextActions.push({ action: 'resolve-declared-xforge', reason: 'Managed operations require the exact declared CLI identity.' });
    const stateChange = (result.data.change ?? null) as { nextArtifact?: { id?: string } | null } | null;
    if (stateChange?.nextArtifact?.id && parsed.change) nextActions.push({ action: 'create-artifact', reason: `Next Flow Artifact is ${stateChange.nextArtifact.id}.` });
    return envelope({ command, root: project.root, data: result.data, diagnostics: result.diagnostics, nextActions });
  }
  if (command === 'install') {
    const result = await executeInstall(project, { target: parsed.target, dryRun: parsed.dryRun });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'sync') {
    const result = await executeSync(project, { target: parsed.target, dryRun: parsed.dryRun, verifyDigests: parsed.verifyDigests });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'update') {
    const result = await executeUpdate(project, { target: parsed.target, dryRun: parsed.dryRun });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'uninstall') {
    const result = await executeUninstall(project, { target: parsed.target, dryRun: parsed.dryRun });
    return envelope({ command, root: project.root, ...result });
  }
  if (command === 'check') {
    const result = await executeCheck(project, { change: parsed.change, gate: parsed.gate });
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
  const textMode = parsed?.text ?? argv.some((item) => ['--text', '--help', '--version'].includes(item));
  process.stdout.write(present(result, textMode));
  return result.ok ? 0 : 1;
}

process.exitCode = await runCli();
