import type { DesiredFile } from '../types.js';
import { sha256, stableStringify } from '../core/hash.js';

/**
 * Partial-file ownership.
 *
 * XForge used to take over whole files. That is correct for `.claude/skills/**` (nobody else
 * writes there) and wrong for `.claude/settings.json`, `CLAUDE.md` and `opencode.json`, which are
 * the normal home for a team's own configuration. Whole-file ownership made `xforge install` fail
 * outright on any repository already using those files, and froze them afterwards.
 *
 * A fragment record stores the *exact material XForge wrote* rather than a digest of the whole
 * file. That gives three properties the planner and `uninstall` rely on:
 *
 *  - merge      — user keys/items/text outside the recorded material are read in and written back.
 *  - drift      — a user edit to XForge's own material is detectable (the recorded item is gone).
 *  - reversal   — `uninstall` subtracts exactly the recorded material, and removes the file only
 *                 when nothing else is left.
 */

export type Fragment = NonNullable<DesiredFile['fragment']>;
export type JsonFragment = Extract<Fragment, { format: 'json' }>;
export type MarkerFragment = Extract<Fragment, { format: 'markers' }>;

export class FragmentParseError extends Error {}

function itemKey(value: unknown): string {
  return stableStringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPath(root: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function writePath(root: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor = root;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (!isPlainObject(next)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path.at(-1)!] = value;
}

/** Deletes the leaf at `path` and every ancestor container the deletion leaves empty. */
function deletePath(root: Record<string, unknown>, path: string[]): void {
  if (path.length === 0) return;
  const parent = path.length === 1 ? root : readPath(root, path.slice(0, -1));
  if (!isPlainObject(parent)) return;
  delete parent[path.at(-1)!];
  if (Object.keys(parent).length === 0) deletePath(root, path.slice(0, -1));
}

export function parseJsonObject(text: string | null, filePath: string): Record<string, unknown> | null {
  if (text === null) return null;
  if (text.trim() === '') return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new FragmentParseError(`${filePath} is not valid JSON: ${(error as Error).message}`); }
  if (!isPlainObject(parsed)) throw new FragmentParseError(`${filePath} must contain a JSON object to be partially managed.`);
  return parsed;
}

/** Stable identity of the material XForge owns; drives the ownership record digest. */
export function fragmentDigest(fragment: Fragment): string {
  return sha256(stableStringify(fragment.format === 'markers'
    ? { format: 'markers', begin: fragment.begin, end: fragment.end, body: fragment.body }
    : { format: 'json', arrays: fragment.arrays ?? [], values: fragment.values ?? [] }));
}

function markerBlock(text: string, fragment: Pick<MarkerFragment, 'begin' | 'end'>): { start: number; end: number; body: string } | null {
  const start = text.indexOf(fragment.begin);
  if (start === -1) return null;
  const end = text.indexOf(fragment.end, start + fragment.begin.length);
  if (end === -1) return null;
  return { start, end: end + fragment.end.length, body: text.slice(start + fragment.begin.length, end).trim() };
}

/**
 * True when the destination no longer carries the material the record says XForge wrote.
 * Everything else in the file may differ freely — that is the point of partial ownership.
 */
export function fragmentDrifted(current: string | null, recorded: Fragment, filePath: string): boolean {
  if (current === null) return true;
  if (recorded.format === 'markers') {
    const block = markerBlock(current, recorded);
    return block === null || block.body !== recorded.body.trim();
  }
  const parsed = parseJsonObject(current, filePath);
  if (!parsed) return true;
  for (const owned of recorded.arrays ?? []) {
    const value = readPath(parsed, owned.path);
    const present = new Set(Array.isArray(value) ? value.map(itemKey) : []);
    if (owned.items.some((item) => !present.has(itemKey(item)))) return true;
  }
  for (const owned of recorded.values ?? []) {
    if (itemKey(readPath(parsed, owned.path)) !== itemKey(owned.value)) return true;
  }
  return false;
}

/** The file content that carries `desired` while preserving everything the user owns. */
export function applyFragment(current: string | null, desired: Fragment, recorded: Fragment | null, filePath: string): string {
  if (desired.format === 'markers') {
    const body = `${desired.begin}\n${desired.body.trim()}\n${desired.end}\n`;
    if (current === null || current.trim() === '') return body;
    const block = markerBlock(current, desired);
    if (block) return `${current.slice(0, block.start)}${body.trimEnd()}${current.slice(block.end)}`;
    return `${current.replace(/\n*$/, '')}\n\n${body}`;
  }
  const parsed = parseJsonObject(current, filePath);
  const next: Record<string, unknown> = parsed ? structuredClone(parsed) : { ...(desired.seed ?? {}) };
  const previous = recorded?.format === 'json' ? recorded : null;

  for (const owned of desired.arrays ?? []) {
    const existing = readPath(next, owned.path);
    const recordedItems = new Set((previous?.arrays ?? []).filter((item) => itemKey(item.path) === itemKey(owned.path)).flatMap((item) => item.items.map(itemKey)));
    const mine = new Set(owned.items.map(itemKey));
    // XForge items first so the governance dispatcher keeps its position; user items follow.
    const theirs = (Array.isArray(existing) ? existing : []).filter((item) => !recordedItems.has(itemKey(item)) && !mine.has(itemKey(item)));
    const merged = [...owned.items, ...theirs];
    if (merged.length === 0) deletePath(next, owned.path);
    else writePath(next, owned.path, merged);
  }
  for (const owned of desired.values ?? []) writePath(next, owned.path, owned.value);

  // Retract material this render no longer produces.
  for (const stale of previous?.arrays ?? []) {
    if ((desired.arrays ?? []).some((item) => itemKey(item.path) === itemKey(stale.path))) continue;
    const existing = readPath(next, stale.path);
    if (!Array.isArray(existing)) continue;
    const drop = new Set(stale.items.map(itemKey));
    const kept = existing.filter((item) => !drop.has(itemKey(item)));
    if (kept.length === 0) deletePath(next, stale.path);
    else writePath(next, stale.path, kept);
  }
  for (const stale of previous?.values ?? []) {
    if ((desired.values ?? []).some((item) => itemKey(item.path) === itemKey(stale.path))) continue;
    if (itemKey(readPath(next, stale.path)) === itemKey(stale.value)) deletePath(next, stale.path);
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * File content after subtracting exactly the recorded material, or `null` when nothing the user
 * owns remains and the file itself should go.
 */
export function removeFragment(current: string, recorded: Fragment, filePath: string): string | null {
  if (recorded.format === 'markers') {
    const block = markerBlock(current, recorded);
    const remainder = block === null ? current : `${current.slice(0, block.start)}${current.slice(block.end)}`;
    return remainder.trim() === '' ? null : `${remainder.replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '')}\n`;
  }
  const parsed = parseJsonObject(current, filePath);
  if (!parsed) return null;
  const next = structuredClone(parsed);
  for (const owned of recorded.arrays ?? []) {
    const existing = readPath(next, owned.path);
    if (!Array.isArray(existing)) continue;
    const drop = new Set(owned.items.map(itemKey));
    const kept = existing.filter((item) => !drop.has(itemKey(item)));
    if (kept.length === 0) deletePath(next, owned.path);
    else writePath(next, owned.path, kept);
  }
  for (const owned of recorded.values ?? []) {
    if (itemKey(readPath(next, owned.path)) === itemKey(owned.value)) deletePath(next, owned.path);
  }
  // The seed was written only because XForge created the file. If nothing but an untouched seed
  // is left, the file exists solely because of XForge and goes with it.
  const seed = recorded.seed ?? {};
  const onlySeedRemains = Object.keys(next).length > 0
    && Object.entries(next).every(([key, value]) => key in seed && itemKey(value) === itemKey(seed[key]));
  if (onlySeedRemains) return null;
  return Object.keys(next).length === 0 ? null : `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * Ownership records written before partial ownership existed describe a file XForge wrote in
 * full. When the destination still matches that record byte for byte, everything currently at the
 * owned locations was ours, so it can be adopted as the recorded fragment without asking the user.
 */
export function adoptWholeFileAsFragment(current: string, desired: Fragment, filePath: string): Fragment | null {
  if (desired.format === 'markers') {
    const block = markerBlock(current, desired);
    return { format: 'markers', begin: desired.begin, end: desired.end, body: block ? block.body : current.trim() };
  }
  const parsed = parseJsonObject(current, filePath);
  if (!parsed) return null;
  return {
    format: 'json',
    ...(desired.seed ? { seed: desired.seed } : {}),
    arrays: (desired.arrays ?? []).map((owned) => {
      const value = readPath(parsed, owned.path);
      return { path: owned.path, items: Array.isArray(value) ? value : [] };
    }),
    values: (desired.values ?? []).flatMap((owned) => {
      const value = readPath(parsed, owned.path);
      return value === undefined ? [] : [{ path: owned.path, value }];
    }),
  };
}
