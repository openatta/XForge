import { describe, expect, it } from 'vitest';
import { validateSchema } from '../../src/core/validator.js';

/**
 * `spec.env.allow` / `spec.env.allowPrefixes` are how an operator opts an MCP approval provider's
 * subprocess into the environment variables it genuinely needs, on top of the built-in allowlist.
 * A pattern that is stricter than the names real environments use silently makes those variables
 * undeclarable — and the failure surfaces far away, as an unexplained provider connection error.
 * The default allowlist itself contains `http_proxy`, `SystemRoot` and `ProgramFiles`, so an
 * uppercase-only pattern here would be narrower than the values the same filter already passes.
 * This pins the pattern directly so a future tightening fails here rather than in the field.
 */
const server = (env: Record<string, unknown>): Record<string, unknown> => ({
  apiVersion: 'xforge.dev/v1alpha2',
  kind: 'McpServer',
  metadata: { name: 'enterprise-approvals', version: 1 },
  spec: {
    transport: 'stdio',
    command: ['approvals-server'],
    authTokenEnv: 'XFORGE_APPROVALS_TOKEN',
    timeoutSeconds: 30,
    env,
  },
});

const accepts = async (env: Record<string, unknown>): Promise<boolean> =>
  (await validateSchema('mcp-server', server(env), 'xforge/scaffold/mcp-servers/enterprise-approvals.yaml')).length === 0;

describe('McpServer spec.env schema', () => {
  it('accepts the mixed-case and lowercase names real environments use', async () => {
    /* Not merely conventional SCREAMING_SNAKE: npm and proxy settings are lowercase, Windows
       variables are PascalCase, and both already appear in the built-in allowlist. */
    expect(await accepts({ allow: ['CORP_APPROVALS_URL', 'http_proxy', 'SystemRoot', 'CI_cacheDir', '_leading'] })).toBe(true);
  });

  it('accepts prefixes, including the trailing underscore a prefix normally ends with', async () => {
    expect(await accepts({ allowPrefixes: ['CORP_APPROVALS_', 'npm_config_', 'Corp'] })).toBe(true);
  });

  it('rejects names that are not valid environment-variable identifiers', async () => {
    for (const name of ['9LEADING', 'BAD-NAME', 'HAS SPACE', 'HAS.DOT', '']) {
      expect(await accepts({ allow: [name] }), `allow: ${JSON.stringify(name)}`).toBe(false);
      expect(await accepts({ allowPrefixes: [name] }), `allowPrefixes: ${JSON.stringify(name)}`).toBe(false);
    }
  });

  it('rejects duplicates and unknown keys under env', async () => {
    expect(await accepts({ allow: ['SAME', 'SAME'] })).toBe(false);
    expect(await accepts({ deny: ['ANYTHING'] })).toBe(false);
  });

  it('treats env as optional, so existing McpServer resources stay valid', async () => {
    const withoutEnv = server({});
    delete (withoutEnv.spec as Record<string, unknown>).env;
    expect((await validateSchema('mcp-server', withoutEnv, 'test.yaml')).length).toBe(0);
  });
});
