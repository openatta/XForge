# XForge 项目引导

开始项目工作前，先读 `xforge/manifest.yaml`、`xforge/constitution.md`，以及
`project.paths.changes` 解析出的路径下的活跃 Change。使用已安装的 XForge
工作流 Skills。把 CLI 的 JSON 输出与 Gate 证据当作确定性事实，把提示词里的
指导仅当作指导。

## 调用 CLI

XForge 的设计是由 Agent 操作，而不是由人临时敲命令。人或 CI 只做一次性的固定
版本安装（`npm install --save-dev --save-exact @xforge/cli@<version>`）；此后
每一次操作都是本 Agent 按各 Skill 的 Invariants 所写，调用
`npx --no-install xforge ...`。**绝不要**把 Skill 里的命令简化成裸 `xforge`——
项目本地安装不会把可执行文件放进当前 shell 的 `PATH`，只有 `npx` 才能可靠地从
`node_modules` 解析到它。**绝不要**去掉 `--no-install`——正是它让"固定版本的 CLI
不存在"这件事立刻大声失败，而不是让 `npx` 静默拉取并运行另一个未固定的版本。

## 规格驱动的并行开发

交付速度优先、且 Change 低风险、有边界、可回滚时用 `quick`；常规稳定交付用
`solid`；重大、高风险、跨系统或有关键影响的变更用 `major`。当活跃 Change 有两个
及以上依赖就绪、且 `write_paths` 互不重叠的工作包时，遵循宪法的"并行开发"原则与
`work-packages.yaml` 的 DAG。主 Agent 为每个具备写能力的 Worker 指定固定的基线
提交和独立的工作树。只有在涉及多次提交、共享文件或需要集成验证时才使用
Integrator，随后对 Major 或跨系统工作使用独立的 Reviewer。仅当目标运行时报告原生
子 Agent 支持时才真正并行激活 Worker；否则顺序执行这些工作包，并报告这一能力降级。
