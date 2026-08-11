#!/usr/bin/env node
// Minimal existing "notes" CLI, seeded only as exploration material for the
// standalone xforge-explore live-engine scenario. It intentionally has no
// "recently completed" view yet — that gap is what the Explore prompt asks
// the model to investigate and scope, without implementing it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const storePath = process.env.NOTES_STORE_FILE ?? '.notes/notes.json';

function load() {
  if (!existsSync(storePath)) return { notes: [] };
  return JSON.parse(readFileSync(storePath, 'utf8'));
}
function save(state) {
  mkdirSync(path.dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(state));
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'add') {
  const text = rest.join(' ').trim();
  const state = load();
  state.notes.push({ id: state.notes.length + 1, text, done: false });
  save(state);
  process.stdout.write(`${JSON.stringify({ ok: true, data: { note: state.notes.at(-1) }, diagnostics: [] })}\n`);
} else if (command === 'list') {
  const state = load();
  process.stdout.write(`${JSON.stringify({ ok: true, data: { notes: state.notes }, diagnostics: [] })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ ok: false, data: null, diagnostics: [{ code: 'USAGE_ERROR', message: 'Unknown command.' }] })}\n`);
  process.exit(2);
}
