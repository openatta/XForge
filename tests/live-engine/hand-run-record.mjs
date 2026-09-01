#!/usr/bin/env node
/*
 * A record of what a hand-driven scenario left on disk.
 *
 * `run-matrix.mjs` ends by printing an envelope — outcome, reworks, friction, limits, per-stage
 * classification, token and cost accounting — and that envelope is what a release gate reads. A
 * hand-driven run produces none of it: there is no policy file, no timeline, no stage classification,
 * because no `run-engine.mjs` process ever ran. What it does produce is the project itself, and the
 * governance record inside it is not narration — receipts, Gate Evidence and approvals are written by
 * the CLI and carry their own revisions.
 *
 * So this reads the project rather than asking anyone what happened. It is evidence of what the
 * governance chain did. It is NOT evidence for a release: see the standing note it prints, and
 * `DRIVING-BY-HAND.md` for the three layers it cannot reach.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const STANDING = 'Hand-driven. NOT release evidence on its own: this records what the governance chain '
  + 'did, not that the packaged CLI loads its Skills in a host. It cannot reach claude-CLI Skill loading, '
  + 'run-engine isolation, the budget/timeout policy layer, or token and cost accounting — the three '
  + 'layers where both of this project\'s known live-run defects surfaced. See DRIVING-BY-HAND.md.';


/*
 * With no argument, records every hand-driven project under tests/.tmp/ as one document — which is
 * the form a release reviewer wants, since the question is never "how did one Flow do" but "what did
 * all of them do, and what does this record not cover".
 */
const argument = process.argv[2];
if (!argument) {
  const tmp = path.resolve(new URL('../.tmp', import.meta.url).pathname);
  const projects = readdirSync(tmp, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('live-engine-') && !e.name.endsWith('-tmp') && e.name !== 'live-engine-results')
    .map((e) => path.join(tmp, e.name))
    .sort();
  /* A directory qualifies by holding a Change, not by being named like one: `live-engine-npm-pack`
     is a tarball cache and `live-engine-results` is where run output lands. Filtering on the name
     would have put both in the record as projects that failed to produce anything. */
  const runs = projects
    .map((p) => JSON.parse(spawnSync(process.execPath, [new URL(import.meta.url).pathname, p], { encoding: 'utf8' }).stdout || '{}'))
    .filter((run) => run.change);
  console.log(JSON.stringify({
    standing: STANDING,
    generatedFrom: 'the projects on disk, read back from CLI-written receipts, Gate Evidence and approvals',
    runs: runs.map(({ standing, ...rest }) => rest),
  }, null, 2));
  process.exit(0);
}
const root = path.resolve(argument);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const dirs = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
const files = (p) => { try { return readdirSync(p).sort(); } catch { return []; } };

const archiveRoot = path.join(root, 'xforge', 'changes', 'archive');
const archived = dirs(archiveRoot);
const active = dirs(path.join(root, 'xforge', 'changes')).filter((n) => n !== 'archive' && !n.startsWith('.'));
const changeDir = archived.length ? path.join(archiveRoot, archived[0]) : (active.length ? path.join(root, 'xforge', 'changes', active[0]) : null);
if (!changeDir) { console.log(JSON.stringify({ root, error: 'no Change found' }, null, 2)); process.exit(1); }

/* The transition chain is the rework record: a `to` that goes backwards in the Flow is a rework, and
   the receipts are CLI-written, so this counts what happened rather than what anyone reported. */
const receiptDir = path.join(changeDir, 'evidence', 'receipts', 'transitions');
const transitions = files(receiptDir).filter((n) => n.endsWith('.json')).map((n) => {
  const r = readJson(path.join(receiptDir, n));
  return { from: r.from ?? '(start)', to: r.to, at: r.recordedAt ?? r.decidedAt ?? null };
});
const order = [];
for (const t of transitions) { if (!order.includes(t.from)) order.push(t.from); if (!order.includes(t.to)) order.push(t.to); }
/*
 * A rework is a transition that goes *backwards* through the Flow, matching `run-matrix.mjs`, which
 * increments only where a blocked transition took a `reworkTo` target. Re-walking the Stages after a
 * rework is not itself a rework, and counting it as one turns a single refusal into four -- which is
 * what the first version of this file reported for a Change that had been sent back exactly once.
 *
 * The Flow order is read off the Change's own first pass rather than assumed, so a Flow whose Stage
 * list this file has never seen still counts correctly.
 */
const firstVisit = [];
for (const t of transitions) { if (!firstVisit.includes(t.from)) firstVisit.push(t.from); if (!firstVisit.includes(t.to)) firstVisit.push(t.to); }
const reworks = transitions.filter((t) => firstVisit.indexOf(t.to) < firstVisit.indexOf(t.from)).length;

const evidenceDir = path.join(changeDir, 'evidence');
const gates = files(evidenceDir).filter((n) => n.endsWith('.json') && n !== 'index.json').map((n) => {
  const e = readJson(path.join(evidenceDir, n));
  return { gate: e.gate, status: e.status, exitCode: e.exitCode, command: e.command, contentRevision: (e.contentRevision ?? '').slice(0, 12), gitHead: (e.gitHead ?? '').slice(0, 12) };
}).filter((g) => g.gate);

const approvalRoot = path.join(changeDir, 'approvals');
const approvals = dirs(approvalRoot).flatMap((policy) => files(path.join(approvalRoot, policy))
  .filter((n) => n.endsWith('.json'))
  .map((n) => { const r = readJson(path.join(approvalRoot, policy, n)); return { policy, decision: r.decision, role: r.approver?.role ?? null, method: r.attestation?.method ?? null }; }));

const receiptPath = path.join(evidenceDir, 'verification-receipt.yaml');
const verification = existsSync(receiptPath)
  ? Object.fromEntries(readFileSync(receiptPath, 'utf8').split('\n')
      .filter((l) => /^(status|gitHead|contentRevision):/.test(l))
      .map((l) => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1).trim()]; }))
  : null;

/* The acceptance suite, run the way the project itself says to run it. */
const pkg = path.join(root, 'package.json');
let acceptance = null;
if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).scripts?.test) {
  const r = spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  acceptance = { exitCode: r.status, pass: Number(/^.\s*pass (\d+)/m.exec(out)?.[1] ?? -1), fail: Number(/^.\s*fail (\d+)/m.exec(out)?.[1] ?? -1) };
}

console.log(JSON.stringify({
  standing: STANDING,
  project: root,
  change: path.basename(changeDir),
  outcome: archived.length ? 'archived' : 'in-flight',
  currentStage: archived.length ? null : transitions.at(-1)?.to ?? null,
  stagePath: order,
  transitions: transitions.length,
  reworks,
  gates,
  approvals,
  verificationReceipt: verification,
  specsMerged: files(path.join(root, 'xforge', 'specs')),
  contractsMerged: files(path.join(root, 'xforge', 'contracts')),
  acceptance,
}, null, 2));
