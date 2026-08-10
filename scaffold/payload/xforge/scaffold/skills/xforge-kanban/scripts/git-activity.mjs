#!/usr/bin/env node
// Deterministic Git-history activity extractor for the xforge-kanban Skill.
// Reads only `git log`; never writes, never invents data not present in history.
// No third-party dependencies — Node.js built-ins only.
import { execFileSync } from 'node:child_process';
import process from 'node:process';

function parseArgs(argv) {
  const args = { root: '.', since: null, until: null, author: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--root') args.root = argv[++index];
    else if (flag === '--since') args.since = argv[++index];
    else if (flag === '--until') args.until = argv[++index];
    else if (flag === '--author') args.author = argv[++index];
  }
  return args;
}

function git(root, gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

try {
  git(args.root, ['rev-parse', '--is-inside-work-tree']);
} catch {
  fail('Not inside a Git repository (or git is unavailable on PATH).');
}

let shallow = false;
try {
  shallow = git(args.root, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
} catch {
  // Older Git versions lack this flag; leave shallow as unknown-false rather than fail.
}

// --no-merges: merge commits have no single meaningful diff for line-count attribution.
// \x01/\x02 are unlikely-to-collide field/record separators, safer than a printable delimiter.
const logArgs = ['log', '--no-merges', '--numstat', '--date=iso-strict', '--format=%x01%H%x02%ad%x02%an%x02%ae%x02%s'];
if (args.since) logArgs.push(`--since=${args.since}`);
if (args.until) logArgs.push(`--until=${args.until}`);
if (args.author) logArgs.push(`--author=${args.author}`);

let raw;
try {
  raw = git(args.root, logArgs);
} catch (error) {
  fail(`git log failed: ${error.message}`);
}

function emptyResult() {
  return { ok: true, shallow, commitCount: 0, range: null, contributors: [], activity: {}, typeBreakdown: {} };
}

if (!raw || !raw.trim()) {
  process.stdout.write(`${JSON.stringify(emptyResult(), null, 2)}\n`);
  process.exit(0);
}

const CONVENTIONAL_TYPE = /^([a-z]+)(\([a-zA-Z0-9._-]+\))?!?:\s/;

const commits = [];
for (const chunk of raw.split('\x01').slice(1)) {
  const lines = chunk.split('\n');
  const header = lines[0] ?? '';
  const [hash, date, name, email, ...subjectParts] = header.split('\x02');
  const subject = subjectParts.join('\x02');
  let added = 0;
  let deleted = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const [addedField, deletedField] = line.split('\t');
    if (addedField !== '-' && !Number.isNaN(Number(addedField))) added += Number(addedField);
    if (deletedField !== '-' && !Number.isNaN(Number(deletedField))) deleted += Number(deletedField);
  }
  const typeMatch = subject.match(CONVENTIONAL_TYPE);
  commits.push({ hash, date, name, email, subject, added, deleted, type: typeMatch ? typeMatch[1] : null });
}

const byEmail = new Map();
for (const commit of commits) {
  const key = commit.email || commit.name || 'unknown';
  if (!byEmail.has(key)) {
    byEmail.set(key, {
      email: commit.email || null,
      names: new Set(),
      commits: 0,
      added: 0,
      deleted: 0,
      days: new Set(),
      first: commit.date,
      last: commit.date,
    });
  }
  const entry = byEmail.get(key);
  entry.names.add(commit.name);
  entry.commits += 1;
  entry.added += commit.added;
  entry.deleted += commit.deleted;
  entry.days.add(commit.date.slice(0, 10));
  if (commit.date < entry.first) entry.first = commit.date;
  if (commit.date > entry.last) entry.last = commit.date;
}

const contributors = [...byEmail.values()]
  .map((entry) => ({
    email: entry.email,
    names: [...entry.names],
    commits: entry.commits,
    linesAdded: entry.added,
    linesDeleted: entry.deleted,
    activeDays: entry.days.size,
    firstCommit: entry.first,
    lastCommit: entry.last,
  }))
  .sort((left, right) => right.commits - left.commits);

// ISO weekday (1=Mon..7=Sun) x local hour, matching each commit's own recorded timezone offset.
const activity = {};
for (const commit of commits) {
  const parsed = new Date(commit.date);
  const isoWeekday = ((parsed.getDay() + 6) % 7) + 1;
  const hour = parsed.getHours();
  const key = `${isoWeekday}-${String(hour).padStart(2, '0')}`;
  activity[key] = (activity[key] ?? 0) + 1;
}

const typeBreakdown = {};
for (const commit of commits) {
  const key = commit.type ?? 'unclassified';
  if (!typeBreakdown[key]) typeBreakdown[key] = { count: 0, subjects: [] };
  typeBreakdown[key].count += 1;
  if (typeBreakdown[key].subjects.length < 20) typeBreakdown[key].subjects.push({ hash: commit.hash.slice(0, 9), subject: commit.subject });
}

const dates = commits.map((commit) => commit.date).sort();

process.stdout.write(`${JSON.stringify({
  ok: true,
  shallow,
  commitCount: commits.length,
  range: { from: dates[0], to: dates[dates.length - 1] },
  contributors,
  activity,
  typeBreakdown,
}, null, 2)}\n`);
