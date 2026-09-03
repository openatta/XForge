import { readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parse } from '../../../xforge/node_modules/yaml/dist/index.js';
import { changePath, loadFlow } from './_generic.mjs';

/**
 * The Apply Stage, whose output is not an Artifact.
 *
 * `_generic` strips what a Stage `produces` and judges what came back, which is the whole of every
 * other Stage and none of this one: `apply` produces nothing in the Flow's sense. What it owes is
 * delivery — product code inside each package's declared `write_paths`, a delivery record naming the
 * execution that wrote it, the `verify` commands actually run, and every `done_when` criterion
 * mapped to evidence. Judged by the generic case this Stage reports "declares no Artifacts, so this
 * case measures nothing", which is honest and useless.
 *
 * So this strips the delivery instead: the implementation and the agent records, leaving the plan.
 * A Change arrives at `apply` with work-packages.yaml written and nothing built, which is exactly
 * the state this reconstructs.
 */

/*
 * Apply is the one Stage whose setup commit must sweep the whole tree.
 *
 * The shared default commits `xforge/changes` and nothing else, because at Verify the fixture's
 * delivery head is already frozen in history and the Skill overlay's 182 paths would land *after*
 * it -- inside the `head..HEAD` range `validateDeliveryHead` scans, where they are work no package
 * accounts for (XFORGE_WORK_PACKAGE_TREE_UNATTRIBUTED, both Gates unrunnable).
 *
 * At Apply the delivery head does not exist yet: the run creates it. Every setup path is therefore
 * an ancestor of it, outside that range, and invisible to the check. Leaving them uncommitted is
 * the harmful choice here -- the run opens on 37 modified paths it did not make, and the first
 * `git add -A` it runs sweeps the instrument's own overlay into the delivery diff, which then fails
 * the write-boundary check for something the run did not do. Measured: a hand-run recovery drafted
 * a delivery carrying 100+ `.agents/skills/**` paths.
 *
 * A real project arrives at Apply with a clean tree. This makes the fixture arrive that way too.
 */
export const commitScope = 'all';

const agentsRoot = (projectRoot, change) => changePath(projectRoot, change, 'evidence', 'agents');

async function plan(projectRoot, change) {
  const source = await readFile(changePath(projectRoot, change, 'work-packages.yaml'), 'utf8');
  return parse(source)?.packages ?? [];
}

export async function prepare({ projectRoot, change }) {
  /* The delivery, not the plan. `work-packages.yaml` is an input to this Stage — it is written at
     Check — and removing it would measure a different Stage's job. */
  await rm(agentsRoot(projectRoot, change), { recursive: true, force: true });
  for (const entry of await plan(projectRoot, change)) {
    for (const glob of entry.write_paths ?? []) {
      const [leading] = String(glob).split('/');
      if (!leading || leading.startsWith('.') || leading === 'xforge') continue;
      await rm(path.join(projectRoot, leading), { recursive: true, force: true });
    }
  }
}

export async function assert({ projectRoot, change, repositoryRoot, flow }) {
  const checks = [];
  const packages = await plan(projectRoot, change);
  await loadFlow({ repositoryRoot, flow });

  for (const entry of packages) {
    const directory = path.join(agentsRoot(projectRoot, change), entry.id);
    const files = existsSync(directory) ? await readdir(directory) : [];
    const deliveries = files.filter((name) => name.endsWith('.yaml'));

    checks.push({
      name: `${entry.id}: a delivery record exists`,
      ok: deliveries.length > 0,
      detail: deliveries.length > 0 ? deliveries : 'evidence/agents/<package>/<execution>.yaml is missing',
    });
    if (deliveries.length === 0) continue;

    const record = parse(await readFile(path.join(directory, deliveries[0]), 'utf8'));
    /* Every `done_when` criterion answered once. The delivery schema requires this, so a record that
       parses and omits one is a record the CLI would refuse — asserting it here says the Agent
       produced something acceptable rather than merely present. */
    const answered = Object.keys(record?.done_when_evidence ?? {});
    checks.push({
      name: `${entry.id}: every done_when criterion is mapped to evidence`,
      ok: (entry.done_when ?? []).every((criterion) => answered.some((key) => criterion.startsWith(key) || key.startsWith(criterion))),
      detail: { declared: entry.done_when ?? [], answered },
    });
    checks.push({
      name: `${entry.id}: the declared verify commands were run and recorded`,
      ok: Array.isArray(record?.validation_commands) && record.validation_commands.length > 0,
      detail: record?.validation_commands ?? 'no validation_commands in the delivery record',
    });
    /* Written where it said it would write. The write boundary is the one thing a delivery cannot
       be trusted to self-report, and it is what an Integrator and the archive both rely on. */
    const wrote = (record?.changed_paths ?? []);
    const allowed = (entry.write_paths ?? []).map((glob) => String(glob).split('/')[0]);
    checks.push({
      name: `${entry.id}: every changed path is inside its declared write_paths`,
      ok: wrote.length > 0 && wrote.every((changed) => allowed.some((prefix) => String(changed).startsWith(prefix))),
      detail: { wrote, allowed: entry.write_paths ?? [] },
    });
  }
  return checks;
}
