# Skill 设计

> 依据：Skill 文档全篇，主文档《人的介入点》《加载三级》《定向与材料》《本地化区》。
> 这份定**Skill 文件长什么样、简报与回报的格式、执行者怎么派、投影到哪**。命令回什么在 [命令行设计](cli.md)。
>
> 标着 **决定** 的可以推翻；`SK-nn` 是可验收的断言。Skill 正文以 `SKILL_cn.md` 为源，`SKILL.md` 是译文。

---

## 0. 决定清单

| # | 决定 | 理由 |
| --- | --- | --- |
| **D1** | 入口 Skill 名 `xforge`；站 Skill 名 `xforge-<stage>`（`propose` `clarify` `design` `check` `apply` `verify`）；执行者名 `xforge-executor` | 用户只记一个名字；站名来自流程 |
| **D2** | 站 Skill 文件 = frontmatter + 恰好四个二级标题：`## 判断` `## 边界` `## 停下` `## 本项目`，第四节的正文包在本地化区标记里 | `四节`；标题固定让「验」的存在性检查能做（命令行设计 D11） |
| **D3** | 简报 = `xforge state --orient` 的信封原文 + 本站 Skill 正文 + 会话指示；三段顺序由信封已定（0a → 1 → 0b），会话指示附在最后 | 定向就是 0 级 + 1 级；不另发明一份格式，控制面输出即简报 |
| **D4** | 执行者回报 = 输出的**最后一行**，形如 `XFORGE-REPORT: done` / `XFORGE-REPORT: blocked <token>` / `XFORGE-REPORT: needs-human <一句话>`；入口只解析最后一行 | `只报状态不报过程`；解析最后一行，前面写什么都不会被搬回来 |
| **D5** | 执行者按方案分型，本版只有一个 `xforge-executor` | 主文档《写入范围的权威》 |
| **D6** | 宿主：`claude` 用子 Agent 隔离；`codex` 本版无隔离，站 Skill 在主会话执行（降级）—— 它的 Agent 类型声明在配置层、由 `spawn_agent` 拉起，不是一个可以投影的文件（§5） | `隔离是优化不是语义` |
| **D7** | Apply 站两层隔离：站执行者是协调者，每个包再派一个 `xforge-executor` 带包简报 | Skill 文档《不是每一站都隔离》 |
| **D8** | 本地化区放在第四节 `## 本项目`，标记 `<!-- xforge:local:begin -->` / `<!-- xforge:local:end -->`，出厂时标记之间为空 | 与规则文件设计 D9 同一套标记 |
| **D9** | 站 Skill 里不出现任何命令的完整用法说明；命令由信封 `next` 与简报第 ① 段的 `call_skeleton` 给出 | `不复制控制面能陈述的事实` |

---

## 1. 入口 Skill `xforge`

`scaffold/skills/xforge/SKILL_cn.md`：

```markdown
---
name: xforge
description: 推进当前 Change 的下一站。用户唯一需要记住的名字。
---

# xforge

你是编排者，不做任何一站的工作。循环如下，直到控制面说 archived 或需要人：

1. 跑 `xforge state --orient`。它回的 JSON 就是简报。
2. 看 `orient.stage`：
   - `isolate: false`（propose、clarify）：在本会话里按 `orient.stage.skill` 的正文做这一站；
     那两站的主体就是和用户来回。
   - `isolate: true`：派一个 `xforge-executor`，输入 = 简报（见「简报」）。等它的最后一行。
3. 一站结束时听控制面的话，不再用 `state` 核实：
   - 本会话里跑的 `xforge advance` 成功了：回复里的 `stage` 就是下一站的定向。它 `isolate: false` → 直接按它做下一站；
     `isolate: true` → 回到 1 取完整简报；回复里没有 `stage` → 到了 ready-to-archive，把回复 `next` 里的终局审批交给用户，停下。
   - 执行者最后一行 `done` → 回到 1（以控制面为准，不信回报的细节）。
   - `blocked <token>` → 回到 1，把 `blockers` 里该 token 的 remedy 告诉用户。
   - `needs-human <问题>` → 把问题原样交给用户；用户处理后回到 1。
4. 控制面回 `position.status: archived` → 结束。

## 简报

把三样东西按这个顺序放进执行者的输入，一字不改：
1. `xforge state --orient` 的完整输出（它内部已按 0a → 1 → 0b 排好）。
2. `orient.stage.skill` 对应的 Skill 正文（`.claude/skills/<skill>/SKILL.md` 或宿主等价位置）。
3. 一节 `## 会话指示`：本次会话里用户说过、且只对这次有效的话。没有就写「无」。
   一条每站都要遵守的指示不该在这里 —— 让用户写进本地化区或提案。

## 不做的事

- 不预取任何正文（上游文档、门输出、基线条目）。执行者自己点名要。
- 不复述路由表：哪站对应哪个 Skill 由控制面报。
- 不解释「为什么什么都不欠」：`owed` 为空就是答案。
```

`SK-01` 入口 Skill 正文里不出现任何站名到 Skill 名的映射表（product 层 grep `xforge-propose` 等名字，允许出现次数为 0）。
`SK-02` 入口 Skill 正文不含 `Read`/`cat`/`open` 任何上游文件的指令。
`SK-12` 入口 Skill 正文写明：本会话 `advance` 的回复带 `stage` 时以它为下一站定向，不再 `state`；没有 `stage` 时停下交终局审批（product 层 grep `stage`、`ready-to-archive`）。

一场 solid 里入口调 `state --orient` 的次数量过：15 次，其中每站派执行者前一次、每轮开头一次是简报本身，省不掉；能省的只有本会话 `advance` 之后与到 ready-to-archive 时的核实，每场 2–4 次。这一条的收益就是这个量级，不指望更多。

---

## 2. 站 Skill

### 2.1 模板

```markdown
---
name: xforge-design
description: design 站：把提案变成技术路径、作用域与工作包计划。
---

# xforge-design

收到简报就用；没有简报就先跑 `xforge state --orient`，那是用户在自己逐站推进：本站做完后，把 `advance` 回复里 `stage.skill` 告诉用户作为下一步的 `/<skill>`（回复里没有 `stage` 就报它 `next` 里的命令）。控制面能告诉你欠什么，下面只写它不能替你决定的。

## 判断
<这一站唯一不可替代的东西：什么算好。每条都是「如果这句话错了，实跑会先发现」的那种。>

## 边界
<能写哪些路径，以及相邻但明确不能碰的哪些。这是提示，拦人的是权限策略。>

## 停下
<什么条件必须停、停下之后交给谁。只写条件与去向。>

## 本项目
<!-- xforge:local:begin -->
<!-- xforge:local:end -->
```

`SK-13` 六个站 Skill 的首段都写明「没有简报 = 用户在逐站推进，做完报下一步 `/<skill>`，名字取自 `advance` 回复的 `stage.skill`」（product 层 grep）；live 层 stepwise 驱动统计每轮结果文本里有没有 `/xforge-` 开头的下一步提示。
`SK-03` 六个站 Skill 的二级标题集合恰好是 `判断 · 边界 · 停下 · 本项目`，顺序固定；本地化区标记成对且位于第四节内。
`SK-04` 站 Skill 正文不含「上次是怎么撞上的」类叙述：product 层对每份 Skill 断言不出现 `XF-` 诊断码字面（事故记忆在字典里）。
`SK-05` 站 Skill 正文不按流程名分支：不出现 `quick`/`solid`/`major` 字面。

### 2.2 六站各装什么

| 站 | 判断（要点） | 边界 | 停下 |
| --- | --- | --- | --- |
| **propose** | 目标是否有边界：一句话说得清「做完是什么样」；非目标是否列了最容易被误加的那件事；风险等级是否与影响面一致；规格 delta 是否先复用了 `spec_domains` 里已有的名字再发明新的 | 只写规格侧文件；不碰 `src/` | 用户说不清目标 → 问用户；影响面含 `interface` 而接口治理关 → 停，交给人决定开不开 |
| **clarify** | 哪些问题是「材料问题」（答案会改变设计）而不是好奇；每条问题是否给了默认答案让人只需否决 | 只写 `ledgers/exit/material-questions.yaml` | 每条问题都要人答 → `needs-human`，一次带全部问题 |
| **design** | 技术路径是否能被一个不看实现的人按规格写出黑盒测试；被否决的方案是否真的被考虑过（至少一个有代价的替代）；工作包切分是否让每个包能独立验证；作用域是否覆盖计划里全部路径且不多 | 只写实现侧的 `scope.yaml` `design.md` `work-packages.yaml`；不写代码 | 规格里有矛盾 → `blocked spec-conflict`，交给 propose 返工 |
| **check** | 提案、规格、设计是否在描述同一个行为；每条发现是否指向一个可定位的东西；章程逐条答复时「不适用」是否说得出理由 | 只写两份台账；不改设计 | 发现的答复要人 → `needs-human`；站级审批 → `needs-human` |
| **apply** | 协调者：派工顺序按依赖；每个包的执行者只拿包简报；交付记录里的完成判据证据是否可定位 | 协调者不写 `src/`；包执行者只写包 `paths` | 交付登记即集成，没有人确认；无归属改动 → `blocked unclaimed` |
| **verify** | 保证说明的「连贯性」是否指出了分叉处而不是复述；收据签署前每道门是否当前 | 只写 `assurance.md` 与收据台账；不改代码 | 门失败 → 不修，`blocked gate-failed`，交 apply 返工；签署 → `needs-human` |

### 2.3 Apply 站的包简报

协调者为每个包派执行者，输入按顺序：

1. `xforge advance package <id> --dispatch --workdir <path>` 的信封（含 `result.draft` 交付骨架、投影的 `allow`）。
2. 计划里该包的条目（`title` `paths` `criteria` `verify`）。
3. 一节 `## 任务`：写代码、跑该包的验证门（`xforge run --package <id>`）、填交付记录、跑 `xforge advance package <id> --deliver`，最后一行回报。

包执行者不看 `design.md` 全文：需要时按 `next` 里的指针点名取。

`SK-06` 包简报里不含 `design.md` 正文（product 层对 apply Skill 断言不出现「把设计文档全文」类指令；live 层从转录里查包执行者是否整读设计）。

---

## 3. 简报与回报

### 3.1 简报

```markdown
# 简报 · C-20260915-order-ledger · design

## 定向
```json
<xforge state --orient 的信封，原文>
```

## 本站 Skill
<xforge-design 的 SKILL 正文，原文>

## 会话指示
无
```

**开局时简报就是执行者知道的一切**；随后它照样可以调控制面要更多。

`SK-07` 简报三段的顺序固定；入口对同一 (change, stage) 生成的两份简报，前两段逐字节相同（0a 段确定性）。

### 3.2 回报

执行者输出的最后一行必须是三种之一；入口只读最后一行。

| 最后一行 | 入口做什么 |
| --- | --- |
| `XFORGE-REPORT: done` | `xforge state --orient`，以它为准 |
| `XFORGE-REPORT: blocked <token>` | `xforge state`，取 `blockers` 里该 token 的 remedy 给用户 |
| `XFORGE-REPORT: needs-human <一句话>` | 把那句话交给用户 |

`SK-08` 执行者提示词里写明「最后一行必须是 `XFORGE-REPORT:` 开头的三种之一」；product 层测试用三种样例输出与一种非法输出验证入口的解析规则（非法 → 视为 `blocked report-malformed`）。

---

## 4. 执行者

`scaffold/agents/xforge-executor.yaml` 见规则文件设计 §3.6；提示词文件 `scaffold/skills/xforge/executor-prompt_cn.md`：

```markdown
你是一个隔离的执行者。你看不到主会话说过什么；你的输入只有简报。

- 简报里的 JSON 是控制面此刻的真相。它说欠什么就写什么，说 not-owed 的不要写，不要核实为什么不欠。
- 需要某份文档、某条条目或某次门输出的正文时，用 `xforge show <ref>` 点名取（`upstream` 与 `next` 里给了 ref）；
  它会说明切片是否完整、省了什么。取过的不要再取。
- 每写完一份产出或台账，跑 `xforge state` 看还欠什么。
- 本站需要人的地方（`human: tail`），做到那一步就停，最后一行回 `needs-human`。
- 完成本站全部欠项并 `xforge advance` 成功后，最后一行回 `done`。
- 被挡住且你无法解决时，最后一行回 `blocked <token>`，token 取自 `blockers`。
- 最后一行必须是 `XFORGE-REPORT: done` / `XFORGE-REPORT: blocked <token>` / `XFORGE-REPORT: needs-human <一句话>` 之一。
```

`SK-09` 执行者提示词不含任何路径字面或站名；提到的命令只有 `xforge state`、`xforge show`、`xforge advance` 三个词，不带参数说明。

---

## 5. 宿主投影

| 宿主 | 入口与站 Skill | 执行者 | 执法 | 隔离 |
| --- | --- | --- | --- | --- |
| `claude` | `.claude/skills/<name>/SKILL.md` | `.claude/agents/xforge-executor.md`（frontmatter：`name` `description` `tools`；正文 = 提示词） | `.claude/settings.json` 的 `hooks.PreToolUse` | 入口用 Agent 工具派 `xforge-executor`，`prompt` = 简报 |
| `codex` | `.codex/skills/<name>/SKILL.md`（实测：项目级 Skill 会在模型可见的提示里按名与描述列出）；`AGENTS.md` 标记块内一句「用 `xforge` Skill 推进」 | 不投影 | `.codex/hooks.json` 的 `hooks.PreToolUse`（命令行设计 D15：装了还要人在 `/hooks` 里过一遍） | 入口在主会话内执行站 Skill；行为相同，只是不省 |

codex 这一版**为什么不投影执行者**：它的 Agent 类型不是项目里的一个文件 —— 类型声明在配置层（`config.toml` 的 `agents.<name>.description`），由模型用 `spawn_agent` 拉起，且项目层的 `config.toml` 是用户自己的配置（模型、沙箱都在里面）。更要紧的是「派一个执行者」这句话写在入口 Skill 正文里，正文按宿主分叉，「一份 Skill 两个宿主」就破了。降级是本版的选择：行为相同，只是不省（D6）。

`SK-10` 两个宿主上同一场景的产出、台账、receipt 逐字节相同（live 层：同一 seed 项目分别在两宿主跑 quick，比对 `xforge/changes/` 去掉时间戳后的内容）。

---

## 6. 走查

### 6.1 经入口跑 design 站（claude）

1. 用户：`/xforge`。
2. 入口：`xforge state --orient` → `orient.stage = {id: design, isolate: true, skill: xforge-design}`。
3. 入口拼简报（§3.1），派 `xforge-executor`。
4. 执行者：读简报 → 按 `upstream` 点名读 `proposal.md` → 写 `scope.yaml` `design.md` `work-packages.yaml` → `xforge state`（owed 为空）→ `xforge advance`（跑 `structure` `constitution`，出站，回 check 站切片）→ 最后一行 `XFORGE-REPORT: done`。
5. 入口：`xforge state --orient` → check 站，继续。

主会话累积：一份简报（发出去的，不在主会话里）+ 一行回报 + 一次 `state --orient`。

### 6.2 用户直接调 `/xforge-design`

站 Skill 第一句让它自己跑 `xforge state --orient`；其余与 6.1 第 4 步相同。没有入口、没有简报，行为一样。
多出来的只有一件事：`advance` 成功后把回复里 `stage.skill` 报给用户 ——「下一步 `/xforge-check`」—— 用户手工逐站推进时靠这一句知道接下来敲什么，
不用记六个名字。`/xforge` 一句话跑到底与逐站手工推进是同一套 Skill 的两种驱动方式，harness 两种都跑（live-test D12）。

### 6.3 apply 站的一个包

协调者：`advance package P-01 --dispatch --workdir <worktree>` → 拼包简报 → 派包执行者 → 包执行者写代码、`run --package P-01`、填交付记录、`advance package P-01 --deliver`、`done` → 登记成功即 integrated（验证门当前、路径一致是登记时查的）→ 协调者派下一个包，或本站出口满足时 `advance` → 最后一行 `done`。

`SK-11` live 层 solid 场景：执行者转录里 `design.md` 被读取的次数 ≤ 1（check 站），`proposal.md` ≤ 2；主会话转录里没有任何 `upstream` 文件的正文。

---

## 7. 追溯

| 不变量 | 兑现处 |
| --- | --- |
| `Skill 只判控制面判不了的` | §2.2 判断列；D9 |
| `禁令先当缺口审` | §1「不做的事」只有三条，且每条对应控制面已提供的东西（`complete` `next` `owed`） |
| `路由表不进正文` | `SK-01` |
| `交接不是继承` | §3.1；§5 claude 列用 `prompt` 传简报，不用继承上下文的派生方式 |
| `预加载定向不预加载材料` | §1「不做的事」第一条；`SK-02` `SK-06` |
| `站 Skill 能自己定向` | §2.1 模板首句；§6.2 |
| `只报状态不报过程` | D4；`SK-08` |
| `隔离是优化不是语义` | D6；`SK-10` |
| `本地化区只能加` | D8；`RF-16` |
| `四节` | D2；`SK-03` |
| `名字不单飞` `切片自称完整` | 简报直接用信封，信封已满足（命令行设计 `CLI-07` `CLI-16`） |
