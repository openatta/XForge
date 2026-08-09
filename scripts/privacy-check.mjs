#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const staged = args.includes('--staged');
const checkNextCommit = args.includes('--check-next-commit');
const rangeIndex = args.indexOf('--identity-range');
const identityRange = rangeIndex === -1 ? null : args[rangeIndex + 1];
const includeIndexes = args.flatMap((argument, index) => argument === '--include' ? [index] : []);
const includePaths = includeIndexes.map((index) => args[index + 1]);
const messageIndex = args.indexOf('--message-file');
const messageFile = messageIndex === -1 ? null : args[messageIndex + 1];
const knownArguments = new Set(['--staged', '--check-next-commit', '--identity-range', '--include', '--message-file']);

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--identity-range' || argument === '--include' || argument === '--message-file') {
    index += 1;
    if (!args[index]) fail(`Missing value for ${argument}.`);
    continue;
  }
  if (!knownArguments.has(argument)) fail(`Unknown option: ${argument}`);
}
if (checkNextCommit && identityRange) fail('--check-next-commit and --identity-range cannot be combined.');
if (staged && includePaths.length > 0) fail('--staged and --include cannot be combined.');

const repoRoot = git(['rev-parse', '--show-toplevel']).trim();
process.chdir(repoRoot);

const allowedEmailDomains = new Set([
  'example.com',
  'example.test',
  'users.noreply.github.com',
]);
const deviceWord = ['Mac', 'Book'].join('');
const contentChecks = [
  ['absolute-home-path', /(?:\/Users\/[^/\s"'<>]+\/|\/home\/[^/\s"'<>]+\/|[A-Za-z]:\\Users\\[^\\\s"'<>]+\\)/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{20,}\b/g],
  ['github-token', /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['npm-auth-value', /\/\/(?:registry\.)?npmjs\.(?:org|com)\/[^\s]*:_authToken\s*=\s*(?!\$\{)[^\s]+/gi],
  ['device-name', new RegExp(`\\b[A-Za-z0-9._-]*${deviceWord}[A-Za-z0-9._-]*\\b`, 'gi')],
  ['private-ip-address', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g],
];
const sensitiveNames = [
  /(?:^|\/)\.npmrc$/,
  /(?:^|\/)\.netrc$/,
  /(?:^|\/)\.authinfo$/,
  /(?:^|\/)\.env(?:\..+)?$/,
  /(?:^|\/)(?:credentials|secrets)\.json$/i,
  /\.(?:pem|key|p12|pfx)$/i,
];
const findings = [];

for (const file of candidateFiles()) {
  const normalized = file.split(path.sep).join('/');
  if (sensitiveNames.some((pattern) => pattern.test(normalized)) && !normalized.endsWith('.env.example')) {
    record('sensitive-file-name', normalized);
  }
  scanText(normalized, fileContent(file));
}
if (messageFile) scanText('commit-message', readFileSync(messageFile));

if (checkNextCommit) {
  checkIdentity('next-author', gitIdentity('GIT_AUTHOR_IDENT'));
  checkIdentity('next-committer', gitIdentity('GIT_COMMITTER_IDENT'));
} else if (identityRange) {
  for (const commit of git(['rev-list', identityRange]).trim().split(/\r?\n/).filter(Boolean)) {
    const [author = '', committer = ''] = git(['show', '-s', '--format=%ae%n%ce', commit]).trim().split(/\r?\n/);
    checkIdentity(`commit-author:${commit.slice(0, 12)}`, author);
    checkIdentity(`commit-committer:${commit.slice(0, 12)}`, committer);
    scanText(`commit-message:${commit.slice(0, 12)}`, Buffer.from(git(['show', '-s', '--format=%B', commit])));
  }
} else if (hasHead()) {
  const [author = '', committer = ''] = git(['show', '-s', '--format=%ae%n%ce', 'HEAD']).trim().split(/\r?\n/);
  checkIdentity('head-author', author);
  checkIdentity('head-committer', committer);
  scanText('head-commit-message', Buffer.from(git(['show', '-s', '--format=%B', 'HEAD'])));
  const tagRows = git(['for-each-ref', '--points-at=HEAD', '--format=%(refname:short)%09%(objecttype)%09%(taggeremail)', 'refs/tags']).trim();
  for (const row of tagRows.split(/\r?\n/).filter(Boolean)) {
    const [tag, objectType, taggerEmail = ''] = row.split('\t');
    if (objectType === 'tag') {
      checkIdentity(`tagger:${tag}`, taggerEmail);
      scanText(`tag-message:${tag}`, Buffer.from(git(['for-each-ref', '--format=%(contents)', `refs/tags/${tag}`])));
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Privacy check failed with ${findings.length} finding(s). Matched values are intentionally hidden.\n`);
  for (const finding of findings) process.stderr.write(`PRIVACY_${finding.category.toUpperCase().replaceAll('-', '_')} ${finding.location}\n`);
  process.exit(1);
}

process.stdout.write(`Privacy check passed for ${staged ? 'staged' : 'tracked and unignored'} files and selected Git identities.\n`);

function candidateFiles() {
  const output = staged
    ? gitBuffer(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    : gitBuffer(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const files = output.toString('utf8').split('\0').filter(Boolean);
  for (const includePath of includePaths) files.push(...filesUnder(includePath));
  return [...new Set(files)].sort();
}

function filesUnder(candidate) {
  try {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) return [];
    if (stat.isFile()) return [candidate];
    if (!stat.isDirectory()) return [];
    return readdirSync(candidate).flatMap((name) => filesUnder(path.join(candidate, name)));
  } catch {
    fail(`Included privacy-scan path does not exist: ${candidate}`);
  }
}

function fileContent(file) {
  if (staged) {
    const result = spawnSync('git', ['show', `:${file}`], { encoding: null, maxBuffer: 50 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : Buffer.alloc(0);
  }
  try {
    if (!lstatSync(file).isFile()) return Buffer.alloc(0);
    return readFileSync(file);
  } catch {
    return Buffer.alloc(0);
  }
}

function scanText(file, buffer) {
  if (buffer.includes(0)) return;
  const lines = buffer.toString('utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const [category, pattern] of contentChecks) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) record(category, `${file}:${index + 1}`);
    }
    const emails = line.match(/[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}/gi) ?? [];
    for (const email of emails) {
      const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
      if (!allowedEmailDomains.has(domain)) record('email-address', `${file}:${index + 1}`);
    }
  }
}

function gitIdentity(variable) {
  try {
    const value = git(['var', variable]);
    return value.match(/<([^>]+)>/)?.[1] ?? '';
  } catch {
    return '';
  }
}

function checkIdentity(location, email) {
  const normalized = email.match(/<([^>]+)>/)?.[1] ?? email.trim();
  if (!normalized || !normalized.toLowerCase().endsWith('@users.noreply.github.com')) record('git-identity', location);
}

function hasHead() {
  return spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' }).status === 0;
}

function record(category, location) {
  findings.push({ category, location });
}

function git(arguments_) {
  return execFileSync('git', arguments_, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 50 * 1024 * 1024 });
}

function gitBuffer(arguments_) {
  return execFileSync('git', arguments_, { encoding: null, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 50 * 1024 * 1024 });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
