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
 *
 * Reads a live-engine transcript directly. It used to take a file of hand-transcribed
 * `<n>. <Tool> | <detail>` lines, which is why nothing ever called it: measuring a run meant
 * copying its tool calls out by hand first, so nobody measured, and a 199-turn run went unexamined
 * until somebody did that transcription with a throwaway script. The transcripts are already on
 * disk after every run; this reads them.
 */

const OPERATION_SPLIT = /\s*(?:&&|\|\||;)\s*(?![^'"]*['"][^'"]*$)/;

/**
 * Tool name -> class, consulted before any pattern.
 *
 * Not merely a shortcut. The patterns below read shell text, and a non-Bash tool's argument is
 * prose: a `TaskCreate` whose description said "run `xforge state` with the fields the propose
 * Skill requires" matched the `orient-cli` pattern and was counted as a CLI call that never
 * happened. A tool whose name settles the question must never reach a regex written for commands.
 */
const TOOL_CLASSES = new Map([
  ['read', 'orient-read'],
  ['write', 'produce'],
  ['edit', 'produce'],
  ['multiedit', 'produce'],
  ['notebookedit', 'produce'],
  ['glob', 'orient-shell'],
  ['grep', 'orient-shell'],
  /* The whole Task* family, which is TodoWrite renamed and split. Keeping only the old name here
     would have reported a run's planning as `other` from the moment the host renamed it. */
  ['todowrite', 'planning'],
  ['todoread', 'planning'],
  ['taskcreate', 'planning'],
  ['taskupdate', 'planning'],
  ['tasklist', 'planning'],
  ['taskget', 'planning'],
  ['taskoutput', 'planning'],
  ['taskstop', 'planning'],
  ['exitplanmode', 'planning'],
]);

/*
 * `stage` sits with `state` and `stage-bundle`, and its absence was the blind spot that mattered
 * most: every Skill names `xforge stage --change <id>` as the Stage entry, so the single most
 * important command in the product fell through every pattern into `other`. A measurement of
 * orientation that cannot see the orientation command understates it on exactly the runs being
 * compared.
 *
 * `stage` before `stage-bundle` is harmless -- both answer `orient-cli` -- but the order is kept
 * longest-first anyway so a future split of the two does not silently collapse into one.
 */
const READ_COMMANDS = 'state|stage-bundle|stage|explain|version|doctor|contract';
const WRITE_COMMANDS = 'check|transition|advance|approve|archive|verification|work-package|findings|review|audit|install|update|init';

const CLASSES = [
  [new RegExp(String.raw`\b(?:xforge|cli\.js)[^|]*\b(?:${READ_COMMANDS})\b`), 'orient-cli'],
  [new RegExp(String.raw`\b(?:xforge|cli\.js)[^|]*\b(?:${WRITE_COMMANDS})\b`), 'advance'],
  [/\b(cat|ls|head|tail|find|grep|rg|tree|wc|sed -n|stat|file|diff|which)\b/, 'orient-shell'],
  [/\bgit\b/, 'orient-git'],
  [/\b(npm|pnpm|yarn|pytest|cargo|make)\b|node\s+(?!.*cli\.js)/, 'build-or-run'],
  [/\b(mkdir|cp|mv|rm|touch|printf|echo)\b/, 'produce'],
];

/** A heredoc body is content, not commands; splitting inside one invents operations. */
function operations(command) {
  const withoutHeredocs = command.replace(/<<'?(\w+)'?[\s\S]*?\n\1/g, '<<HEREDOC');
  return withoutHeredocs.split(OPERATION_SPLIT).map((part) => part.trim()).filter(Boolean);
}

function classify(tool, text) {
  const byName = TOOL_CLASSES.get(tool.toLowerCase());
  if (byName) return byName;
  if (tool !== 'Bash') return 'other';
  for (const [pattern, name] of CLASSES) if (pattern.test(text)) return name;
  return 'other';
}

/**
 * The tool calls in one transcript, plus what the run reported about itself.
 *
 * `num_turns` comes from the terminal `result` record rather than being counted here: a turn is
 * what the provider billed, and inferring it from assistant messages double-counts the ones that
 * carry text and a tool call separately.
 */
async function readTranscript(path) {
  const records = (await readFile(path, 'utf8')).split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const calls = [];
  let summary = null;
  for (const record of records) {
    if (record.type === 'assistant') {
      for (const block of record.message?.content ?? []) {
        if (block.type !== 'tool_use') continue;
        const input = block.input ?? {};
        const detail = input.command ?? input.file_path ?? input.pattern ?? JSON.stringify(input);
        calls.push({ tool: block.name, detail: String(detail) });
      }
    } else if (record.type === 'result') {
      const usage = record.usage ?? {};
      summary = {
        turns: record.num_turns ?? null,
        costUsd: record.total_cost_usd ?? null,
        promptTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens ?? 0,
        permissionDenials: record.permission_denials?.length ?? 0,
        isError: record.is_error ?? null,
      };
    }
  }
  return { calls, summary };
}

/** The legacy hand-transcribed form, kept so an ad-hoc list can still be scored. */
async function readListing(path) {
  const calls = (await readFile(path, 'utf8')).split('\n')
    .map((line) => line.match(/^\s*\d+\.\s*(\S+)\s*\|\s*(.*)$/))
    .filter(Boolean)
    .map((match) => ({ tool: match[1], detail: match[2] }));
  return { calls, summary: null };
}

const file = process.argv[2];
if (!file) throw new Error('Usage: classify-calls.mjs <transcript.jsonl | file with "<n>. <Tool> | <detail>" lines>');
const { calls: entries, summary } = file.endsWith('.jsonl') ? await readTranscript(file) : await readListing(file);

const calls = { total: entries.length };
const ops = { total: 0 };
for (const { tool, detail } of entries) {
  const parts = tool === 'Bash' ? operations(detail) : [detail];
  const callClass = classify(tool, `${tool} | ${parts[0] ?? ''}`);
  calls[callClass] = (calls[callClass] ?? 0) + 1;
  for (const part of parts) {
    const c = classify(tool, `${tool} | ${part}`);
    ops[c] = (ops[c] ?? 0) + 1;
    ops.total += 1;
  }
}
const orient = (bucket) => ['orient-cli', 'orient-shell', 'orient-read', 'orient-git']
  .reduce((sum, key) => sum + (bucket[key] ?? 0), 0);
process.stdout.write(`${JSON.stringify({
  ...(summary ? { run: summary } : {}),
  calls,
  operations: ops,
  orientationShare: {
    byCall: calls.total ? +(orient(calls) / calls.total).toFixed(3) : null,
    byOperation: ops.total ? +(orient(ops) / ops.total).toFixed(3) : null,
  },
}, null, 2)}\n`);
