/**
 * Shared subprocess-environment allowlisting for anything XForge spawns as an external process
 * (Gates, project Scripts, MCP approval providers, ...). A spawned process never inherits the
 * ambient environment wholesale — only names on the default list below, plus anything a manifest
 * or resource opts in via `env.allow` / `env.allowPrefixes`, are passed through. Names that look
 * like credentials are always dropped, even if explicitly allowed: a resource cannot opt a secret
 * back in.
 */
export const DEFAULT_ENV_ALLOW = [
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'TMPDIR', 'TEMP', 'TMP',
  'SystemRoot', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'OS',
  'CI', 'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

/** `npm_config_*` carries registry/cache/proxy settings; credential-shaped names are filtered below. */
export const DEFAULT_ENV_ALLOW_PREFIXES = ['npm_config_', 'NPM_CONFIG_'];

/** Never inherited, from any source: nothing can opt a credential-shaped name back in. */
export const ENV_DENY = /(?:password|passwd|secret|token|api[_-]?key|auth|credential|cookie|session|private[_-]?key)/i;

export interface FilteredEnvironment {
  /** The environment to hand to `spawn`/`StdioClientTransport`. */
  env: Record<string, string>;
  /** Every name present (and non-empty) in `process.env` that was excluded — use it for a count. */
  filtered: string[];
  /**
   * The subset of `filtered` excluded only because nothing allowed it: exactly the names a caller
   * could legitimately opt back in via `env.allow` / `env.allowPrefixes`. Credential-shaped
   * (deny-matched) names are deliberately absent — they can never be opted back in, so naming them
   * in operator-facing output would publish an inventory of the machine's secret-ish variable names
   * for no debugging benefit. Diagnostics should name these, and only count the rest.
   */
  notAllowed: string[];
}

/**
 * Builds a filtered copy of `process.env`: the default allowlist above, plus caller-supplied
 * `allow` names and `allowPrefixes`, minus anything credential-shaped. Returns both the filtered
 * environment and the names that were left out, so a caller can surface "N vars were filtered"
 * to an operator debugging a broken subprocess instead of silently dropping them.
 */
export function filterEnvironment(options: { allow?: string[]; allowPrefixes?: string[] } = {}): FilteredEnvironment {
  const allow = new Set([...DEFAULT_ENV_ALLOW, ...(options.allow ?? [])]);
  const prefixes = [...DEFAULT_ENV_ALLOW_PREFIXES, ...(options.allowPrefixes ?? [])];
  const env: Record<string, string> = {};
  const filtered: string[] = [];
  const notAllowed: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || value === '') continue;
    if (ENV_DENY.test(name)) { filtered.push(name); continue; }
    if (!allow.has(name) && !prefixes.some((prefix) => prefix.length > 0 && name.startsWith(prefix))) {
      filtered.push(name);
      notAllowed.push(name);
      continue;
    }
    env[name] = value;
  }
  return { env, filtered, notAllowed };
}
