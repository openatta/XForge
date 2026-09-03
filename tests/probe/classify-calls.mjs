import { readFile } from 'node:fs/promises';

/**
 * Two numbers, because one of them lies depending on who is driving.
 *
 * A turn is what costs money -- every one re-sends the whole context, which is why a stage's
 * `cache_read` runs to millions while its `input_tokens` stays under a hundred thousand. So turn
 * count is the metric that matters.
 *
 * But a capable model batches: `cat a && cat b && ls c` is one tool call and three operations. A
 * weaker one issues three calls. Measuring only calls would credit the model's shell habits to the
 * product, and would hide a real improvement whenever the batching model was already collapsing
 * the orientation this refactor is meant to remove. Measuring only operations would ignore what is
 * actually billed.
 *
 * So both are reported, and the comparison is only ever made within one driver.
 */

const OPERATION_SPLIT = /\s*(?:&&|\|\||;)\s*(?![^'"]*['"][^'"]*$)/;

const CLASSES = [
  [/\bxforge[^|]*\b(state|stage-bundle)\b|cli\.js[^|]*\b(state|stage-bundle)\b/, 'orient-cli'],
  [/\bcli\.js[^|]*\b(check|transition|advance|approve|archive|verification|work-package|findings|review|audit)\b|\bxforge\s+(check|transition|advance|approve|archive|verification|work-package|findings|review|audit)\b/, 'advance'],
  [/^\s*(Write|Edit)\b/, 'produce'],
  [/\b(cat|ls|head|tail|find|grep|rg|tree|wc|sed -n|stat|file)\b/, 'orient-shell'],
  [/^\s*Read\b/, 'orient-read'],
  [/\bgit\b/, 'orient-git'],
  [/\b(npm|pnpm|yarn|pytest|cargo|make)\b|node\s+(?!.*cli\.js)/, 'build-or-run'],
  [/\b(TaskCreate|TodoWrite)\b/, 'planning'],
  [/\b(mkdir|cp|mv|rm|touch|printf|echo)\b/, 'produce'],
];

/** A heredoc body is content, not commands; splitting inside one invents operations. */
function operations(command) {
  const withoutHeredocs = command.replace(/<<'?(\w+)'?[\s\S]*?\n\1/g, "<<HEREDOC");
  return withoutHeredocs.split(OPERATION_SPLIT).map((part) => part.trim()).filter(Boolean);
}

function classify(text) {
  for (const [pattern, name] of CLASSES) if (pattern.test(text)) return name;
  return 'other';
}

const file = process.argv[2];
if (!file) throw new Error('Usage: classify-calls.mjs <file with one "<n>. <Tool> | <detail>" per line>');
const lines = (await readFile(file, 'utf8')).split('\n')
  .map((line) => line.match(/^\s*\d+\.\s*(\S+)\s*\|\s*(.*)$/))
  .filter(Boolean)
  .map((match) => ({ tool: match[1], detail: match[2] }));

const calls = { total: lines.length };
const ops = { total: 0 };
for (const { tool, detail } of lines) {
  const parts = tool === 'Bash' ? operations(detail) : [detail];
  const callClass = classify(`${tool} | ${parts[0] ?? ''}`);
  calls[callClass] = (calls[callClass] ?? 0) + 1;
  for (const part of parts) {
    const c = classify(`${tool} | ${part}`);
    ops[c] = (ops[c] ?? 0) + 1;
    ops.total += 1;
  }
}
const orient = (bucket) => ['orient-cli', 'orient-shell', 'orient-read', 'orient-git']
  .reduce((sum, key) => sum + (bucket[key] ?? 0), 0);
process.stdout.write(`${JSON.stringify({
  calls, operations: ops,
  orientationShare: { byCall: +(orient(calls) / calls.total).toFixed(3), byOperation: +(orient(ops) / ops.total).toFixed(3) },
}, null, 2)}\n`);
