import { describe, expect, it } from 'vitest';
import { detectToolchains } from '../../src/core/toolchain.js';
import { loadProject } from '../../src/core/project-loader.js';
import { clearVerification, createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

/**
 * Every build-system marker XForge recognises, against the four answers a declared Gate can give.
 *
 * XForge is language-agnostic everywhere that matters — the Flow graph, the門禁, the receipts, the
 * archive are the same whatever the project is written in. Exactly three surfaces are not, and this
 * file is all three:
 *
 * 1. **Detection.** Sixteen of the seventeen markers in `core/toolchain.ts` had never been asserted;
 *    the one that had was `package.json`.
 * 2. **Exit-code classification.** The whole `builtin: declared` design exists because
 *    `npm test --if-present` exits 254 on a project with no tests rather than the 127 the runner
 *    reads as "tool missing" — so a guard written for one runner reported a pass having asserted
 *    nothing. Every language answers differently: `cargo` exits 101 on panic, `ctest` 8 on a failed
 *    test, `go test` 1, `mvn` 1. Only 127 and a spawn failure may ever mean "the tool is absent";
 *    everything else is a failing check, and confusing the two is how a Gate goes green empty.
 * 3. **Coverage arithmetic.** Two markers under one root must each be named.
 *
 * Deliberately no real toolchain is installed or invoked. A stub that exits with a chosen code
 * tests XForge's classification exactly; running the genuine `cargo test` would test cargo, cost a
 * toolchain install per language in CI, and answer a question nobody asked.
 */

interface Toolchain {
  id: string;
  file: string;
  content: string;
  /** What the real runner exits with when its tests fail — never 127, for any of them. */
  failure: number;
  /** A fragment of the command `core/toolchain.ts` suggests for `unit-tests`, when it has one. */
  suggests?: string;
}

const TOOLCHAINS: Toolchain[] = [
  { id: 'node', file: 'package.json', content: '{"name":"demo","version":"1.0.0"}\n', failure: 254, suggests: 'npm test' },
  { id: 'rust', file: 'Cargo.toml', content: '[package]\nname = "demo"\n', failure: 101, suggests: 'cargo test' },
  { id: 'go', file: 'go.mod', content: 'module demo\n\ngo 1.22\n', failure: 1, suggests: 'go test ./...' },
  { id: 'python-pyproject', file: 'pyproject.toml', content: '[project]\nname = "demo"\n', failure: 1, suggests: 'pytest' },
  { id: 'python-setup', file: 'setup.py', content: 'from setuptools import setup\nsetup()\n', failure: 1, suggests: 'pytest' },
  { id: 'maven', file: 'pom.xml', content: '<project><artifactId>demo</artifactId></project>\n', failure: 1, suggests: 'mvn -q verify' },
  { id: 'gradle', file: 'build.gradle', content: "apply plugin: 'java'\n", failure: 1, suggests: 'gradle test' },
  { id: 'gradle-kts', file: 'build.gradle.kts', content: 'plugins { java }\n', failure: 1, suggests: 'gradle test' },
  { id: 'ruby', file: 'Gemfile', content: "source 'https://rubygems.org'\n", failure: 1, suggests: 'bundle exec rspec' },
  { id: 'php', file: 'composer.json', content: '{"name":"demo/demo"}\n', failure: 1, suggests: 'composer test' },
  { id: 'elixir', file: 'mix.exs', content: 'defmodule Demo.MixProject do\nend\n', failure: 1, suggests: 'mix test' },
  { id: 'swift', file: 'Package.swift', content: '// swift-tools-version:5.9\n', failure: 1, suggests: 'swift test' },
  { id: 'dotnet', file: 'global.json', content: '{"sdk":{"version":"8.0.0"}}\n', failure: 1, suggests: 'dotnet test' },
  { id: 'cmake', file: 'CMakeLists.txt', content: 'cmake_minimum_required(VERSION 3.20)\n', failure: 8, suggests: 'ctest' },
  { id: 'zig', file: 'build.zig', content: 'pub fn build() void {}\n', failure: 1, suggests: 'zig build test' },
  { id: 'deno', file: 'deno.json', content: '{"tasks":{}}\n', failure: 1, suggests: 'deno test' },
  { id: 'bazel', file: 'MODULE.bazel', content: 'module(name = "demo")\n', failure: 1, suggests: 'bazel test //...' },
];

/** A command that exits with `code` and nothing else — the toolchain stand-in. */
const stub = (code: number): string => JSON.stringify([process.execPath, '-e', `process.exit(${code})`]);

async function declare(root: string, gate: string, command: string): Promise<void> {
  const result = await runCli(root, ['verification', 'declare', '--gate-name', gate, '--command', command, '--by', 'owner@example.test']);
  if (result.code !== 0) throw new Error(`declare failed: ${JSON.stringify(result.json?.diagnostics)}`);
}

/** A project carrying exactly one marker, with nothing declared for `unit-tests`. */
async function projectFor(toolchain: Toolchain): Promise<string> {
  const root = await fixture();
  await clearVerification(root);
  await createCompleteSolidChange(root);
  await write(root, toolchain.file, toolchain.content);
  return root;
}

async function unitTests(root: string): Promise<any> {
  return runCli(root, ['check', '--change', 'add-feature', '--gate', 'unit-tests']);
}

describe('toolchain matrix', () => {
  it.each(TOOLCHAINS)('detects $id from $file', async (toolchain) => {
    const root = await projectFor(toolchain);
    const detected = await detectToolchains(await loadProject(root, { exactRoot: true }));
    const found = detected.find((item) => item.marker === toolchain.file);
    expect(found, `${toolchain.file} was not detected`).toBeTruthy();
    expect(found!.id).toBe(toolchain.id);
  });

  /*
   * Undeclared is a refusal, never a pass — the single rule the declared Gate exists to enforce,
   * asserted once per language because the guard it replaced was written for one of them.
   */
  it.each(TOOLCHAINS)('refuses rather than passing when $id has declared nothing', async (toolchain) => {
    const root = await projectFor(toolchain);
    const result = await unitTests(root);
    expect(result.code).toBe(1);
    expect(result.json.data.gates[0].status).toBe('failed');
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_VERIFICATION_NOT_DECLARED');
    /* The suggestion is offered, and offered as a question — never adopted on the Agent's own say-so. */
    if (toolchain.suggests) expect(result.json.nextActions[0].reason).toContain(toolchain.suggests);
    expect(result.json.nextActions[0].reason).toContain('Do not guess');
    /* And it points at the command, not at a hand edit of the governed Manifest. */
    expect(result.json.nextActions[0].reason).toContain('xforge verification declare');
  });

  it.each(TOOLCHAINS)('passes $id only on exit 0, and calls its real failure code a failure', async (toolchain) => {
    const passing = await projectFor(toolchain);
    await declare(passing, 'unit-tests', stub(0));
    const green = await unitTests(passing);
    expect(green.code, JSON.stringify(green.json?.diagnostics)).toBe(0);
    expect(green.json.data.gates[0].status).toBe('passed');

    /*
     * The classification that matters: this project's real non-zero exit means the check failed.
     * Reading any of these as "the tool is missing" is how a Gate reports success having run
     * nothing, which is the defect the declared Gate was introduced to remove.
     */
    const failing = await projectFor(toolchain);
    await declare(failing, 'unit-tests', stub(toolchain.failure));
    const red = await unitTests(failing);
    expect(red.code).toBe(1);
    expect(red.json.data.gates[0].status).toBe('failed');
    const codes = red.json.diagnostics.map((item: any) => item.code);
    expect(codes).toContain('XFORGE_GATE_FAILED');
    expect(codes, `exit ${toolchain.failure} must not read as a missing tool`).not.toContain('XFORGE_GATE_COMMAND_UNAVAILABLE');
  });

  /*
   * 127 and a spawn failure are the only two things that mean "the tool is absent", and they get
   * their own diagnostic because the repair is different: install something, versus fix the code.
   */
  it('separates a missing tool from a failing check', async () => {
    const notFound = await projectFor(TOOLCHAINS[0]!);
    await declare(notFound, 'unit-tests', stub(127));
    const exit127 = await unitTests(notFound);
    expect(exit127.code).toBe(1);
    expect(exit127.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_GATE_COMMAND_UNAVAILABLE');

    const absent = await projectFor(TOOLCHAINS[1]!);
    await declare(absent, 'unit-tests', JSON.stringify(['xforge-no-such-toolchain-anywhere', 'test']));
    const spawnFailed = await unitTests(absent);
    expect(spawnFailed.code).toBe(1);
    const unavailable = spawnFailed.json.diagnostics.find((item: any) => item.code === 'XFORGE_GATE_COMMAND_UNAVAILABLE');
    expect(unavailable, 'an executable that does not exist is a missing tool, not a failing check').toBeTruthy();
    expect(unavailable.details.reason).toBe('spawn-failed');
  });

  /*
   * A project that grows a second toolchain. One declared command can no longer stand for both:
   * "the command they already had probably covers it" is the guess that produced an empty green
   * Gate in the first place, so each marker must be named by a `covers` entry or a dismissal.
   */
  it('requires every marker to be named once a project carries two', async () => {
    const root = await projectFor(TOOLCHAINS[1]!);
    await write(root, 'package.json', '{"name":"demo","version":"1.0.0"}\n');
    await declare(root, 'unit-tests', stub(0));

    const uncovered = await unitTests(root);
    expect(uncovered.code).toBe(1);
    const finding = uncovered.json.diagnostics.find((item: any) => item.code === 'XFORGE_VERIFICATION_TOOLCHAIN_UNCOVERED');
    expect(finding, 'two markers and one unqualified command must not pass').toBeTruthy();

    /* Both answers close it: a command that names what it covers, plus a justified dismissal. */
    await clearVerification(root);
    const named = await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests',
      '--command', stub(0), '--covers', JSON.stringify(['Cargo.toml']), '--by', 'owner@example.test']);
    expect(named.code, JSON.stringify(named.json?.diagnostics)).toBe(0);
    const dismissed = await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests',
      '--not-applicable', 'package.json', '--justification', 'The Node marker is tooling only; it ships no runtime code.',
      '--by', 'owner@example.test']);
    expect(dismissed.code, JSON.stringify(dismissed.json?.diagnostics)).toBe(0);

    const settled = await unitTests(root);
    expect(settled.code, JSON.stringify(settled.json?.diagnostics)).toBe(0);
    expect(settled.json.data.gates[0].status).toBe('passed');
  });
});
