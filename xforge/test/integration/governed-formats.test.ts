import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { golden } from '../golden.js';
import { repositoryRoot, xforgeRoot } from '../helpers.js';
import { SCHEMA_NAMES } from '../../src/core/validator.js';

/**
 * Every governed file format, and what actually enforces it.
 *
 * XForge is a file reader and a file writer. Almost all of its behaviour is "load this file, decide
 * whether it is well formed, decide what it says, write that file" — so the set of formats it
 * governs, and the question of which of them a machine checks, is the product's real surface. It was
 * the one surface with no recording, while diagnostics, published exports and claimed path
 * namespaces all had one.
 *
 * Two things this makes visible that were previously spread across twenty-one schema files and a
 * handful of `*_PATH` constants:
 *
 * - **A schema that nothing validates against is not a format, it is a document.** `ajv` compiles
 *   every name in `SCHEMA_NAMES` at startup, so a schema with no call site looks maintained from the
 *   inside and enforces nothing.
 * - **A ledger with no schema is validated by whatever its reader happens to check.** The three the
 *   Agent writes — the findings ledger, the Constitution ledger, the verification receipt — are
 *   parsed by hand, which is also where three field reports found their sharpest edges.
 *
 * The recording is the deliverable. Adding a format, or dropping the last thing that enforces one,
 * is a diff here rather than a discovery later.
 */
describe('governed file formats', () => {
  /** Source of every module under `src`, keyed by its repository-relative POSIX path. */
  async function sources(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    async function walk(directory: string): Promise<void> {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) { await walk(absolute); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        result.set(path.relative(xforgeRoot, absolute).split(path.sep).join('/'), await readFile(absolute, 'utf8'));
      }
    }
    await walk(path.join(xforgeRoot, 'src'));
    return result;
  }

  /**
   * The modules that submit a document of this format to `validateSchema`.
   *
   * Two spellings, because there are two. Most callers name the schema literally; the six flat
   * resource kinds reach it through `loadFlatResource`, which takes the name as its fourth argument
   * — a scan for the literal call alone reported agents, gates, rules, hooks, policies and
   * McpServers as unenforced, which is the opposite of true.
   */
  function enforcedBy(modules: Map<string, string>, schema: string): string[] {
    const found: string[] = [];
    for (const [file, source] of modules) {
      const lines = source.split('\n').filter((line) => line.includes(`'${schema}'`));
      if (lines.some((line) => line.includes('validateSchema') || line.includes('loadFlatResource'))) found.push(file);
    }
    return found.sort();
  }

  it('records every schema and what enforces it', async () => {
    const modules = await sources();
    const schemaDirectory = path.join(xforgeRoot, 'schemas');
    const files = new Set((await readdir(schemaDirectory)).map((name) => name.replace(/\.schema\.json$/, '')));

    const rows = [...SCHEMA_NAMES].sort().map((schema) => {
      const enforcers = enforcedBy(modules, schema);
      return `${schema}  schema=${files.has(schema) ? 'yes' : 'MISSING'}  enforced-by=${enforcers.length > 0 ? enforcers.join(',') : 'NOTHING'}`;
    });

    /* A schema file nobody names is the other half of the same question, and is invisible from the
       union alone. */
    for (const orphan of [...files].filter((name) => !SCHEMA_NAMES.includes(name as never)).sort()) {
      rows.push(`${orphan}  schema=yes  enforced-by=NOTHING (not in SCHEMA_NAMES)`);
    }

    const { actual, expected } = await golden('contracts/governed-formats.txt', `${rows.sort().join('\n')}\n`);
    expect(actual).toBe(expected);
  });

  it('records the ledgers a Change carries that no schema describes', async () => {
    const modules = await sources();
    const rows: string[] = [];
    for (const [file, source] of modules) {
      /*
       * A `*_PATH` constant naming a YAML file inside a Change is a governed ledger by construction:
       * the product would not have a name for it otherwise. Whether a schema covers it is the
       * question — these are the files an Agent writes by hand, so they are the ones where "the
       * reader happens to check" is most expensive.
       */
      for (const match of source.matchAll(/export const ([A-Z_]+_PATH) = '([^']+\.yaml)'/g)) {
        rows.push(`${match[2]}  const=${match[1]}  parsed-by=${file}  schema=NONE (hand-written validation)`);
      }
    }
    expect(rows.length).toBeGreaterThan(0);
    const { actual, expected } = await golden('contracts/unschemad-ledgers.txt', `${rows.sort().join('\n')}\n`);
    expect(actual).toBe(expected);
  });

  it('holds the shipped Constitution to the schema that describes it', async () => {
    /*
     * `constitution.schema.json` is in `schemas/` and in no `SCHEMA_NAMES` list, so `ajv` never
     * compiled it and nothing ever ran it. A schema in that state does not merely fail to enforce —
     * it drifts, undetectably, and this one had: it declares `ratified` a string, while YAML parses
     * an unquoted `2026-08-08` into a `Date`. Anything validating the raw frontmatter would have
     * failed on the Constitution this repository ships.
     *
     * `readConstitution` normalises those values to strings before anyone sees them, which is the
     * form the schema's own description names ("parsed frontmatter"). Validating that form is what
     * makes the file true, and this test is what enforces it.
     */
    const { readConstitution } = await import('../../src/core/constitution.js');
    const { constitution, diagnostics } = await readConstitution(path.join(repositoryRoot, 'scaffold', 'payload'));
    expect(diagnostics.map((item) => item.code)).toEqual([]);

    const schema = JSON.parse(await readFile(path.join(xforgeRoot, 'schemas', 'constitution.schema.json'), 'utf8')) as Record<string, unknown>;
    const { Ajv2020 } = await import('ajv/dist/2020.js');
    const addFormats = (await import('ajv-formats')).default as unknown as (instance: InstanceType<typeof Ajv2020>) => unknown;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    const frontmatter = { version: constitution.version, ratified: constitution.ratified, lastAmended: constitution.lastAmended };
    expect(validate(frontmatter), JSON.stringify(validate.errors)).toBe(true);
    /* And the schema covers exactly the frontmatter, so a field added to one is missing from the
       other rather than silently unchecked. */
    expect(Object.keys(schema.properties as object).sort()).toEqual(Object.keys(frontmatter).sort());
  });

  it('writes audit events that match the schema it publishes for them', async () => {
    /*
     * `audit-event` is compiled at startup and has no call site: events are built from a typed input
     * and appended, so nothing ever submits one to `validateSchema`. Wiring it into `verifyAudit`
     * would be the obvious move and the wrong one — every project whose log was written by an
     * earlier CLI would fail verification on upgrade, for a format question that has nothing to do
     * with whether the chain is intact.
     *
     * The writer is what can be held to it. This runs real commands, reads what they appended, and
     * validates every line: the format is enforced where a violation is a defect rather than where
     * it would be somebody else's outage.
     */
    const { advanceSolidToApply, createCompleteSolidChange, fixture } = await import('../helpers.js');
    const { validateSchema } = await import('../../src/core/validator.js');
    const root = await fixture();
    /* A governed run, because that is what appends: transitions, Gate runs and approvals each write
       an event, and a bare `state` writes none. */
    await createCompleteSolidChange(root);
    await advanceSolidToApply(root);

    const logs: string[] = [];
    async function collect(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(absolute);
        else if (entry.name.endsWith('.jsonl')) logs.push(await readFile(absolute, 'utf8'));
      }
    }
    await collect(path.join(root, 'xforge', '.audit'));

    const events = logs.flatMap((source) => source.split('\n').filter((line) => line.trim().length > 0));
    expect(events.length).toBeGreaterThan(0);
    for (const line of events) {
      const diagnostics = await validateSchema('audit-event', JSON.parse(line), 'events.jsonl');
      expect(diagnostics.map((item) => item.message), line).toEqual([]);
    }
  }, 600_000);

  it('compiles a validator for every name it claims to validate', async () => {
    /*
     * The runtime half. The recording above reads source; this asks the validator itself, so a
     * schema that is named, present and unparseable fails here rather than at the first project that
     * happens to contain one.
     */
    const { validateSchema } = await import('../../src/core/validator.js');
    for (const schema of SCHEMA_NAMES) {
      const diagnostics = await validateSchema(schema, {}, 'probe.yaml');
      /* `{}` is invalid for every one of these, which is the point: a compiled validator produces
         diagnostics, and a missing one would throw. */
      expect(diagnostics.every((item) => item.code === 'XFORGE_SCHEMA_INVALID'), schema).toBe(true);
    }
  });
});
