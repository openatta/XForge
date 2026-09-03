import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The two-way gate between what the product ships and what the harness tells a model.
 *
 * Both directions were breached, and each breach cost something different.
 *
 * **Harness vocabulary in the payload** would ship test scaffolding to real projects. Nothing has
 * done this yet -- `xforge/package.json` publishes `dist`, `scaffold`, `schemas` and `README.md`,
 * so `tests/**` structurally cannot reach a user -- but the payload is the one channel that does
 * reach them, and it is worth a check rather than a memory.
 *
 * **Product vocabulary in a cold scenario's intent** is the one that actually happened, seventeen
 * times over. Every past live-run failure was repaired by adding a sentence to a scenario prompt,
 * so the prompts accumulated the product's rough edges as instructions: where Artifacts live, that
 * the outline is a contract, which Gates to declare, which file not to hand-edit. The harness then
 * could not find those failures any more -- it had cleared them from its own path -- while real
 * users, holding no such prompt, walked straight into them. A prompt that answers what the product
 * should have answered is an answer key, and this makes writing one fail loudly.
 *
 * Guided scenarios are deliberately exempt. They are the regression tier and they may say anything;
 * their job is to reach the end reproducibly. The cold tier's job is to find out what a real user
 * hits, and it can only do that if nobody is allowed to help it.
 */

const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const payloadRoot = path.join(repositoryRoot, 'scaffold', 'payload');
const scenariosRoot = path.join(repositoryRoot, 'tests', 'live-engine', 'scenarios');

/**
 * Every Markdown file a cold scenario owns is checked, not a named subset.
 *
 * The per-Stage prompt files are the channel the leak actually travelled through, so exempting
 * anything by name would leave the door the seventeen sentences came in by standing open.
 */
const isColdText = (absolute) => absolute.endsWith('.md');

/**
 * Words that only somebody who already knows XForge would write.
 *
 * Deliberately not a list of every CLI noun: a rule broad enough to be safe is a rule people
 * silence. These are the terms whose presence means a judgement the Agent was supposed to make has
 * been made for it -- which Flow to run, which Stage does what, which Artifact to write, which
 * command clears which Gate.
 */
const PRODUCT_VOCABULARY = [
  /\bxforge\s+[a-z-]+\b/i,          // any CLI invocation
  /\bxforge\/[a-z]/i,               // any path inside the governed tree
  /\bxforge-[a-z-]+\b/i,            // any Skill name
  /\b(?:Major|Solid|Quick)\s+Flow\b/i,
  /\bwork[- ]packages?\.yaml\b/i,
  /\bwrite_paths\b/, /\bdone_when\b/, /\breworkTo\b/, /\bminApprovers\b/,
  /\bcontentRevision\b/, /\bpolicySnapshotDigest\b/, /\brequiredWhen\b/,
  /\b(?:delta )?Spec(?:s)?\b/,
  /\bGate Evidence\b/i, /\bwork[- ]package\b/i,
  /\bClarify stage\b/i, /\bCheck stage\b/i, /\bApply stage\b/i, /\bVerify stage\b/i,
  /\bseparation of duties\b/i, /\bcheck-findings\b/i, /\bconstitution-check\b/i,
];

/** Words that mean "this text is talking about the test rig". */
const HARNESS_VOCABULARY = [
  /\blive-engine\b/i, /\bTEST_REQUEST\b/, /\bthe harness\b/i,
  /\brun-matrix\b/i, /\bscenario prompt\b/i, /\bdo not commit\b/i,
];

async function walk(directory) {
  const found = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return found; }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(absolute));
    else if (entry.isFile()) found.push(absolute);
  }
  return found;
}

function hits(text, patterns) {
  const found = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (match) found.push({ line: index + 1, term: match[0].trim() });
    }
  }
  return found;
}

const problems = [];

/* Direction 1: nothing about the test rig may ship. */
for (const absolute of await walk(payloadRoot)) {
  if (!/\.(md|ya?ml|json|txt)$/i.test(absolute)) continue;
  const relative = path.relative(repositoryRoot, absolute);
  for (const hit of hits(await readFile(absolute, 'utf8'), HARNESS_VOCABULARY)) {
    problems.push(`${relative}:${hit.line}: harness vocabulary in shipped payload: "${hit.term}"`);
  }
}

/*
 * Direction 3: a measurement scenario may not be told how to orient itself.
 *
 * A third tier, and it exists because the second one could not answer the question it was asked.
 * The guided prompts open with "Read AGENTS.md, the complete active Change (Proposal, delta Spec,
 * Design), TEST_REQUEST.md" -- which is exactly the work the Stage working set was built to
 * replace. An Agent following that reads all of it and *then* calls the CLI, so the command shows
 * up as additional work and the improvement is invisible. Measured before and after a refactor that
 * removed most of a Stage's orientation, the guided tier reported 3%.
 *
 * `check-vocabulary` already names the mechanism for defects: a prompt that answers what the
 * product should have answered is an answer key. The same key hides gains. So the measurement tier
 * may say anything about *what* to achieve -- it has to, or the runs are not comparable -- and
 * nothing about *how to find out where things are*. That is the product's job, and measuring the
 * product means letting it do it.
 */
const ORIENTATION_INSTRUCTIONS = [
  /\bRead\s+`?AGENTS\.md/i, /\bRead\s+`?CLAUDE\.md/i, /\bRead\s+`?xforge\/XFORGE\.md/i,
  /\bRead\s+.{0,40}\bmanifest\.yaml/i, /\bRead\s+.{0,40}\bconstitution\.md/i,
  /\bthe complete active\b/i, /\bRead\s+.{0,60}\bSkill\b/i,
  /\bcat\s+/i, /\bopen\s+the\s+(Proposal|Design|delta Spec)/i,
];

const measureRoots = (await readdir(scenariosRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.endsWith('-measure'))
  .map((entry) => path.join(scenariosRoot, entry.name));

for (const root of measureRoots) {
  for (const absolute of await walk(root)) {
    if (!isColdText(absolute)) continue;
    const relative = path.relative(repositoryRoot, absolute);
    const text = await readFile(absolute, 'utf8');
    text.split('\n').forEach((line, index) => {
      for (const pattern of ORIENTATION_INSTRUCTIONS) {
        if (pattern.test(line)) {
          problems.push(`${relative}:${index + 1}: a measurement scenario tells the Agent how to orient itself: "${line.trim().slice(0, 80)}". Say what to achieve; let the product say where things are, because that is what is being measured.`);
          break;
        }
      }
    });
  }
}

/* Direction 2: a cold scenario may not be told what it is supposed to discover. */
const coldRoots = (await readdir(scenariosRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.endsWith('-cold'))
  .map((entry) => path.join(scenariosRoot, entry.name));

for (const root of coldRoots) {
  for (const absolute of await walk(root)) {
    if (!isColdText(absolute)) continue;
    const relative = path.relative(repositoryRoot, absolute);
    for (const hit of hits(await readFile(absolute, 'utf8'), PRODUCT_VOCABULARY)) {
      problems.push(`${relative}:${hit.line}: product vocabulary in a cold scenario: "${hit.term}"`);
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n\n${problems.length} vocabulary violation(s).\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Vocabulary gate clean: ${coldRoots.length} cold scenario(s), ${measureRoots.length} measurement scenario(s), payload free of harness terms.\n`);
}
