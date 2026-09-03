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
 * Written out rather than reduced to the required subset because the optional fields are where the
 * plan is usually wrong: `verify` as an argv array rather than a shell string, `done_when` as
 * criteria rather than a narrative, `depends_on` present and empty rather than absent. A template
 * that showed only `id` and `goal` would be accepted by the schema and would teach the shape that
 * fails at dispatch.
 */
const PACKAGE_SKELETON = [
  '  - id: T001',
  '    goal: <what this package delivers, in one line>',
  '    depends_on: []',
  '    inputs: [<path or Requirement id this package reads>]',
  '    write_paths: [<project-relative glob this package alone may write>]',
  '    verify: [[<argv>, <argument>]]',
  '    done_when:',
  '      - <observable criterion, checkable without reading the diff>',
];

/**
 * The plan a `create-work-packages` Action offers.
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
    '',
  ].join('\n');
}

/** The document keys a plan must carry, for callers that state them rather than render them. */
export const WORK_PACKAGE_PLAN_HEADER_KEYS = Object.keys(PLAN_HEADER) as Array<keyof typeof PLAN_HEADER>;
