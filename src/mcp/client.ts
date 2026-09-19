// design: cli §2.4 — MCP 审批的客户端：stdio 上的 JSON-RPC（MCP 2024-11-05），只做 initialize 与一次 tools/call。
// 控制面不关心 MCP 内部做了什么：它回 approved 就是同意，与人批同形。
import { spawn } from 'node:child_process';
import { externalEnv } from '../model/env.js';

export interface McpStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpCallOptions {
  server: McpStdioServer;
  tool: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
  cwd: string;
}

export class McpError extends Error {
  constructor(message: string, public readonly reason: 'spawn' | 'timeout' | 'protocol' | 'tool') {
    super(message);
  }
}

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** 起一个 stdio MCP 服务，握手，调一次工具，取回它的文本或结构化结果，然后结束它。 */
export async function callMcpTool(o: McpCallOptions): Promise<unknown> {
  // 审批者是外部进程：给它 XFORGE_AUDIT_HMAC 就等于让它能伪造自己的审批事件。
  const child = spawn(o.server.command, o.server.args ?? [], { cwd: o.cwd, env: { ...externalEnv(), ...(o.server.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve: (v: RpcResponse) => void }>();
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  let spawnError: Error | null = null;
  child.on('error', (e) => {
    spawnError = e;
  });
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  child.stdout.on('data', (d: Buffer) => {
    buffer += d.toString();
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        try {
          const msg = JSON.parse(line) as RpcResponse;
          if (typeof msg.id === 'number' && pending.has(msg.id)) {
            pending.get(msg.id)!.resolve(msg);
            pending.delete(msg.id);
          }
        } catch {
          // 不是 JSON 的行（服务的日志之类）：忽略。
        }
      }
      nl = buffer.indexOf('\n');
    }
  });
  const send = (method: string, params: unknown, expectReply: boolean): Promise<RpcResponse | null> =>
    new Promise((resolve, reject) => {
      const id = expectReply ? nextId++ : undefined;
      const frame = JSON.stringify(expectReply ? { jsonrpc: '2.0', id, method, params } : { jsonrpc: '2.0', method, params }) + '\n';
      if (!expectReply) {
        child.stdin.write(frame, (err) => (err ? reject(err) : resolve(null)));
        return;
      }
      pending.set(id!, { resolve: (v) => resolve(v) });
      child.stdin.write(frame, (err) => {
        if (err) reject(err);
      });
    });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpError(`MCP 服务 ${o.timeoutMs / 1000} 秒内没有答复`, 'timeout')), o.timeoutMs);
  });
  try {
    const run = (async (): Promise<unknown> => {
      const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'xforge', version: '1' } }, true);
      if (spawnError) throw new McpError(`MCP 服务起不来：${(spawnError as Error).message}`, 'spawn');
      if (!init || init.error) throw new McpError(`MCP initialize 失败：${init?.error?.message ?? '无答复'}`, 'protocol');
      await send('notifications/initialized', {}, false);
      const reply = await send('tools/call', { name: o.tool, arguments: o.arguments }, true);
      if (!reply || reply.error) throw new McpError(`MCP tools/call 失败：${reply?.error?.message ?? '无答复'}`, 'tool');
      const result = reply.result as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean } | undefined;
      if (!result) throw new McpError('MCP 回复没有 result', 'protocol');
      if (result.isError) throw new McpError(`MCP 工具报错：${result.content?.map((c) => c.text ?? '').join(' ') ?? ''}`, 'tool');
      if (result.structuredContent !== undefined) return result.structuredContent;
      const text = result.content?.find((c) => c.type === 'text')?.text;
      if (text === undefined) throw new McpError('MCP 回复里没有文本或结构化内容', 'protocol');
      try {
        return JSON.parse(text);
      } catch {
        throw new McpError('MCP 回复的文本不是 JSON', 'protocol');
      }
    })();
    return await Promise.race([run, deadline]);
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(`MCP 调用失败：${(error as Error).message}${stderr ? `；stderr: ${stderr.slice(0, 200)}` : ''}`, 'protocol');
  } finally {
    if (timer) clearTimeout(timer); // 不清掉，进程会等到超时才退出
    try {
      child.kill();
    } catch {
      // 已经退出。
    }
  }
}
