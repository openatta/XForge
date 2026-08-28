import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { golden } from '../golden.js';
import { fixture, repositoryRoot, runCli } from '../helpers.js';

/**
 * Every command a Skill tells an Agent to run, checked against the CLI that has to accept it.
 *
 * A Skill is prose the suite never read and a CLI is a parser the suite never compared it to, which
 * is the same gap `skill-cli-contract.test.ts` closes for *paths*. This closes it for *commands*:
 * a Skill naming a flag the command does not take, or a subcommand that was renamed, produces an
 * Agent that follows its instructions exactly and gets a refusal — and the failure looks like a
 * model problem, so it gets debugged as one.
 *
 * The authority is `xforge help`, not the source. That is deliberate: the help envelope is what a
 * reader and an Agent actually get, so a command that exists in `cli.ts` and is missing from help is
 * a defect this test should fail on rather than paper over by reading around it.
 *
 * Two recordings come out of it, and the second is the one worth watching. **What the Skills name**
 * moves when a Skill is rewritten. **What the CLI has that no Skill names** moves when the product
 * grows a capability its instructions never learned about — which is how `verification finalize`
 * can exist, be pointed at by a diagnostic, and still never be run by any Agent following a Skill.
 */
describe('Skill and CLI command contract', () => {
  const skillsRoot = path.join(repositoryRoot, 'scaffold', 'payload', 'xforge', 'scaffold', 'skills');

  /** One invocation a Skill instructs: the command, its subcommand when it has one, and its flags. */
  interface Invocation {
    skill: string;
    command: string;
    subcommand: string | null;
    flags: string[];
    text: string;
  }

  /**
   * Every `xforge …` a Skill spells out, from inline code spans and fenced blocks alike.
   *
   * Both, because the Skills use both and an instruction is an instruction wherever it is printed.
   * A span whose first token is a placeholder (`xforge <command>`) is documentation of the shape
   * rather than a command, and is skipped — matching it against the command table would report the
   * angle brackets as an unknown command.
   */
  async function invocations(): Promise<Invocation[]> {
    const found: Invocation[] = [];
    for (const skill of (await readdir(skillsRoot)).sort()) {
      for (const file of (await readdir(path.join(skillsRoot, skill))).filter((name) => name.endsWith('.md')).sort()) {
        const source = await readFile(path.join(skillsRoot, skill, file), 'utf8');
        const spans = [
          ...[...source.matchAll(/`([^`\n]*)`/g)].map((match) => match[1]!),
          ...source.split('\n').filter((line) => line.trim().startsWith('xforge ')).map((line) => line.trim()),
        ];
        for (const span of spans) {
          const trimmed = span.trim();
          if (!trimmed.startsWith('xforge ')) continue;
          const tokens = trimmed.split(/\s+/).slice(1);
          const command = tokens[0];
          if (!command || !/^[a-z][a-z-]*$/.test(command)) continue;
          const second = tokens[1];
          const subcommand = second && /^[a-z][a-z-]*$/.test(second) ? second : null;
          found.push({
            skill: `${skill}/${file}`,
            command,
            subcommand,
            flags: [...new Set(tokens.filter((token) => /^--[a-z][a-z-]*$/.test(token)))].sort(),
            text: trimmed,
          });
        }
      }
    }
    return found;
  }

  /** The command table and per-command options, as the CLI itself reports them. */
  async function cliSurface(): Promise<{ commands: string[]; options: Map<string, string[]>; usage: Map<string, string>; globalOptions: Set<string> }> {
    const root = await fixture();
    const general = await runCli(root, ['help']);
    expect(general.code).toBe(0);
    const commands = Object.keys(general.json.data.commands as Record<string, string>).sort();
    const options = new Map<string, string[]>();
    const usage = new Map<string, string>();
    for (const command of commands) {
      const help = await runCli(root, ['help', command]);
      expect(help.code, command).toBe(0);
      options.set(command, (help.json.data.commandHelp?.options ?? []) as string[]);
      usage.set(command, (help.json.data.commandHelp?.usage ?? '') as string);
    }
    return { commands, options, usage, globalOptions: new Set(Object.keys(general.json.data.globalOptions ?? {}).map((entry) => entry.split(' ')[0]!)) };
  }

  it('never names a command or flag the CLI does not accept', async () => {
    const surface = await cliSurface();
    const problems: string[] = [];

    for (const invocation of await invocations()) {
      if (!surface.commands.includes(invocation.command)) {
        problems.push(`${invocation.skill} instructs "${invocation.text}", and xforge has no ${invocation.command} command`);
        continue;
      }
      /*
       * A subcommand is checked against the usage rather than a list, because the CLI reports group
       * commands as several usage lines and never as an enumeration. `xforge verification finalize`
       * appears in `verification`'s usage; `xforge verification finalise` does not.
       */
      const usage = surface.usage.get(invocation.command) ?? '';
      if (invocation.subcommand && usage.includes(`${invocation.command} <`) === false && !usage.includes(`${invocation.command} ${invocation.subcommand}`)) {
        problems.push(`${invocation.skill} instructs "${invocation.text}", and ${invocation.command} has no ${invocation.subcommand} subcommand`);
        continue;
      }
      const accepted = surface.options.get(invocation.command) ?? [];
      for (const flag of invocation.flags) {
        if (accepted.includes(flag)) continue;
        problems.push(`${invocation.skill} instructs "${invocation.text}", and ${invocation.command} does not accept ${flag}`);
      }
    }

    /*
     * Empty, not recorded. A Skill naming a flag the command refuses is not a debt to track: an
     * Agent that follows it gets a refusal the first time, and the refusal reads as the model having
     * invented something.
     */
    expect([...new Set(problems)].sort()).toEqual([]);
  }, 600_000);

  it('records which commands each Skill instructs', async () => {
    const rows = [...new Set((await invocations()).map((item) => `${item.command}${item.subcommand ? ` ${item.subcommand}` : ''}  <- ${item.skill}`))].sort();
    expect(rows.length).toBeGreaterThan(10);
    const { actual, expected } = await golden('contracts/skill-commands.txt', `${rows.join('\n')}\n`);
    expect(actual).toBe(expected);
  }, 600_000);

  /**
   * Subcommands a command's usage declares, in the two forms the CLI writes them.
   *
   * One usage line per subcommand (`verification declare …`, `verification retire …`), and an
   * enumeration in one line (`work-package <dispatch|draft|acknowledge>`). Both are what a reader
   * sees, so both count.
   */
  function subcommandsOf(command: string, usage: string): string[] {
    const found = new Set<string>();
    for (const line of usage.split('\n')) {
      const after = line.slice(line.indexOf(`${command} `) + command.length + 1).trim();
      if (!after) continue;
      const token = after.split(/\s+/)[0] ?? '';
      if (/^[a-z][a-z-]*$/.test(token)) found.add(token);
      const enumerated = /^<([a-z][a-z|-]*)>/.exec(token);
      if (enumerated) for (const part of enumerated[1]!.split('|')) found.add(part);
    }
    return [...found].sort();
  }

  it('records the commands the CLI has that no Skill mentions', async () => {
    /*
     * The drift that costs the most and shows the least. A capability the product grew and its
     * instructions never learned about is unreachable in practice: no Agent following a Skill will
     * ever run it, however good it is, and the diagnostics that point at it are pointing at
     * something the reader has never been told exists.
     *
     * Recorded rather than asserted empty — some commands are deliberately not Skill-facing
     * (`hook` is dispatched by the runtime, `version` is for a person) — so the list is a thing to
     * read at review time, and each entry either earns its place or names work.
     */
    const surface = await cliSurface();
    const invoked = await invocations();
    const named = new Set(invoked.map((item) => item.command));
    const namedLeaves = new Set(invoked.filter((item) => item.subcommand).map((item) => `${item.command} ${item.subcommand}`));

    const unmentioned = surface.commands.filter((command) => !named.has(command)).sort();
    /*
     * Down to the subcommand, because that is where the drift hides. `verification` is named by four
     * Skills, so a command-level list reports it as covered while `verification finalize` — added
     * after those Skills were written, and pointed at by a diagnostic — is instructed by none of
     * them.
     */
    for (const command of surface.commands) {
      if (!named.has(command)) continue;
      for (const leaf of subcommandsOf(command, surface.usage.get(command) ?? '')) {
        if (!namedLeaves.has(`${command} ${leaf}`)) unmentioned.push(`${command} ${leaf}`);
      }
    }
    const { actual, expected } = await golden('contracts/skill-unmentioned-commands.txt', `${unmentioned.sort().join('\n')}\n`);
    expect(actual).toBe(expected);
  }, 600_000);

  it('records the flags the CLI accepts that no Skill mentions', async () => {
    /*
     * The other half of the drift, and the half that hid for longest.
     *
     * The unmentioned-*commands* list above could not see `--compact`: `brief` was named by four
     * Skills, so the command counted as taught while the flag that folded its thirty-four kilobytes
     * was mentioned by none of them — deliberately, on a reasoning that a field report later showed
     * to be wrong. A person cannot choose an option they are never told about when an Agent is the
     * one running the command.
     *
     * Recorded rather than asserted empty, on the same footing as the command list: some flags are
     * genuinely not Skill-facing (`--root`, `--text`, `--force`), and each entry either earns its
     * place at review or names work.
     */
    const surface = await cliSurface();
    /*
     * Flags a Skill names anywhere, not only inside an `xforge …` span.
     *
     * The first version counted only flags spelled inside a full invocation, and so reported
     * `--all-gates` and `--field` as untaught while `xforge-check` and `xforge-verify` each spend a
     * sentence explaining them in prose. A contract that invents drift is as costly as one that
     * misses it: somebody goes and "fixes" a Skill that was already right.
     */
    const prose = new Set<string>();
    for (const skill of (await readdir(skillsRoot)).sort()) {
      for (const file of (await readdir(path.join(skillsRoot, skill))).filter((name) => name.endsWith('.md'))) {
        for (const match of (await readFile(path.join(skillsRoot, skill, file), 'utf8')).matchAll(/`(--[a-z][a-z-]*)`/g)) {
          prose.add(match[1]!);
        }
      }
    }
    const named = new Set([...(await invocations()).flatMap((item) => item.flags), ...prose]);
    const rows: string[] = [];
    for (const command of surface.commands) {
      for (const flag of (surface.options.get(command) ?? []).sort()) {
        /* Global options are not per-command flags and no Skill should be naming them per command;
           listing them once per command would bury the entries that mean something under sixty
           repetitions of `--root` and `--text`. */
        if (surface.globalOptions.has(flag)) continue;
        if (!named.has(flag)) rows.push(`${command} ${flag}`);
      }
    }
    const { actual, expected } = await golden('contracts/skill-unmentioned-flags.txt', `${rows.sort().join('\n')}\n`);
    expect(actual).toBe(expected);
  }, 600_000);

  it('keeps both language variants of a Skill instructing the same commands', async () => {
    /*
     * A translated Skill is the same instructions in another language, and the commands are not part
     * of the language. A `_cn` variant that names a command its English sibling does not — or misses
     * one it has — is a Skill that behaves differently depending on which locale a project installed,
     * which no reader of either file can see.
     */
    const byBase = new Map<string, Map<string, Set<string>>>();
    for (const invocation of await invocations()) {
      const [skill, file] = invocation.skill.split('/') as [string, string];
      const variant = file.includes('_cn') ? 'cn' : 'en';
      const commands = byBase.get(skill) ?? new Map<string, Set<string>>();
      const set = commands.get(variant) ?? new Set<string>();
      set.add(`${invocation.command}${invocation.subcommand ? ` ${invocation.subcommand}` : ''}`);
      commands.set(variant, set);
      byBase.set(skill, commands);
    }

    const divergent: string[] = [];
    for (const [skill, variants] of byBase) {
      const en = variants.get('en');
      const cn = variants.get('cn');
      if (!en || !cn) continue;
      for (const command of en) if (!cn.has(command)) divergent.push(`${skill}: SKILL.md instructs "${command}" and SKILL_cn.md does not`);
      for (const command of cn) if (!en.has(command)) divergent.push(`${skill}: SKILL_cn.md instructs "${command}" and SKILL.md does not`);
    }
    expect(divergent.sort()).toEqual([]);
  }, 600_000);
});
