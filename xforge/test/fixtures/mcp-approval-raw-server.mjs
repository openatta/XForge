import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Test-only fake approval platform that answers `poll_approval` with a body the test dictates
// verbatim, rather than one this fixture composes. Its sibling (mcp-approval-server.mjs) only ever
// emits well-formed results, which is what the happy-path tests want; this one exists so tests can
// hand the CLI the shapes a real third-party provider actually produces when it is buggy,
// half-implemented, or hostile — a decided result with no approver, an unrecognised status, an
// unparseable expiresAt, a body far larger than any decision needs.
//
// XFORGE_TEST_MCP_POLL_BODY is the raw text returned for poll_approval; it does not have to be
// valid JSON. XFORGE_TEST_MCP_POLL_PAD, when set, instead returns an otherwise-valid decided body
// whose reason is padded to that many bytes, for exercising the response size cap without pushing
// a huge value through the environment.
const rawBody = process.env.XFORGE_TEST_MCP_POLL_BODY;
const padBytes = Number.parseInt(process.env.XFORGE_TEST_MCP_POLL_PAD ?? '', 10);

function pollBody() {
  if (Number.isInteger(padBytes) && padBytes > 0) {
    return JSON.stringify({
      status: 'decided',
      decision: 'approve',
      approver: { id: 'alice@example.test', role: 'owner' },
      reason: 'x'.repeat(padBytes),
    });
  }
  return rawBody ?? JSON.stringify({ status: 'pending' });
}

const server = new Server({ name: 'xforge-test-mcp-approval-raw', version: '1.0.0' }, { capabilities: { tools: {} } });

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
    return { content: [{ type: 'text', text: pollBody() }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ error: `unknown tool ${name}` }) }], isError: true };
});

await server.connect(new StdioServerTransport());
