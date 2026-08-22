#!/usr/bin/env node
/*
 * Red-first proof: a test added with a fix must fail without the fix.
 *
 * The problem it answers is specific to an automated issue -> fix loop. An agent that may edit both
 * the implementation and the tests can always make the suite green, and every coverage number it
 * can also edit is circular. Only a signal that a *weakened* test cannot satisfy breaks the circle,
 * and this is the cheapest one: run the new tests against the parent commit's source. A test that
 * discriminates fails there. A test that was loosened to accommodate the bug passes there, and is
 * refused.
 *
 * It is not a new idea, only an automated one. Fixing the archive path's condition re-evaluation
 * was verified by hand exactly this way — the fix was reverted, the new test watched to fail
 * (archive returned 0 with the review evidence deleted), then restored. That ad-hoc step is the
 * whole of what this script does, minus the chance of forgetting it.
 *
 *   node scripts/red-first.mjs [--base <ref>] [--keep]
 *
 * The working tree is never touched: the base is materialised as a throwaway `git worktree`, the
 * candidate test files are copied into it, and it is removed afterwards.
 *
 * Exit codes: 0 every candidate test file failed against the base (proved). 1 at least one passed
 * (not proved). 2 the run could not decide — no candidate tests, or the base build failed.
 */
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function options(argv) {
  const parsed = { base: 'HEAD', keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--base') { parsed.base = argv[index + 1]; index += 1; }
    else if (argv[index] === '--keep') parsed.keep = true;
    else if (argv[index] === '--help' || argv[index] === '-h') parsed.help = true;
    else { console.error(`Unknown argument: ${argv[index]}`); process.exit(2); }
  }
  return parsed;
}

function git(args, cwd = repoRoot) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.trim()}`);
  return result.stdout.trim();
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A path that is a test this repository actually runs. */
function isTestFile(relative) {
  return /\.test\.[cm]?[jt]s$/.test(relative)
    && (relative.startsWith('xforge/test/') || relative.startsWith('tests/'));
}

/**
 * Test files added or modified since `base`, tracked and untracked alike.
 *
 * Untracked matters: an agent that has written a fix and its test but not yet committed is exactly
 * the state this runs in, and `git diff` alone cannot see a brand-new file.
 */
function candidateTests(base) {
  const changed = git(['diff', '--name-only', '--diff-filter=AM', base]).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n');
  return [...new Set([...changed, ...untracked])].filter((item) => item && isTestFile(item)).sort();
}

/** Which suite a test belongs to; they have different roots and cannot be run in one invocation. */
function suiteOf(relative) {
  return relative.startsWith('xforge/test/') ? 'cli' : 'product';
}

/**
 * Runs the proof and returns the process exit code.
 *
 * Nothing below may call `process.exit`. It does not unwind the stack, so a `finally` never runs
 * and the throwaway worktree survives -- registered in `.git/worktrees`, where it then breaks the
 * next `git worktree` command anyone runs. That was the bug: all three exits sat inside the `try`,
 * so the cleanup was dead code and `--keep` never printed. The exit hook below is the backstop for
 * a future exit added anyway; this contract is what keeps the normal path readable.
 */
function main() {
  const parsed = options(process.argv.slice(2));
  if (parsed.help) {
    console.log('Usage: node scripts/red-first.mjs [--base <ref>] [--keep]');
    return 0;
  }

  const baseSha = git(['rev-parse', parsed.base]);
  const tests = candidateTests(parsed.base);
  if (tests.length === 0) {
    console.error(`No added or modified test files against ${parsed.base} (${baseSha.slice(0, 8)}).`);
    console.error('A fix ships with a test that fails without it. There is nothing here to prove.');
    return 2;
  }

  console.log(`Base: ${parsed.base} (${baseSha.slice(0, 8)})`);
  console.log(`Candidate test files (${tests.length}):`);
  for (const item of tests) console.log(`  ${item}`);

  const worktree = mkdtempSync(path.join(tmpdir(), 'xforge-red-first-'));
  rmSync(worktree, { recursive: true, force: true });
  let added = false;
  let cleaned = false;
  /* Idempotent so the `finally` and the exit hook can both call it; whichever runs first wins. */
  const cleanup = () => {
    if (cleaned || !added || parsed.keep) return;
    cleaned = true;
    try { git(['worktree', 'remove', worktree, '--force']); } catch { rmSync(worktree, { recursive: true, force: true }); }
  };
  /* Fires on paths a `finally` cannot see: a `process.exit` someone adds later, and an uncaught
     throw. Silent on purpose -- stdout writes from an exit hook are not reliably flushed when
     stdout is a pipe, and a lost line is worse than no line. The readable reporting stays below. */
  process.on('exit', cleanup);
  try {
    git(['worktree', 'add', '--detach', worktree, baseSha]);
    added = true;

    /* Dependencies are heavy and identical at any revision, so the base borrows the working tree's
       rather than paying an install. `--force` is absent on purpose: a real directory here would
       mean the base commit vendored its modules, and silently replacing that is not this script's
       call. */
    for (const relative of ['xforge/node_modules', 'node_modules']) {
      const source = path.join(repoRoot, relative);
      const target = path.join(worktree, relative);
      if (existsSync(source) && !existsSync(target)) symlinkSync(source, target, 'dir');
    }

    /* The candidate tests are the only thing carried across. Everything else — src, scaffold,
       schemas — stays as the base had it, which is the entire point. */
    for (const relative of tests) {
      const source = path.join(repoRoot, relative);
      if (!existsSync(source)) continue;
      cpSync(source, path.join(worktree, relative), { recursive: true });
    }

    console.log('\nBuilding the base (build + relock)...');
    const built = run('npm', ['run', 'relock'], worktree);
    if (built.status !== 0) {
      console.error('The base failed to build, so nothing can be proved against it.');
      console.error((built.stderr || built.stdout || '').split('\n').slice(-25).join('\n'));
      return 2;
    }

    /*
     * One vitest invocation per file, and the granularity is load-bearing.
     *
     * Running a suite in one go asks "did anything fail", which any single discriminating test
     * answers for the whole batch — so a weak test riding alongside a real one is never seen. That
     * is precisely the shape an agent under pressure produces: fix one thing properly, loosen
     * something else nearby. Each file has to fail on its own. The build is what costs; the extra
     * invocations are seconds.
     */
    const results = [];
    for (const relative of tests) {
      const cli = suiteOf(relative) === 'cli';
      const cwd = cli ? path.join(worktree, 'xforge') : worktree;
      const args = cli
        ? ['vitest', 'run', relative.replace('xforge/', '')]
        : ['vitest', 'run', '--root', '.', relative];
      process.stdout.write(`\n  ${relative} ... `);
      const outcome = run('npx', args, cwd);
      const output = `${outcome.stdout}\n${outcome.stderr}`;
      /* A file vitest cannot even load — because it imports something the base does not have — is
         still a file the base does not pass, which is what is being asked. Reported apart because
         it proves less: an import error says the API is new, not that the assertion discriminates. */
      const unloadable = /Failed to load|Cannot find module|No test files found/.test(output);
      const failed = outcome.status !== 0;
      process.stdout.write(failed ? (unloadable ? 'red (does not load)' : 'red') : 'GREEN');
      results.push({ relative, failed, unloadable, output });
    }

    console.log('\n');
    const green = results.filter((result) => !result.failed);
    for (const result of results.filter((item) => item.failed)) {
      console.log(`PROVED      ${result.relative}${result.unloadable ? '  (does not load against the base — the API is new)' : ''}`);
    }
    for (const result of green) {
      console.log(`NOT PROVED  ${result.relative}`);
    }
    if (green.length > 0) {
      console.log(`\nThe ${green.length === 1 ? 'file' : 'files'} marked NOT PROVED ${green.length === 1 ? 'passes' : 'pass'} without the fix, so nothing in ${green.length === 1 ? 'it' : 'them'} describes`);
      console.log('defect that was fixed. Either the test asserts behaviour that already worked, or it was');
      console.log('written around the bug.');
      console.log('Add an assertion that fails on the base, or drop the file from the change.');
    }
    return green.length === 0 ? 0 : 1;
  } finally {
    cleanup();
    if (added && parsed.keep) console.log(`\nWorktree kept at ${worktree}`);
  }
}

process.exitCode = main();
