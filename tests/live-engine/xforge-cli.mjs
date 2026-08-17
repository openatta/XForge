import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Invokes the CLI the way v0.7.12 documents: a bare `xforge` found on PATH, with cwd set to the
 * isolated project. It is installed beside the project rather than inside it (see cli-source.mjs),
 * so the project itself carries only what its seed put there — which is what lets a scenario be a
 * Rust, Go or Python project rather than unavoidably a Node one.
 *
 * The bin directory is derived from the project path rather than threaded through every call site:
 * `setup.mjs` places the project at `<tmp>/live-engine-<scenario>` and the CLI at
 * `<tmp>/live-engine-<scenario>-tmp/cli`, so one is a pure function of the other. `setup.mjs` also
 * reports it as `cliBin` for callers that would rather be told than compute.
 */
export function cliBinDirectory(projectRoot) {
  return path.join(`${projectRoot}-tmp`, 'cli', 'node_modules', '.bin');
}

function withCliOnPath(projectRoot, env) {
  const base = { ...process.env, ...env };
  return { ...base, PATH: `${cliBinDirectory(projectRoot)}${path.delimiter}${base.PATH ?? ''}` };
}

export function spawnXforge(projectRoot, args, { env = {}, stdio = ['ignore', 'pipe', 'pipe'] } = {}) {
  return spawnSync('xforge', args, {
    cwd: projectRoot,
    env: withCliOnPath(projectRoot, env),
    encoding: 'utf8',
    stdio,
  });
}

export function runXforgeJson(projectRoot, args, env = {}) {
  const result = spawnXforge(projectRoot, args, { env });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  if (result.status !== 0 || !json) throw new Error(`xforge ${args.join(' ')} failed: ${result.stdout || result.stderr}`);
  return json;
}

/**
 * The same call for a command whose refusal is a governed outcome rather than a harness error — a
 * Transition the control plane blocks, most of all. Those still exit non-zero, but they print a
 * complete `ok: false` envelope naming what blocked, and a caller that means to read that envelope
 * should not have to catch a string-formatted throw to reach it. A command that produced no JSON at
 * all is still a harness error and still throws.
 */
export function tryXforgeJson(projectRoot, args, env = {}) {
  const result = spawnXforge(projectRoot, args, { env });
  try { return JSON.parse(result.stdout); } catch {}
  throw new Error(`xforge ${args.join(' ')} produced no JSON envelope: ${result.stdout || result.stderr}`);
}

/**
 * Drives an interactive `xforge` command (currently only local Approval's terminal dialogue) by
 * waiting for each expected prompt to actually appear on stderr before answering it.
 *
 * A fixed delay between writes is not reliable here: `node:readline/promises`'s `question()`
 * resolves the *first* pending question fine against piped (non-TTY) stdin, but if a later
 * answer is already sitting in the OS pipe buffer by the time the next `question()` call attaches
 * its 'line' listener, Node can deliver it in a burst before that listener exists — the answer is
 * lost, the promise never resolves, and the CLI's own `Promise.race` against the stream's 'close'
 * event turns the hang into XFORGE_APPROVAL_INTERACTIVE_REQUIRED once stdin closes. `question()`
 * always writes the prompt to `output` (stderr here) before awaiting input, so waiting for that
 * exact text is a real signal instead of a timing guess — confirmed against a plain `npx` spawn,
 * where a fixed ~250ms delay was not always enough margin.
 *
 * `exchanges` is an ordered list of `{ waitFor, send }`: `waitFor` is matched against stderr
 * accumulated since the previous exchange (substring match), `send` is written as that line's
 * answer (`''` accepts a flag-provided suggestion).
 */
export function runXforgeInteractive(projectRoot, args, { env = {}, exchanges = [], timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('xforge', args, {
      cwd: projectRoot,
      env: withCliOnPath(projectRoot, env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderrSinceLastMatch = '';
    let stderrAll = '';
    let settled = false;
    const remaining = [...exchanges];

    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`xforge ${args.join(' ')} timed out waiting for prompt(s): ${remaining.map((e) => e.waitFor).join(', ')}. stderr so far: ${stderrAll}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrAll += text;
      stderrSinceLastMatch += text;
      while (remaining.length > 0 && stderrSinceLastMatch.includes(remaining[0].waitFor)) {
        const { send } = remaining.shift();
        stderrSinceLastMatch = '';
        child.stdin.write(`${send}\n`);
        if (remaining.length === 0) child.stdin.end();
      }
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch {}
      if (code !== 0 || !json) finish(reject, new Error(`xforge ${args.join(' ')} failed: ${stdout || stderrAll}`));
      else finish(resolve, json);
    });
  });
}
