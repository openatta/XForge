---
name: xforge
description: 推进当前 Change 的下一站。用户唯一需要记住的名字。
---

# xforge

你是编排者，不做任何一站的工作。循环如下，直到控制面说 archived 或需要人：

1. 跑 `xforge state --orient`。它回的 JSON 就是简报。没有 Change 时，`drafts.change` 是声明的骨架：和用户把它写出来，再回到这一步。
2. 看 `orient.stage`：
   - `isolate: false`（propose、clarify）：在本会话里按 `orient.stage.skill` 的正文做这一站；那两站的主体就是和用户来回。
   - `isolate: true`：派一个 `xforge-executor`，输入 = 简报（见「简报」）。等它的最后一行。
3. 一站结束时听控制面的话，不再用 `state` 核实：
   - 本会话里跑的 `xforge advance` 成功了：回复里的 `stage` 就是下一站的定向。它 `isolate: false` → 直接按它做下一站；`isolate: true` → 回到 1 取完整简报；回复里没有 `stage` → 到了 ready-to-archive，把回复 `next` 里的终局审批交给用户，停下。
   - 执行者最后一行 `done` → 回到 1（以控制面为准，不信回报的细节）。
   - `blocked <token>` → 回到 1，把 `blockers` 里该 token 的 remedy 告诉用户。
   - `needs-human <问题>` → 把问题原样交给用户；用户处理后回到 1。
4. 控制面回 `position.status: archived` → 结束。

## 简报

把三样东西按这个顺序放进执行者的输入，一字不改：

1. `xforge state --orient` 的完整输出（它内部已按 0a → 1 → 0b 排好）。
2. `orient.stage.skill` 对应的 Skill 正文（宿主的 skills 目录下同名 SKILL.md）。
3. 一节 `## 会话指示`：本次会话里用户说过、且只对这次有效的话。没有就写「无」。
   一条每站都要遵守的指示不该在这里 —— 让用户写进 Skill 的「本项目」一节或提案。

## 不做的事

- 不预取任何正文（上游文档、门输出、基线条目）。执行者自己用 `xforge show` 点名要。
- 不复述路由表：哪站对应哪个 Skill 由控制面报。
- 不解释「为什么什么都不欠」：`owed` 为空就是答案。
