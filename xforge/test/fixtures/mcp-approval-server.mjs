import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Test-only fake approval platform: decision/approver behavior is driven entirely
// by env vars so integration tests can exercise approve/reject/pending without a real backend.
const decision = process.env.XFORGE_TEST_MCP_DECISION ?? 'pending';
const approverId = process.env.XFORGE_TEST_MCP_APPROVER_ID ?? 'reviewer@example.test';
const approverRole = process.env.XFORGE_TEST_MCP_APPROVER_ROLE ?? 'owner';
// Named "...VALUE" rather than "...TOKEN": mcp-approval.ts's subprocess-env allowlist denies any
// name matching /token|secret|password|.../ outright, even if explicitly allowlisted, so a name
// containing "TOKEN" here would never reach this process regardless of the McpServer's env.allow.
const expectedToken = process.env.XFORGE_TEST_MCP_EXPECTED_VALUE;

if (expectedToken && process.env.XFORGE_MCP_TOKEN !== expectedToken) {
  process.stderr.write('unauthorized\n');
  process.exit(1);
}

// The next two checks are the adversarial half of the env-allowlisting tests: this process must
// never see a variable the McpServer did not declare, and must never see a credential-shaped one
// even when the McpServer does declare it. Exiting non-zero here surfaces as a connection failure
// in the surrounding test, so a leak can only ever fail a test, never silently pass one.

// Set in the parent environment but never declared in spec.env.allow/allowPrefixes: if it arrives,
// the subprocess inherited the ambient environment.
if (process.env.XFORGE_TEST_MCP_FORBIDDEN_LEAK) {
  process.stderr.write('environment leak detected: an undeclared variable reached the provider\n');
  process.exit(1);
}

// Credential-shaped ("AUTH" matches core/env-safety.ts's deny pattern), and deliberately declared
// in spec.env.allow / matched by an allowPrefixes entry by the tests: if it arrives, an explicit
// allow (or prefix) beat the deny filter, which would let any manifest opt a secret back in.
if (process.env.XFORGE_TEST_MCP_AUTH_BACKDOOR) {
  process.stderr.write('credential-shaped variable leaked: deny did not beat allow\n');
  process.exit(1);
}

const server = new Server({ name: 'xforge-test-mcp-approval', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'submit_approval_request', inputSchema: { type: 'object' } },
    { name: 'poll_approval', inputSchema: { type: 'object' } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  if (name === 'submit_approval_request') {
    return { content: [{ type: 'text', text: JSON.stringify({ accepted: true }) }] };
  }
  if (name === 'poll_approval') {
    const body = decision === 'pending'
      ? { status: 'pending' }
      : { status: 'decided', decision, approver: { id: approverId, role: approverRole }, reason: 'Decided by the test fixture.' };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ error: `unknown tool ${name}` }) }], isError: true };
});

await server.connect(new StdioServerTransport());
