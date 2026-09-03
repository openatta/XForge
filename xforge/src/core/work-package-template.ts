import type { WorkPackagePlan } from '../types/work-package.js';

/**
 * The document header, typed so the compiler answers whether it is still complete.
 *
 * `apiVersion` and `kind` are `const` in `work-package.schema.json`, and the schema is
 * `additionalProperties: false` over `[apiVersion, kind, packages]` — so a plan missing either is
 * refused before any DAG work happens, and `resolveWorkPackages` returns `status: 'unusable'` with
 * the plan discarded. Neither key appeared anywhere an Agent reads: not in a Skill, not in a Flow
 * `instruction` or `outline`, not in `XFORGE.md`. The header was known to every test fixture and to
 * the docs, and to nothing the product ships into a project.
 *
 * That is the `moduleContract` shape exactly, and `NextAction.template` is the answer that incident
 * produced: the shape lives beside the type it has to satisfy, and reaches the Agent as data on the
 * Action rather than as prose a Skill maintains by hand. Typing it as `Pick<WorkPackagePlan, …>`
 * rather than as a string makes a new required document key a compile error here.
 */
const PLAN_HEADER: Pick<WorkPackagePlan, 'apiVersion' | 'kind'> = {
  apiVersion: 'xforge.dev/v1alpha1',
  kind: 'WorkPackagePlan',
};

/**
 * One package, with every field the schema accepts and nothing it does not.
 *
 * Every required field is present -- `skills` included, which is required and is the one most
 * easily read as optional, since a package that names no Skill still sounds well-formed.
 *
 * Written out rather than reduced to the required subset because the optional fields are where the
 * plan is usually wrong: `verify` as an argv array rather than a shell string, `done_when` as
 * criteria rather than a narrative, `depends_on` present and empty rather than absent. A template
 * that showed only `id` and `goal` would be accepted by the schema and would teach the shape that
 * fails at dispatch.
 */
const PACKAGE_SKELETON = [
  '  - id: T001',
  '    # role: integrator   # the one optional field; its write_paths go inside integrator_paths',
  '    goal: <what this package delivers, in one line>',
  '    depends_on: []',
  '    inputs: [<path or Requirement id this package reads>]',
  '    write_paths: [<project-relative glob this package alone may write>]',
  '    skills: [<Skill this package is executed under>]',
  '    # argv arrays, never a shell string: argv[0] is spawned with the rest as literal arguments,',
  '    # so no pipes, redirection or substitution. Needs a shell? Script it under write_paths.',
  '    verify: [[<argv>, <argument>]]',
  '    done_when:',
  '      # A criterion holding `: ` parses as a mapping and is refused as `must be string`.',
  '      # Write those as a block scalar: `- >-` alone on its line, text indented beneath.',
  '      - <observable criterion, checkable without reading the diff>',
];

/**
 * The plan a `create-work-packages` Action offers, with the shape rules on the fields they govern.
 *
 * The rules used to live in `xforge-apply` step 3, which an Agent reads on every entry to the
 * Stage whether or not it is writing a plan. Here they are read once, by whoever is writing one,
 * beside the field each governs -- and they cannot drift from the schema without this file and
 * `work-package.schema.json` disagreeing in one directory.
 *
 * `integrator_paths` is offered commented out rather than empty: reserving surface obliges the plan
 * to carry a `role: integrator` package, so an empty list adopted unread would be a claim the plan
 * does not have to honour, while a populated one adopted unread would oblige a package nobody meant
 * to write.
 */
export function workPackagePlanTemplate(): string {
  return [
    `apiVersion: ${PLAN_HEADER.apiVersion}`,
    `kind: ${PLAN_HEADER.kind}`,
    '# integrator_paths: [<shared surface no worker package may write>]',
    'packages:',
    ...PACKAGE_SKELETON,
    '# These fields and no others, at both levels: the schema is additionalProperties: false.',
    '# change_id, execution_id, commits, branch, worktree and mode are dispatch data, not plan data.',
    '',
  ].join('\n');
}

/** The document keys a plan must carry, for callers that state them rather than render them. */
export const WORK_PACKAGE_PLAN_HEADER_KEYS = Object.keys(PLAN_HEADER) as Array<keyof typeof PLAN_HEADER>;
