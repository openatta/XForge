# XForge 项目引导

在活跃 Change 上，第一个调用是 `xforge stage --change <id> --content full`。
一次回复就带来整个工作集：ready 的 Action 及其 `writes`、`requiredSections`
与 outline，该 Action 各输入的**正文**，Constitution 正文，以及诊断。
不要再单独去打开那些输入——它们已经到了。每写完一个 Artifact，改用不带该
选项的 `xforge stage --change <id>` 重跑，它只发送变动过的部分。

进入时用 `--content full`，是因为刚开始的会话没有任何东西可以拿来核对摘要。
默认模式会扣下没有变动的 Artifact、只给它的摘要；而没读过那个文件的人，
摘要白付了，文件照样还得读一遍。

不在 Change 上时，读 `xforge/manifest.yaml` 与 `xforge/constitution.md`。
还不知道 Change id 时，`xforge state` 会列出活跃的 Change。
`xforge stage-bundle --change <id>` 回答的是另一个更窄的问题——自进入本 Stage
以来哪些 Artifact 变动过——它返回的是路径，不是正文。

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

每次 `xforge` 调用都是一个进程，不是一个会话：它每次都从磁盘重新解析项目，运行之间
不保留任何东西。由此有两点，第二点才是真正的开销。

重复读同一样东西对 XForge 很便宜，对你很贵——贵不在 CLI 重新读，而在它打印出的每一份
答案都会留在你的上下文里，直到会话结束。所以只取你正要据以行动的那部分。`--field <path>`
从 Envelope 中取出一个值、别的什么都不打印，并且可以重复：
`xforge state --change <id> --field nextActions --field change` 是一次调用返回两个值。
`state` 有五个段默认不返回，要用 `--include` 显式索取，被省略处都会写明取回它的选项。

`check` 同样接受 `--field`。它的回复包含结构报告、解析出的 Change、Gate 选择、工作包选择和
`gates`；据裁决行动的 Stage 要的是 `gates`，`xforge check --change <id> --field gates --field diagnostics` 会把其余
部分留下不发。诊断一定要一起取：一个不声明 Gate 的 Stage，和一个证据已失效的 Stage，返回的都是空的
`gates`，只有诊断能把两者分开——有一次实跑把 `[]` 读成了"没什么可说的"，差一步就带着失效证据做了 transition。但要清楚它没做到什么：`gates` 里每一项都带着自己的 Evidence——verify 命令的全部
stdout、各个摘要、时间戳——所以这是把回复收窄到你据以行动的那部分，而不是把它变小。

被拒绝时也照样只回你问的那些，外加失败原因，所以拒绝之后用 `--field diagnostics` 得到的是几行，
而不是整个项目。

`--field` 接受点号路径，不限于顶层名字：`--field change.governance.currentStage` 只打印一个字符串。
并且它是全有或全无——只要有一个名字解析不出来，整次调用就失败、一个值都不返回，所以猜错一个路径
的代价是整份回复。另外，"卡在哪里"要问 `state` 而不是 `check`：
`--field change.governance.readyTransitions`，其中每一项都带 `blockedBy`。

以及：把彼此不需要读取对方输出的调用串起来。一个受治理的 Change 有几十次 CLI 调用，
而一个 turn 的代价远高于一个进程，所以 `xforge check --change <id> && xforge transition
--change <id> --to <stage>` 应该写在一行里，而不是分成两个 turn。这样做是安全的，因为
每条命令都自己做判断：`transition` 会自行评估就绪状态，条件不满足时照样拒绝，和它单独
运行时完全一样。当第二条命令不需要你去**读**第一条的输出时就串起来——需要读时就分开。

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
