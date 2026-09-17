// design: live-test §3 — 一轮 = 一次 claude -p；D5：提示、stream-json 全流、result 全部落盘。
import { spawn } from 'node:child_process';
import { createWriteStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Usage {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

export interface TurnResult {
  turn: number;
  resultText: string;
  isError: boolean;
  usage: Usage;
  model: string | undefined;
  durationMs: number;
  numTurns: number;
  sessionId: string | undefined;
  streamPath: string;
}

export interface TurnOptions {
  turn: number;
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  transcriptsDir: string;
  model: string | undefined;
  timeoutMs: number;
  /** 模型跑的过程中每半秒调用一次；用来在两轮之间够不到的时刻注入故障。 */
  tick?: () => void;
}

export async function runTurn(o: TurnOptions): Promise<TurnResult> {
  const streamPath = join(o.transcriptsDir, `turn-${String(o.turn).padStart(2, '0')}.stream.jsonl`);
  writeFileSync(join(o.transcriptsDir, `turn-${String(o.turn).padStart(2, '0')}.prompt.txt`), o.prompt);
  const args = ['-p', o.prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (o.model) args.push('--model', o.model);
  const started = Date.now();
  return new Promise<TurnResult>((resolve) => {
    const child = spawn('claude', args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = createWriteStream(streamPath);
    let buffer = '';
    let resultMsg: Record<string, unknown> | null = null;
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs);
    const ticker = o.tick ? setInterval(() => o.tick!(), 500) : null;
    child.stdout.on('data', (chunk: Buffer) => {
      out.write(chunk);
      buffer += chunk.toString();
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg['type'] === 'result') resultMsg = msg;
          } catch {
            // 非 JSON 行照录不解析。
          }
        }
        nl = buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      out.end();
      const durationMs = Date.now() - started;
      const r = resultMsg ?? {};
      const usage = (r['usage'] as Record<string, number> | undefined) ?? {};
      const modelUsage = r['modelUsage'] as Record<string, unknown> | undefined;
      const result: TurnResult = {
        turn: o.turn,
        resultText: typeof r['result'] === 'string' ? (r['result'] as string) : '',
        isError: Boolean(r['is_error']) || code !== 0 || resultMsg === null,
        usage: {
          input: usage['input_tokens'] ?? 0,
          output: usage['output_tokens'] ?? 0,
          cache_read: usage['cache_read_input_tokens'] ?? 0,
          cache_creation: usage['cache_creation_input_tokens'] ?? 0,
        },
        model: modelUsage ? Object.keys(modelUsage).join('+') : o.model,
        durationMs,
        numTurns: typeof r['num_turns'] === 'number' ? (r['num_turns'] as number) : 0,
        sessionId: typeof r['session_id'] === 'string' ? (r['session_id'] as string) : undefined,
        streamPath,
      };
      writeFileSync(join(o.transcriptsDir, `turn-${String(o.turn).padStart(2, '0')}.result.json`), JSON.stringify({ exit: code, stderr: stderr.trim(), result: resultMsg }, null, 2));
      resolve(result);
    });
  });
}
