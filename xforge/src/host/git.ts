import { execFileSync, spawn } from 'node:child_process';

/**
 * Every call this product makes to `git`, in one place.
 *
 * It replaces six hand-written wrappers — `core/identity.ts`, `core/revision.ts` (two of them),
 * `core/work-packages.ts`, `commands/archive.ts`, `commands/check.ts` and `commands/upgrade.ts`
 * (three call sites) — which between them spawned git nine times with four different opinions about
 * `core.quotepath`, three about which environment variables to pass, two about bounding output, and
 * five about what a failure should look like.
 *
 * **What this file does not do is merge those opinions.** `core/identity.ts` carried a comment
 * saying the three functions named `git` may not be collapsed into one, and it was right: one is
 * synchronous because it answers during module-level identity resolution, before any `await`
 * exists; one folds every failure into the string `unknown`, which is correct for a revision lookup
 * and wrong for a yes/no question; one disables `core.quotepath` because it parses porcelain paths.
 * Those are three different questions and they still get three different answers. What was
 * duplicated was never the semantics — it was the plumbing underneath them: spawn, collect, bound,
 * decode, and decide what an `error` event means.
 *
 * So the shape here is one runner that reports everything, plus five named readings. The rule for
 * earning a name is that the same sentence was being written out at three or more call sites, or
 * that the contract has a distinction callers have to be told about — `porcelainStatus` has two
 * asynchronous callers and is here for the second reason. A git operation this product performs
 * once stays written out at its call site as a `runGit` call: a named method with a single caller
 * is a second name for the same thing rather than an abstraction over it.
 *
 * Counts below are of *asynchronous* callers. `core/identity.ts` and `commands/upgrade.ts` cannot
 * await and reach the same operations through `runGitSync`.
 */

/**
 * Which environment a git subprocess sees.
 *
 * `inherit` is what eight of the nine call sites did. `minimal` is what `core/work-packages.ts`
 * did, and the difference is not cosmetic: a `GIT_DIR` or `GIT_WORK_TREE` in the ambient
 * environment redirects git at a different repository entirely, so a caller reasoning about
 * delivery ranges was deliberately shielded from one. Kept as a choice rather than made uniform,
 * because making every call minimal would change the behaviour of the eight, and making every call
 * inherit would remove a guard somebody put there on purpose.
 *
 * Not exported, and neither is `GitRunOptions`: callers pass object literals, and the suite refuses
 * a module that exports a symbol nothing outside it names. `Parameters<typeof runGit>[2]` still
 * reaches the options type from another file if one ever needs to.
 */
type GitEnvironment = 'inherit' | 'minimal';

/** The variables `core/work-packages.ts` passed through, verbatim. */
const MINIMAL_VARIABLES = ['PATH', 'SystemRoot', 'HOME', 'TMPDIR', 'TEMP', 'TMP'] as const;

function environmentFor(mode: GitEnvironment): NodeJS.ProcessEnv | undefined {
  if (mode === 'inherit') return undefined;
  const environment: NodeJS.ProcessEnv = {};
  for (const name of MINIMAL_VARIABLES) if (process.env[name]) environment[name] = process.env[name];
  return environment;
}

interface GitRunOptions {
  /**
   * `-c core.quotepath=false`, so a path git considers unusual arrives as its own bytes rather than
   * as a C-quoted escape. Required by anything that parses paths out of git's output and harmless
   * everywhere else; off by default only because turning it on for every call would change what
   * three existing callers receive.
   */
  quotePath?: boolean;
  /** Stop keeping stdout past this many bytes, and report `truncated`. */
  maxBytes?: number;
  /** Also collect stderr. Off by default: only one caller has ever read it. */
  captureStderr?: boolean;
  environment?: GitEnvironment;
}

export interface GitOutcome {
  /** 0 when git ran and succeeded. 127 when it could not be spawned at all. */
  code: number;
  ok: boolean;
  stdout: string;
  stderr: string;
  /** stdout was longer than `maxBytes`, so what is here is a prefix of what git said. */
  truncated: boolean;
}

function argumentsFor(root: string, args: string[], options: GitRunOptions): string[] {
  return [...(options.quotePath ? ['-c', 'core.quotepath=false'] : []), '-C', root, ...args];
}

/**
 * Never rejects. A git that is missing, not a repository, or refusing the question all arrive here
 * as an outcome, because every caller in this product treats "git could not answer" as information
 * rather than as an exception — and one of them (`commands/upgrade.ts`) distinguishes "git looked
 * and found nothing" from "there was nothing to ask", which an exception cannot express.
 */
export async function runGit(root: string, args: string[], options: GitRunOptions = {}): Promise<GitOutcome> {
  const limit = options.maxBytes ?? Number.POSITIVE_INFINITY;
  return new Promise((resolve) => {
    const child = spawn('git', argumentsFor(root, args, options), {
      shell: false,
      env: environmentFor(options.environment ?? 'inherit'),
      stdio: ['ignore', 'pipe', options.captureStderr ? 'pipe' : 'ignore'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    /* Every byte git produced, not every byte kept, so `truncated` stays answerable after the cap
       is reached. `commands/check.ts` refuses an over-long answer outright and needs to know. */
    let produced = 0;
    let kept = 0;
    let keptStderr = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      produced += chunk.byteLength;
      if (kept >= limit) return;
      const selected = chunk.byteLength > limit - kept ? chunk.subarray(0, limit - kept) : chunk;
      stdout.push(selected);
      kept += selected.byteLength;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (keptStderr >= limit) return;
      const selected = chunk.byteLength > limit - keptStderr ? chunk.subarray(0, limit - keptStderr) : chunk;
      stderr.push(selected);
      keptStderr += selected.byteLength;
    });
    child.on('error', (error) => resolve({ code: 127, ok: false, stdout: '', stderr: error.message, truncated: false }));
    child.on('close', (code) => resolve({
      code: code ?? 1,
      ok: code === 0,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      truncated: produced > limit,
    }));
  });
}

/**
 * The same, synchronously, for the two callers that cannot await.
 *
 * `core/identity.ts` resolves this build's identity while the module is being evaluated, and
 * `commands/upgrade.ts` asks its questions inside a transaction whose steps are ordered by
 * statement rather than by promise. Neither is a candidate for the async runner: making them await
 * would change when they run, which for identity resolution is the whole of what it is.
 */
export function runGitSync(root: string, args: string[], options: GitRunOptions = {}): GitOutcome {
  try {
    const stdout = execFileSync('git', argumentsFor(root, args, options), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: environmentFor(options.environment ?? 'inherit'),
    });
    return { code: 0, ok: true, stdout, stderr: '', truncated: false };
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    return { code: typeof status === 'number' ? status : 127, ok: false, stdout: '', stderr: '', truncated: false };
  }
}

/* ------------------------------------------------------------------ named readings
 *
 * Five. Everything below is a sentence callers were already writing out by hand; everything not
 * below is a git operation this product performs once, and stays a `runGit` call where it happens.
 */

/** `HEAD`, or `null` when there is no repository or no commit. Three callers. */
export async function headCommit(root: string, options: GitRunOptions = {}): Promise<string | null> {
  const result = await runGit(root, ['rev-parse', 'HEAD'], options);
  return result.ok ? result.stdout.trim() || null : null;
}

/** The repository root `git -C root` lands in, or `null`. Three callers. */
export async function topLevel(root: string, options: GitRunOptions = {}): Promise<string | null> {
  const result = await runGit(root, ['rev-parse', '--show-toplevel'], options);
  return result.ok ? result.stdout.trim() || null : null;
}

/**
 * Whether `ancestor` is reachable from `descendant`. Four callers.
 *
 * The answer is entirely in git's exit status — `merge-base --is-ancestor` prints nothing either
 * way — which is why the wrapper that folded a silent success into the string `unknown` could never
 * be used for it, and why a second wrapper existed.
 */
export async function isAncestor(root: string, ancestor: string, descendant: string, options: GitRunOptions = {}): Promise<boolean> {
  return (await runGit(root, ['merge-base', '--is-ancestor', ancestor, descendant], options)).ok;
}

/**
 * Paths that differ across a range, or `null` when the range could not be read. Three callers.
 *
 * `separator` picks between newline-delimited output and `-z`. An empty result is the meaningful
 * answer "nothing changed" and is returned as an empty array, never as `null`.
 */
export async function changedPaths(
  root: string,
  range: string,
  options: GitRunOptions & { separator?: 'newline' | 'nul' } = {},
): Promise<string[] | null> {
  const nul = options.separator === 'nul';
  const result = await runGit(root, ['diff', '--name-only', '--no-renames', ...(nul ? ['-z'] : []), range, '--'], options);
  if (!result.ok) return null;
  return result.stdout.split(nul ? '\0' : '\n').map((item) => item.trim()).filter(Boolean);
}

/**
 * `git status --porcelain`, or `null` when the question cannot be asked here. Two callers, plus a
 * synchronous third in `commands/upgrade.ts` that reads the same contract.
 *
 * `null` and `''` are deliberately different answers, and `commands/upgrade.ts` depends on the
 * distinction: an empty string means git looked and found the paths clean, so a recorded HEAD is a
 * real restore point, while `null` means there is no repository to ask and the snapshot is the whole
 * of the safety net. Collapsing them would let a project with no repository report a backstop it
 * does not have.
 */
export async function porcelainStatus(
  root: string,
  options: GitRunOptions & { paths?: readonly string[]; nulSeparated?: boolean; untrackedFiles?: boolean; noRenames?: boolean } = {},
): Promise<string | null> {
  const result = await runGit(root, [
    'status',
    options.nulSeparated === false ? '--porcelain' : '--porcelain=v1',
    ...(options.nulSeparated === false ? [] : ['-z']),
    ...(options.untrackedFiles ? ['--untracked-files=all'] : []),
    ...(options.noRenames ? ['--no-renames'] : []),
    ...(options.paths ? ['--', ...options.paths] : []),
  ], options);
  if (!result.ok || result.truncated) return null;
  return result.stdout;
}
