# Adapter matrix (protocol 1)

| Target | Skills | Commands/prompts | Agents | Rules | Hooks |
|---|---|---|---|---|---|
| Claude | native `.claude/skills` | native `.claude/commands/xforge` | native | native | unsupported |
| Codex | native `.agents/skills` | skills only | unsupported | degraded via root `AGENTS.md` | unsupported |
| Cursor | native `.cursor/skills` | native `.cursor/commands` | native | native | unsupported |
| OpenCode | native `.opencode/skills` | native `.opencode/commands` | native | degraded via root `AGENTS.md` | unsupported |
| GitHub Copilot | native `.github/skills` | native `.github/prompts` | native | native | unsupported |

`degraded` means an adjacent project convention can carry guidance but XForge
does not generate a semantically equivalent resource. `unsupported` produces
no file and is always reported; successful filesystem writes are never used to
claim unsupported behavior.

The default sub-Agent resources are `worker`, `integrator`, and `reviewer`.
`native` means XForge can install their project-level definitions; it does not
claim that XForge creates model processes, provisions worktrees, or enforces the
target tool's runtime permissions. Main Agent owns orchestration, while
`state/check` validate the project-owned work-package protocol and evidence.
