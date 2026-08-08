#!/usr/bin/env node
import process from 'node:process';
import { TARGETS, type TargetId } from './constants.js';
import { executeArchive } from './commands/archive.js';
import { executeCheck } from './commands/check.js';
import { executeInstall } from './commands/install.js';
import { executeState } from './commands/state.js';
import { XForgeError, diagnostic } from './core/errors.js';
import { loadProject } from './core/project-loader.js';
import { envelope, present } from './protocol/envelope.js';
import type { Diagnostic, Envelope, NextAction } from './types.js';

type CommandName = 'state' | 'install' | 'check' | 'archive';

interface ParsedArguments {
  command: string;
  text: boolean;
  dryRun: boolean;
  change?: string;
  kind?: 'skills' | 'agents' | 'rules' | 'hooks' | 'gates' | 'scripts';
  target?: TargetId;
  gate?: string;
}

const VALID_KINDS = ['skills', 'agents', 'rules', 'hooks', 'gates', 'scripts'] as const;

function parseArguments(argv: string[]): ParsedArguments {
  const command = argv[0] ?? '';
  const parsed: ParsedArguments = { command, text: false, dryRun: false };
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith('--')) throw new XForgeError(diagnostic('XFORGE_ARGUMENT_UNEXPECTED', `Unexpected positional argument: ${flag}`));
    if (seen.has(flag)) throw new XForgeError(diagnostic('XFORGE_ARGUMENT_DUPLICATE', `Duplicate option: ${flag}`));
    seen.add(flag);
    if (flag === '--text') { parsed.text = true; continue; }
    if (flag === '--dry-run') { parsed.dryRun = true; continue; }
    if (!['--change', '--kind', '--target', '--gate'].includes(flag)) {
      throw new XForgeError(diagnostic('XFORGE_OPTION_UNKNOWN', `Unknown option: ${flag}`));
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new XForgeError(diagnostic('XFORGE_OPTION_VALUE_MISSING', `Option requires a value: ${flag}`));
    index += 1;
    if (flag === '--change') parsed.change = value;
    if (flag === '--gate') parsed.gate = value;
    if (flag === '--kind') {
      if (!VALID_KINDS.includes(value as (typeof VALID_KINDS)[number])) throw new XForgeError(diagnostic('XFORGE_KIND_UNKNOWN', `Unknown resource kind: ${value}`));
      parsed.kind = value as ParsedArguments['kind'];
    }
    if (flag === '--target') {
      if (!TARGETS.includes(value as TargetId)) throw new XForgeError(diagnostic('XFORGE_TARGET_UNKNOWN', `Unknown target: ${value}`));
      parsed.target = value as TargetId;
    }
  }

  const allowed: Record<CommandName, string[]> = {
    state: ['--text', '--change', '--kind', '--target'],
    install: ['--text', '--dry-run', '--target'],
    check: ['--text', '--change', '--gate'],
    archive: ['--text', '--dry-run', '--change'],
  };
  if (!(command in allowed)) {
    throw new XForgeError(diagnostic(
      command ? 'XFORGE_COMMAND_UNKNOWN' : 'XFORGE_COMMAND_REQUIRED',
      command ? `Unknown command: ${command}. XForge v1 supports state, install, check, and archive.` : 'A command is required: state, install, check, or archive.',
    ));
  }
  for (const flag of seen) {
    if (!allowed[command as CommandName].includes(flag)) throw new XForgeError(diagnostic('XFORGE_OPTION_NOT_ALLOWED', `${flag} is not valid for ${command}.`));
  }
  if (command === 'archive' && !parsed.change) throw new XForgeError(diagnostic('XFORGE_CHANGE_REQUIRED', 'archive requires --change <id>.'));
  return parsed;
}

async function dispatch(parsed: ParsedArguments): Promise<Envelope> {
  const project = await loadProject();
  const command = parsed.command as CommandName;
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
    const command = parsed?.command ?? argv[0] ?? '';
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
  process.stdout.write(present(result, parsed?.text ?? argv.includes('--text')));
  return result.ok ? 0 : 1;
}

process.exitCode = await runCli();
