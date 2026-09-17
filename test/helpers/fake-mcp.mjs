#!/usr/bin/env node
// 测试用的假 MCP 审批服务（stdio JSON-RPC，MCP 2024-11-05）。
// 环境变量：FAKE_MCP_DECISION=approved|rejected（缺省 approved）、FAKE_MCP_APPROVER（缺省 review-bot）、
// FAKE_MCP_MODE=normal|silent|garbage|error（silent 不答复；garbage 回非 JSON 文本；error 回 isError）、FAKE_MCP_LOG=<文件>（把收到的 approve 请求写进去）。
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_MCP_MODE ?? 'normal';
const decision = process.env.FAKE_MCP_DECISION ?? 'approved';
const approver = process.env.FAKE_MCP_APPROVER ?? 'review-bot';
const log = process.env.FAKE_MCP_LOG;

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0' } });
    return;
  }
  if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [{ name: 'approve', description: 'approve an XForge stage or archive', inputSchema: { type: 'object' } }] });
    return;
  }
  if (msg.method === 'tools/call') {
    if (log) appendFileSync(log, JSON.stringify(msg.params) + '\n');
    if (mode === 'silent') return;
    if (mode === 'garbage') {
      reply(msg.id, { content: [{ type: 'text', text: 'not json at all' }] });
      return;
    }
    if (mode === 'error') {
      reply(msg.id, { isError: true, content: [{ type: 'text', text: 'reviewer unavailable' }] });
      return;
    }
    const args = msg.params?.arguments ?? {};
    reply(msg.id, { content: [{ type: 'text', text: JSON.stringify({ approver, decision, note: `fake review of ${args.change ?? '?'} ${args.stage ?? 'archive'}` }) }] });
  }
});
