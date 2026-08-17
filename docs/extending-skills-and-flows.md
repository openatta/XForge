[简体中文](extending-skills-and-flows.zh-CN.md) | English

# Extending Skills and Flows

This guide is for anyone adding a custom Skill or a custom Flow to an
XForge-managed project, and for anyone maintaining the built-in Skills and
Flows in this repository. For what a Skill/Flow *is* before extending one,
see [Skills, Flows, Rules, Gates, Hooks, PermissionPolicies, and Approvals](governance-concepts.md);
for the full design rationale see [Flows and Skills](flows-and-skills-design.md).

## Adding a custom Skill

A Skill is a directory containing an English `SKILL.md` and, for any Skill
that should be localized, a Chinese `SKILL_cn.md`. Nothing about a new Skill
needs code changes:

1. Create `xforge/scaffold/skills/<skill-id>/SKILL.md` (+ `SKILL_cn.md`) in
   the project's canonical Scaffold source (`scaffold/payload/xforge/...` if
   you are contributing to XForge itself; `xforge/scaffold/skills/...` in a
   project that has already run `xforge init`).
2. Register `<skill-id>` in `xforge/manifest.yaml` under `scaffold.skills`.
   Sync is manifest-driven, not a directory scan — a Skill folder with no
   manifest entry never gets projected, even if the files are valid.
3. Run `xforge sync --dry-run` then `xforge sync` to project the Skill into
   every enabled target's directory (`.claude/skills/<skill-id>`,
   `.cursor/skills/<skill-id>`, `.opencode/skills/<skill-id>`,
   `.agents/skills/<skill-id>`, `.github/skills/<skill-id>`, and Codex's
   equivalent). Each target then has an independently usable copy.

The `xforge-scaffold` Skill exists to do steps 1–2 for you in one governed
pass — prefer it over hand-editing `manifest.yaml` when an Agent is doing the
work.

### Authoring conventions for a new `SKILL.md`

Follow the shape every built-in Skill already uses:

- **Frontmatter** — `name`, one-line `description` that states both what the
  Skill produces and when to use it, `license`, and `metadata` (`author`,
  `version`, `source` if adapted from elsewhere).
- **Five sections, in order** — `Invariants` (what must always be read/true
  before acting), `Authority` (exactly what paths this Skill may write, and
  an explicit list of what it must not touch), `Execution` (numbered steps),
  `Evidence` (what to report and against which `doneWhen`/`requiredEvidence`),
  `Stop and rework` (when to halt and which Skill owns the fix).
- **Stay Action-driven, not Flow-name-driven.** A Skill should consume the
  current ready Action from `xforge state` and follow that Action's
  `instruction`/`outline`, never hardcode `if flow is quick/solid/major`
  branches or reference another Skill's internal steps. See
  [Where Flow-conditional behavior belongs](#where-flow-conditional-behavior-belongs)
  below — this is the single most common design mistake to avoid, and it was
  an actual bug in `xforge-design` until this guide's companion fix (see the
  case study below).
- **Bilingual pairing is mandatory.** Any edit to `SKILL.md` or `SKILL_cn.md`
  must be mirrored in the other file in the same change — same section
  structure and semantics, not a literal retranslation. See the repository's
  root [`AGENTS.md`](../AGENTS.md).
- **Keep Authority narrow.** State exactly which Artifact paths the Skill may
  write and explicitly list adjacent Artifacts it must not touch (Proposal,
  Specs, Design, Evidence, Archive, etc., as applicable) — this is what lets
  the Flow's stage graph, not the Skill's judgment, be the source of truth for
  sequencing.

## Extending or customizing Flows

Flows are pure data: `xforge/flows/*.yaml`, loaded by reading every file in
that directory and validating it against `xforge/schemas/flow.schema.json`
(`v1alpha2`). There is no TypeScript enum of flow names blocking a new file —
add `xforge/flows/hotfix.yaml` and it loads like `quick`/`solid`/`major` do,
subject to the schema:

- `metadata.name` must match the filename.
- `stages` needs at least 3 entries, each with a unique `id`; the stage graph
  must include `propose`, `apply`, and `verify` (checked by
  `stageGraphDiagnostics` in `flow-resolver.ts`).
- `policy.assuranceLevel` is constrained to `quick | solid | major` — you can
  ship an entirely custom stage graph and governance policy under a new file
  name, but it currently has to declare itself as one of these three
  assurance tiers. A genuinely new tier (a fourth level distinct from all
  three) requires a schema change, not just a new YAML file.

To make a Flow selectable:

- Set it as the project default in `xforge/manifest.yaml`'s `flow:` field.
- Or set it per-Change in that Change's `change.yaml` `flow:` field, which
  overrides the manifest default for that Change only (`xforge-propose`
  inherits the manifest default silently unless the user explicitly asks for
  a different Flow — see Execution step 2 of that Skill).

## Where Flow-conditional behavior belongs

When two Flows need a stage to behave differently, there are three places to
put that difference, in preference order:

1. **Stage presence in the graph (preferred).** If a Flow doesn't need a
   stage at all, omit it — don't ask a Skill to sometimes skip its own work.
   This is why `quick` has no `design` stage: `quick`'s `propose` stage is
   scoped broadly enough (Why/Scope/Non-goals/Success criteria/Requirements
   with scenarios) to not need one, and `xforge-design`'s Action simply never
   becomes ready under `quick`. No Skill contains "if quick, skip design"
   logic anywhere.
2. **Per-Flow artifact `instruction`/`outline` (preferred when the same Skill
   legitimately serves multiple Flows).** `design.md`'s required depth
   differs between `solid` and `major` even though both use the
   `xforge-design` Skill — that difference lives entirely in each Flow
   YAML's `artifacts[].instruction` and `artifacts[].outline` for the
   `design` artifact, not in the Skill's prose. The Skill just has to say
   "follow the current Action's instruction and outline exactly."
3. **Structured stage fields consumed by engine code (last resort, only for
   behavior code must act on).** `stages[].execution.workPackages`
   (`internal | adaptive | required`) is the one case where a Flow-to-Flow
   difference is genuine *runtime* behavior (serial vs. parallel work-package
   dispatch in `xforge-apply`), not just written content — so it is a typed
   schema field the resolver reads, and the Skill references it generically
   ("per Action execution policy") rather than by Flow name.

### Artifact `markers`: telling the tooling what a section is *for*

`outline` says which `## ` sections an Artifact must have. `artifacts[].markers`
says what one of them *means*, which is what lets `xforge brief` compute an
answer instead of asking somebody to read the prose and vouch for it:

```yaml
- id: design
  outline: |
    ## Decisions and alternatives
    ## Test strategy
  markers:
    - id: verification-coverage
      section: Test strategy
      role: requirement-coverage
    - id: rejected-alternative
      section: Decisions and alternatives
      role: decision-alternative
      pattern: ['**Rejected alternative:', '**被否决的替代方案：']
      minOccurrences: 1
```

- `role: requirement-coverage` — this section is where Requirement coverage is
  recorded, so a Requirement missing *from it* is reportable even when the
  Requirement appears elsewhere in the same file.
- `role: decision-alternative` — entries matching `pattern` are rejected
  alternatives, quoted verbatim into the brief.
- `role: declared-gap` — entries matching `pattern` defer a question to a later
  Stage; the brief reports one that no finding ever cites.

`pattern` is a **list** because a Flow is single-sourced while the prose it
governs is localized: one Flow governs a project writing English and one writing
Chinese, so an entry marker that named a single language would silently stop
locating anything in the other.

Two severities, deliberately different. A marker naming a section the Artifact
does not contain is a **warning** — `outline` has always been instruction rather
than enforcement, and promoting a missing section to an error would fail Changes
that were valid before markers existed. `minOccurrences` is an **error**,
because unlike the outline it is a Flow explicitly requiring that a section
carry at least N entries, and only a project that opted in ever reaches it. The
shipped Flows therefore declare `requirement-coverage` sections with no
`minOccurrences`.

A rule keyed on a marker the Flow never declared reports **nothing**. It never
falls back to guessing which section was meant.

**Anti-pattern:** a Skill's own prose branching on a literal Flow name (`"For
Solid, ... For Major, ..."`). This is fragile in a way the three mechanisms
above are not — a new custom Flow (e.g. `hotfix.yaml`) gets silently
mishandled because the Skill has never heard of it. `xforge-design` is the
concrete illustration: `solid.yaml`/`major.yaml` already carry different
`instruction`/`outline` text for the `design` artifact, so the Skill's own
`SKILL.md`/`SKILL_cn.md` only need to say "follow the current Action's
instruction and outline exactly" — restating "For Solid... For Major..." in
the Skill's prose would just duplicate data the Flow YAMLs already carry,
and would silently miss a fourth custom Flow.

## Checklist

New Skill:

- [ ] `SKILL.md` + `SKILL_cn.md` created, same structure, mirrored semantics
- [ ] Five standard sections present; Authority lists exactly what may/may
      not be written
- [ ] No Flow-name branching in the Skill's own prose
- [ ] Registered in `manifest.yaml`'s `scaffold.skills`
- [ ] `xforge sync --dry-run` reviewed, then `xforge sync` run

New or modified Flow:

- [ ] `metadata.name` matches the filename
- [ ] `stages` includes `propose`, `apply`, `verify`; unique stage `id`s
- [ ] `policy.assuranceLevel` set to the correct tier
- [ ] Flow-specific content depth expressed via `artifacts[].instruction`/
      `outline`, not via new Skill prose
- [ ] Genuine runtime-behavior differences expressed via a typed
      `execution`-style field, not a Flow-name string check
- [ ] Selectable via `manifest.yaml` `flow:` or a Change's `change.yaml`
      `flow:`
