/**
 * Built-in environment allowlist for subprocesses XForge starts on the user's behalf (Gates and
 * MCP approval servers). They never inherit the ambient environment: this is enough for the
 * shipped commands to work on a developer machine, in CI, and behind a corporate proxy, without
 * becoming a blanket passthrough.
 */
export const DEFAULT_SUBPROCESS_ENV_ALLOW = [
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'TMPDIR', 'TEMP', 'TMP',
  'SystemRoot', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'OS',
  'CI', 'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

/** `npm_config_*` carries registry/cache/proxy settings; credential-shaped names are filtered below. */
export const DEFAULT_SUBPROCESS_ENV_PREFIXES = ['npm_config_', 'NPM_CONFIG_'];

/** Never inherited, from any source: a resource manifest cannot opt a credential back in. */
export const SUBPROCESS_ENV_DENY = /(?:password|passwd|secret|token|api[_-]?key|auth|credential|cookie|session|private[_-]?key)/i;

export interface SubprocessEnvExtras {
  /** Extra exact variable names the subprocess may inherit, on top of the built-in allowlist. */
  allow?: string[];
  /** Extra variable-name prefixes the subprocess may inherit, on top of the built-in prefixes. */
  allowPrefixes?: string[];
  /** Always set in the child, bypassing the allow/deny filter (e.g. XFORGE_MCP_TOKEN). */
  force?: Record<string, string | undefined>;
}

/** Builds the filtered environment a subprocess receives: allowlist + prefixes, minus denylist, plus forced entries. */
export function buildSubprocessEnvironment(extras: SubprocessEnvExtras = {}): Record<string, string> {
  const allow = new Set([...DEFAULT_SUBPROCESS_ENV_ALLOW, ...(extras.allow ?? [])]);
  const prefixes = [...DEFAULT_SUBPROCESS_ENV_PREFIXES, ...(extras.allowPrefixes ?? [])];
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || value === '') continue;
    if (SUBPROCESS_ENV_DENY.test(name)) continue;
    if (!allow.has(name) && !prefixes.some((prefix) => prefix.length > 0 && name.startsWith(prefix))) continue;
    environment[name] = value;
  }
  for (const [name, value] of Object.entries(extras.force ?? {})) {
    if (value === undefined) continue;
    environment[name] = value;
  }
  return environment;
}
