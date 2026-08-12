export const CLI_NAME = '@xforge/cli';
export const CLI_VERSION = '0.7.8';
export const PROTOCOL_VERSION = '2';
export const API_VERSION = 'xforge.dev/v1alpha2';

export const TARGETS = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'github-copilot',
] as const;

export type TargetId = (typeof TARGETS)[number];

export const GENERATED_ROOTS = [
  '.agents',
  '.codex',
  '.claude',
  '.cursor',
  '.opencode',
  '.github',
] as const;

export const DEFAULT_SPECS_PATH = 'xforge/specs';
export const DEFAULT_CHANGES_PATH = 'xforge/changes';
export const MAX_GATE_OUTPUT_BYTES = 65_536;
export const WORK_PACKAGE_VERIFY_TIMEOUT_SECONDS = 900;
