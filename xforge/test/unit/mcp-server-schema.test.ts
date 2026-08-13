import { describe, expect, it } from 'vitest';
import { validateSchema } from '../../src/core/validator.js';

function server(env: { allow?: string[]; allowPrefixes?: string[] }): Record<string, unknown> {
  return {
    apiVersion: 'xforge.dev/v1alpha2',
    kind: 'McpServer',
    metadata: { name: 'test-server', version: 1 },
    spec: {
      transport: 'stdio',
      command: ['node', 'server.mjs'],
      authTokenEnv: 'XFORGE_TEST_TOKEN',
      timeoutSeconds: 10,
      env,
    },
  };
}

describe('mcp-server schema envName', () => {
  it('accepts mixed-case env names in env.allow, matching the gate schema', async () => {
    /* Gate env names are conventionally uppercase, but nothing on any platform forbids mixed
       case — the mcp-server schema must not be stricter than the gate schema it shares. */
    const diagnostics = await validateSchema('mcp-server', server({ allow: ['CorpRegion', 'CI_cacheDir'] }), 'mcp');
    expect(diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
  });

  it('rejects env names that start with a digit, contain separators, or are empty', async () => {
    for (const bad of ['9LEADING', 'BAD-NAME', '']) {
      const diagnostics = await validateSchema('mcp-server', server({ allow: [bad] }), 'mcp');
      expect(diagnostics.some((item) => item.severity === 'error'), JSON.stringify(bad)).toBe(true);
    }
  });

  it('applies the same envName rules to allowPrefixes', async () => {
    const diagnostics = await validateSchema('mcp-server', server({ allowPrefixes: ['Corp'] }), 'mcp');
    expect(diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    const bad = await validateSchema('mcp-server', server({ allowPrefixes: ['9bad'] }), 'mcp');
    expect(bad.some((item) => item.severity === 'error')).toBe(true);
  });
});
