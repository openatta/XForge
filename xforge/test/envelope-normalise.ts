import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Everything in a CLI envelope that changes between two identical runs, replaced by a placeholder.
 *
 * A golden of the envelope is only worth recording if two runs of the same scenario produce the
 * same text, and several fields exist precisely because they must not: a receipt id, the moment a
 * Gate started, the digest of a file whose content includes a digest. Normalising them is what
 * separates "this command's output shape changed" from "time passed".
 *
 * The list is deliberately conservative. Anything normalised here stops being covered by the
 * golden, so a field is added only when it has been observed to vary — the temp root and the
 * clock, then the identifiers derived from them. A value that merely *looks* volatile, such as a
 * Gate's exit code or an event count, stays as it is: those are results.
 */

export interface NormaliseOptions {
  /** The fixture's temporary root, replaced first so paths beneath it normalise consistently. */
  root: string;
}

/**
 * Where this checkout lives, which `xforge version` reports as `installation.path`.
 *
 * Normalised for two reasons, and the second one found it: a golden holding a developer's home
 * directory is not portable, and the repository's own `privacy-check.mjs` refuses to commit one.
 */
const CHECKOUT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const RULES: Array<[RegExp, string]> = [
  /* Order matters: the longer, more specific shapes first, or a shorter rule eats their prefix. */
  [/\b[0-9a-f]{64}\b/g, '<sha256>'],
  [/\b[0-9a-f]{40}\b/g, '<commit>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>'],
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<timestamp>'],
  /* `durationMs` and friends: a number that is only ever a measurement of this run. */
  [/"(durationMs|elapsedMs|timeoutMs)":\s*\d+/g, '"$1": <ms>'],
  /*
   * The same measurement embedded in prose. A Gate's own stdout carries `-> exit 0 in 35ms`, which
   * is a string field and therefore invisible to the rule above — it was found by the
   * same-scenario-twice assertion below rather than by reading the code, which is what that
   * assertion is for.
   */
  [/\bin \d+ms\b/g, 'in <ms>'],
  /*
   * `executablePath` is the file node was launched with, which is the product's own binary when the
   * CLI is spawned and a vitest worker when it is called in process. The suite runs both ways --
   * the coverage gate spawns because that is the only path it can measure -- so recording either
   * spelling pins the harness rather than the product. Its presence and position stay covered.
   */
  [/"executablePath":\s*"[^"]*"/g, '"executablePath": "<executable>"'],
  /* Node's own version travels in `xforge version`, and the suite runs on more than one. */
  [/"nodeVersion":\s*"v[\d.]+"/g, '"nodeVersion": "<node>"'],
  [/\bv\d+\.\d+\.\d+\b/g, '<node>'],
];

export function normaliseEnvelope(text: string, options: NormaliseOptions): string {
  let normalised = text;
  /* The root first, and both its raw and JSON-escaped spellings: `--text` prints it bare while the
     JSON envelope escapes the separators on Windows. */
  for (const spelling of [options.root, options.root.split('\\').join('\\\\')]) {
    normalised = normalised.split(spelling).join('<ROOT>');
  }
  for (const spelling of [CHECKOUT, CHECKOUT.split('\\').join('\\\\')]) {
    normalised = normalised.split(spelling).join('<CHECKOUT>');
  }
  /* The temp directory's own parent leaks through `realpath` on macOS (`/private/var/...`). */
  normalised = normalised.replace(/\/(?:private\/)?(?:var|tmp)\/[^"\s,)]*xforge-test-[A-Za-z0-9]+/g, '<ROOT>');
  for (const [pattern, replacement] of RULES) normalised = normalised.replace(pattern, replacement);
  return normalised;
}

/** Pretty-prints so a golden diff shows one changed field per line rather than one changed blob. */
export function renderEnvelope(stdout: string, options: NormaliseOptions): string {
  const normalised = normaliseEnvelope(stdout, options);
  try {
    return `${JSON.stringify(JSON.parse(normalised), null, 2)}\n`;
  } catch {
    /* `--text` output, and any envelope the normaliser left unparseable — recorded as it stands. */
    return normalised.endsWith('\n') ? normalised : `${normalised}\n`;
  }
}
