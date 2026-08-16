import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../xforge/node_modules/yaml/dist/index.js';

/**
 * A cassette is one recorded live run, kept so the tooling can be regression-tested without paying
 * for the model again.
 *
 * What is recorded is the isolated project's Git history, not the model's responses. That choice is
 * forced by what actually exists: `run-engine.mjs` passes `--no-session-persistence`, so no
 * tool-call transcript is written anywhere, and a recorded response could not reproduce the file
 * system state even if one were. What the model did to the project *is* recorded, exactly, by the
 * commit the harness already makes after every Stage — so a finished run is already a tape, and
 * this only packages it.
 *
 * Replaying therefore exercises the CLI, the Gates, the control plane, the Approval and
 * work-package protocols, archive, and the harness itself. It cannot exercise whether a Skill is
 * comprehensible or whether an Agent obeys it, which is why `scaffold` below exists: a cassette
 * carries the fingerprint of the Scaffold it was recorded against, and replaying against a changed
 * Scaffold is refused rather than silently passed.
 */

const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const cassettesRoot = path.join(repositoryRoot, 'tests', 'live-engine', 'cassettes');

export const cassetteFiles = (name) => ({
  manifest: path.join(cassettesRoot, `${name}.json`),
  bundle: path.join(cassettesRoot, `${name}.bundle`),
});

/**
 * Files whose bytes change on every release without changing anything an Agent reads.
 *
 * `lock.yaml` is entirely derived — per-resource digests of files this fingerprint already hashes
 * directly, plus the built CLI's integrity — so it contributes no independent signal and carries
 * the one value guaranteed to move on every build.
 */
const RELEASE_VOLATILE = new Set(['xforge/lock.yaml']);

/** Manifest keys a release bumps. Everything else in the manifest is behaviour and is hashed. */
const VERSION_KEYS = [['scaffold', 'version'], ['scaffold', 'source', 'version'], ['xforge', 'version']];

/**
 * Key-order-independent serialization. `JSON.stringify(value, keys)` is not this: an array second
 * argument is a property allow-list applied at every depth, so passing the top-level keys silently
 * drops every nested one — including `scaffold.skills`, the field this fingerprint most needs to
 * cover. The fingerprint test caught exactly that.
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function withoutVersions(yamlText) {
  const parsed = parse(yamlText);
  for (const keyPath of VERSION_KEYS) {
    let node = parsed;
    for (const key of keyPath.slice(0, -1)) node = node?.[key];
    if (node) delete node[keyPath.at(-1)];
  }
  return stableStringify(parsed);
}

function payloadFiles(directory, prefix = '') {
  const entries = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) entries.push(...payloadFiles(path.join(directory, entry.name), relative));
    else entries.push(relative);
  }
  return entries;
}

/**
 * Fingerprints everything an Agent reads that this repository controls — and nothing else.
 *
 * This used to hash `scaffold/files.sha256`, which is a digest of *every* payload file. That covered
 * the whole surface in one value, but it also covered `manifest.yaml`'s version fields and
 * `lock.yaml`, so **`npm run release:prepare` invalidated every cassette on every release** while
 * leaving every Skill, Flow, Gate, Rule and policy byte-identical. The refusal was a false positive
 * with a real price: a full re-record costs a live run of all four scenarios.
 *
 * What the check is for is narrower than what it was measuring. A cassette stops being evidence when
 * the *instructions the model reads* change — so that is what is hashed here: every payload file
 * except the two release-volatile ones, plus the manifest with only its version keys removed.
 * `scaffold.skills` stays in, because enabling or removing a Skill genuinely changes what the Agent
 * has, and that must still refuse an old cassette.
 */
export function scaffoldFingerprint() {
  const payloadRoot = path.join(repositoryRoot, 'scaffold', 'payload');
  const digest = createHash('sha256');
  for (const relative of payloadFiles(payloadRoot)) {
    if (RELEASE_VOLATILE.has(relative)) continue;
    const absolute = path.join(payloadRoot, relative);
    const content = relative === 'xforge/manifest.yaml'
      ? Buffer.from(withoutVersions(readFileSync(absolute, 'utf8')))
      : readFileSync(absolute);
    digest.update(`${relative}\0`).update(content).update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
}

/**
 * Which commits are the model's, read off the messages the harness writes.
 *
 * The subjects already separate the two kinds of work — a Stage the Agent drove versus an operation
 * the harness performed on its behalf — so replay can substitute exactly the former and genuinely
 * re-execute the latter. Anything unrecognised is treated as a harness commit, which is the safe
 * default: a harness step re-run on replay is tested, a model step re-run would call the model.
 */
export function modelStepFromSubject(subject, scenario) {
  const complete = new RegExp(`^Live engine stage complete: ${scenario}:(.+)$`).exec(subject);
  if (complete) return complete[1];
  const continuation = /^Live engine continuation: (.+) delivery observed$/.exec(subject);
  if (continuation) return `${continuation[1]}-delivered`;
  const checkpoint = /^Live engine standalone checkpoint: (.+)$/.exec(subject);
  if (checkpoint) return checkpoint[1];
  return null;
}

export function readCassette(name) {
  const files = cassetteFiles(name);
  if (!existsSync(files.manifest)) {
    throw new Error(`No cassette named "${name}". Record one with: node tests/live-engine/record-cassette.mjs --scenario ${name}`);
  }
  const manifest = JSON.parse(readFileSync(files.manifest, 'utf8'));
  if (!existsSync(files.bundle)) throw new Error(`Cassette ${name} has a manifest but no bundle at ${files.bundle}.`);
  return { ...manifest, files };
}

/**
 * Refuses a replay whose result would no longer mean anything.
 *
 * A cassette records what one model did when it read one particular set of Skills. Change those and
 * the recording stops being a prediction of what an Agent would do now, so a green replay would be
 * evidence about a Scaffold that no longer exists. Re-record instead — that is the "must re-run
 * live after changing a Skill" rule, enforced rather than remembered.
 */
export function assertCassetteStillApplies(cassette) {
  const current = scaffoldFingerprint();
  if (cassette.scaffold !== current) {
    throw new Error(
      `Cassette "${cassette.scenario}" was recorded against a different Scaffold.\n`
      + `  recorded: ${cassette.scaffold}\n  current:  ${current}\n`
      + 'A Skill, Flow, Gate, Rule or policy changed since, so replaying it would test the tooling '
      + 'against instructions no Agent has ever been given. Re-record with a live run:\n'
      + `  node tests/live-engine/run-matrix.mjs --scenario ${cassette.scenario} --cli-source local\n`
      + `  node tests/live-engine/record-cassette.mjs --scenario ${cassette.scenario}`,
    );
  }
}

/*
 * A replay re-signs approvals, so its receipts land at freshly minted UUID filenames. A Constitution
 * principle that cites an approval receipt and nothing else therefore points at a file the replay
 * never creates, `constitution-check` refuses the citation — correctly, since a citation nobody can
 * follow is not evidence — and the replay dies as a Gate failure deep inside Check that reads
 * exactly like a product defect.
 *
 * That hazard was known and written down in this directory's README, and written down was not
 * enough: nothing acted on it, so it cost a full re-diagnosis every time it recurred. It recurs
 * because it is not bad luck — for a principle about governance, an approval receipt is the evidence
 * a Check Agent naturally reaches for, and two consecutive `solid` recordings cited only that.
 *
 * So the recording decides it, at record time, for free, and `--replay` refuses up front with the
 * reason. It is a property of the recording rather than of the scenario: a later run citing a
 * Requirement id alongside the receipt records as replayable with no code change here.
 */
export const APPROVAL_RECEIPT_PATH = /(?:^|\/)approvals\/[^/]+\/[0-9a-f-]{36}\.json$/;

export function unreplayableReason(ledger, file) {
  for (const principle of ledger?.principles ?? []) {
    const references = principle?.references ?? [];
    if (references.length === 0) continue;
    if (references.every((reference) => APPROVAL_RECEIPT_PATH.test(String(reference)))) {
      return `${file}: principle "${principle.principle}" cites an approval receipt and nothing else. `
        + 'A replay mints its own approval UUIDs, so that citation cannot resolve and constitution-check '
        + 'refuses it. See tests/live-engine/README.md — the fix is to constrain citations in the '
        + 'xforge-check Skill, which invalidates every cassette, so it belongs with the next Skill change.';
    }
  }
  return null;
}

/*
 * Refused here rather than at the Gate, so the cause is one line at the start instead of a Gate
 * failure fifteen minutes in. Older cassettes carry no such field and replay exactly as before.
 */
export function assertCassetteReplayable(cassette) {
  if (!cassette.unreplayableReason) return;
  throw new Error(
    `Cassette "${cassette.scenario}" is record-only and cannot be replayed.\n  ${cassette.unreplayableReason}\n`
    + 'The recording itself is valid — it captured a real, complete run — so do not re-record to work around this.',
  );
}
