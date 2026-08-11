import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Test-only fake approval platform: decision/approver behavior is driven entirely
// by env vars so integration tests can exercise approve/reject/pending without a real backend.
const decision = process.env.XFORGE_TEST_MCP_DECISION ?? 'pending';
const approverId = process.env.XFORGE_TEST_MCP_APPROVER_ID ?? 'reviewer@example.test';
const approverRole = process.env.XFORGE_TEST_MCP_APPROVER_ROLE ?? 'owner';
const expectedToken = process.env.XFORGE_TEST_MCP_EXPECTED_TOKEN;

if (expectedToken && process.env.XFORGE_MCP_TOKEN !== expectedToken) {
  process.stderr.write('unauthorized\n');
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
