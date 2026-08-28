# XForge 项目引导

开始项目工作前，先读 `xforge/manifest.yaml` 与 `xforge/constitution.md`。

对 `project.paths.changes` 解析出的路径下的活跃 Change，先运行
`xforge stage-bundle --change <id>`。它指出该 Change 的哪些文件自当前 Stage
开始以来变过、哪些没变，于是随后的阅读覆盖的是变化的部分而不是全部——六个
Stage 反复重读同样的六十千字节，是把一个会话填满的主要原因。它列在
`READ IN FULL` 下的文件全部读全文；已出具凭证的文件在你需要核对措辞时随时可以
打开：凭证说的是「这份文本与上一个 Stage 读到的相同」，不是「不许读」。只要这个
Change 还有未提交的改动，它就不为任何文件出具凭证；Constitution 与本 Stage
自己的产出永远列为全文读取。

使用已安装的 XForge 工作流 Skills。把 CLI 的 JSON 输出与 Gate 证据当作确定性
事实，把提示词里的指导仅当作指导。

## 调用 CLI

XForge 的设计是由 Agent 操作，而不是由人临时敲命令。人或 CI 只做一次性安装
（`npm install -g @xforge/cli@<version>`）；此后每一次操作都是本 Agent 按各
Skill 的 Invariants 所写，运行 `xforge ...`。

若找不到 `xforge` 命令，停下并报告。**绝不要**退回到 `npx xforge`——npm 上有一
个同名的无关包，npx 会把它拉下来运行。也不要为了绕过"命令不存在"而自行安装
CLI：本项目运行哪个版本，是记录在 `xforge/manifest.yaml` 里的决定，不是在 shell
里临时做的决定。

项目也可以改为在本地固定 CLI 版本，此时调用形式是
`npx --no-install xforge ...`，因为可执行文件在 `node_modules/.bin` 而不在
`PATH` 上。沿用本项目已经在用的那一种形式，不要在两者之间互相改写。

无论哪种形式，版本都是被强制而不是被假定的：CLI 每次运行都会与
`xforge/manifest.yaml` 比对，不一致时拒绝写入（`XFORGE_CLI_IDENTITY_MISMATCH`）。
遇到该诊断应如实报告，而不是设法把它绕过去。

## 规格驱动的并行开发

交付速度优先、且 Change 低风险、有边界、可回滚时用 `quick`；常规稳定交付用
`solid`；重大、高风险、跨系统或有关键影响的变更用 `major`。当活跃 Change 有两个
及以上依赖就绪、且 `write_paths` 互不重叠的工作包时，遵循宪法的"并行开发"原则与
`work-packages.yaml` 的 DAG。主 Agent 为每个具备写能力的 Worker 指定固定的基线
提交和独立的工作树。只有在涉及多次提交、共享文件或需要集成验证时才使用
Integrator，随后对 Major 或跨系统工作使用独立的 Reviewer。仅当目标运行时报告原生
子 Agent 支持时才真正并行激活 Worker；否则顺序执行这些工作包，并报告这一能力降级。
