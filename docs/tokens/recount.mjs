// 复算一次会话的 token 消耗：主转录 + 它的子 Agent 转录，按 message.id 归并（末条为准）。
//
//   node docs/tokens/recount.mjs <session.jsonl> <session/subagents> \
//     [--phase "P1=2026-09-18T10:23:04Z/2026-09-18T10:43:41Z" ...]
//
// 不给 --phase 就打总量与按小时分布；给了就按边界切段（边界是左闭右开，最后一段可省终点）。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 一条 assistant 回复在转录里可能落成多条记录，usage 随流累加 —— 取同一 id 的最后一条。 */
function collect(file) {
  const byId = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = record.message?.usage;
    if (!usage) continue;
    byId.set(record.message.id ?? record.uuid, {
      at: record.timestamp,
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cache_read: usage.cache_read_input_tokens || 0,
      cache_creation: usage.cache_creation_input_tokens || 0,
    });
  }
  return [...byId.values()];
}

const zero = () => ({ calls: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0 });
const add = (a, row) => ({
  calls: a.calls + 1,
  input: a.input + row.input,
  output: a.output + row.output,
  cache_read: a.cache_read + row.cache_read,
  cache_creation: a.cache_creation + row.cache_creation,
});
const line = (name, a) => {
  const total = a.input + a.output + a.cache_read + a.cache_creation;
  return `${name.padEnd(24)} ${String(a.calls).padStart(5)} 次 | input ${String(a.input).padStart(9)} | output ${String(a.output).padStart(8)} | cache_read ${String(a.cache_read).padStart(10)} | cache_creation ${String(a.cache_creation).padStart(6)} | 小计 ${total.toLocaleString('en-US')}`;
};

const [session, subagents, ...rest] = process.argv.slice(2);
if (!session) {
  console.error('用法: node docs/tokens/recount.mjs <session.jsonl> <session/subagents> [--phase 名称=起点/终点]');
  process.exit(2);
}
const phases = [];
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] !== '--phase') continue;
  const [name, span] = (rest[i + 1] ?? '').split('=');
  const [from, to] = span.split('/');
  phases.push({ name, from: Date.parse(from), to: to ? Date.parse(to) : Infinity });
}

const rows = [collect(session)];
if (subagents) for (const f of readdirSync(subagents).filter((f) => f.endsWith('.jsonl'))) rows.push(collect(join(subagents, f)));
const all = rows.flat().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

if (phases.length === 0) {
  console.log(line('全部', all.reduce(add, zero())));
  const byHour = new Map();
  for (const row of all) {
    const hour = row.at.slice(0, 13);
    byHour.set(hour, add(byHour.get(hour) ?? zero(), row));
  }
  for (const [hour, a] of byHour) console.log(line(`  ${hour}Z`, a));
} else {
  let total = zero();
  for (const [i, phase] of phases.entries()) {
    const end = phase.to || (phases[i + 1]?.from ?? Infinity);
    const mine = all.filter((row) => Date.parse(row.at) >= phase.from && Date.parse(row.at) < end);
    const a = mine.reduce(add, zero());
    total = Object.fromEntries(Object.keys(zero()).map((k) => [k, total[k] + a[k]]));
    console.log(line(phase.name, a));
  }
  console.log(line('以上各段合计', total));
}
