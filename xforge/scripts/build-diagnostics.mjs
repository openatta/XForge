#!/usr/bin/env node
/*
 * The diagnostic catalogue, frozen into `dist` at build time.
 *
 * `xforge explain <code>` has to answer from an installed package, and an installed package ships
 * `dist`, `scaffold`, `schemas` and nothing else — there is no `src/` to scan at runtime. So the
 * scan happens here, once, and the command reads what it produced.
 *
 * One implementation, not two: `core/diagnostics-catalogue.ts` is what the suite holds to a golden
 * fingerprint, and it is what this runs. A second copy of the parser living in a build script is how
 * the shipped catalogue and the recorded one come to disagree — and a catalogue that disagrees with
 * the product is worse than none, because it is quoted.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const xforgeRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { readDiagnosticCatalogue } = await import(path.join(xforgeRoot, 'dist', 'core', 'diagnostics-catalogue.js'));

const sites = await readDiagnosticCatalogue(xforgeRoot);

/*
 * Grouped by code, because one code is raised from more than one place and each place says something
 * slightly different. `explain` prints every message a code can carry rather than picking one: which
 * of them a reader met is exactly what they already know, and which they did not is what tells them
 * the code has another cause.
 */
const byCode = new Map();
for (const site of sites) {
  if (!site.code) continue;
  const entry = byCode.get(site.code) ?? { code: site.code, severities: new Set(), sources: [] };
  entry.severities.add(site.severity);
  entry.sources.push({ file: site.file, line: site.line, message: site.message, hasPath: site.hasPath });
  byCode.set(site.code, entry);
}

const catalogue = {
  generatedFrom: 'src/**/*.ts',
  count: byCode.size,
  codes: [...byCode.values()]
    .map((entry) => ({
      code: entry.code,
      severities: [...entry.severities].sort(),
      sources: entry.sources.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line),
    }))
    .sort((left, right) => left.code.localeCompare(right.code)),
};

const target = path.join(xforgeRoot, 'dist', 'diagnostics.json');
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(catalogue, null, 2)}\n`);
process.stdout.write(`Wrote ${catalogue.count} diagnostic codes to dist/diagnostics.json\n`);
