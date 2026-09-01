# 手动驱动的四条 Flow 跑记 · 2026-08-31

> **这份记录能证明什么、不能证明什么，先说清楚。**
>
> 它证明：一个真模型读着随包发布的 Skill，能把 quick / solid / solid-contract / major 四条 Flow
> 各自完整走通，治理链在该拦的地方拦住了，该放行的地方放行了。下面每一个数字都取自项目磁盘上
> **CLI 自己写的**记录——transition receipt、Gate Evidence（带 `contentRevision` 与 `gitHead`）、
> 审批回执、验证回执——不是任何人的复述。用 `node tests/live-engine/hand-run-record.mjs` 可重新生成。
>
> 它**不能**证明：打包后的 CLI 能在宿主里装载它的 Skill。这次跑绕开了 `run-engine.mjs`，因此
> **claude-CLI 的 Skill 装载与命令投影、run-engine 的隔离层、预算与超时策略层、token 与成本计量**
> 四者一概未验。而这个项目已知的两次实跑缺陷（`xforge-clarify` 的 Authority 与 Stage 自相矛盾、
> npm Gate 报 passed 却什么都没断言）**恰好都出在这几层**。
>
> **发版前仍然欠一次完整的 live-engine 真跑。** 那次要证的是打包与宿主集成；治理逻辑这一层，
> 这份记录覆盖得比一次真跑更细。详见 `tests/live-engine/DRIVING-BY-HAND.md`。

## 结果

| Change | Flow | 结局 | 返工 | 验收 | Gate |
| --- | --- | --- | --- | --- | --- |
| `2026-08-31-greeter` | quick | **archived** | 0 | 4/4 | 2 道全绿 |
| `2026-08-31-task-ledger` | solid | **archived** | 0 | 5/5 | 4 道全绿 |
| `2026-08-31-order-cancel` | solid-contract | **archived** | 0 | 8/8 | 8 道全绿 |
| `2026-08-31-credential-store` | major | **archived** | 2 | 9/9 | 5 道全绿 |

## 每条线的 Stage 路径

- **quick** — `propose → apply → verify → ready-to-archive`
  - Gate：structure=passed, unit-tests=passed
  - 审批：quick-close
- **solid** — `propose → design → check → apply → verify → ready-to-archive`
  - Gate：check-findings=passed, constitution-check=passed, structure=passed, unit-tests=passed
  - 审批：closing-solid, planning-solid
- **solid-contract** — `propose → design → check → apply → verify → ready-to-archive`
  - Gate：check-findings=passed, constitution-check=passed, contract-compat=passed, contract-drift=passed, contract-lint=passed, module-boundaries=passed, structure=passed, unit-tests=passed
  - 审批：closing-solid, planning-solid
- **major** — `propose → clarify → design → check → apply → verify → ready-to-archive`
  - Gate：check-findings=passed, constitution-check=passed, security-scan=passed, structure=passed, unit-tests=passed
  - 审批：closing-major, implementation-major

## 治理链拦住的东西

跑这四条线的价值不在「四个 archived」，在于中途被拦下的是什么。

**major 在 verify 站抓到一个真实的静默数据丢失缺陷。** 独立评审发现 `serialize()` 用普通对象字面量
构建输出 map，而同模块其余四处都是 `Object.create(null)`——只有写路径漏了。后果两条，都独立复现过：

- 一个含 `__proto__` 自有键的 v1 存储，迁移后静默丢一条记录，而 `migrate()` 的记录数断言仍然通过
  ——因为它跑在序列化**之前**，站在失效点的错误一侧。
- `store --id __proto__` 退 0、报 `"stored":true`，落盘却是 `{"credentials":{}}`。

`ID_PATTERN` 是 `/^[A-Za-z0-9._-]{1,128}$/`，`_` 在字符类里，所以这个 id 可达。而 `design.md` D7
写着「id pattern 也排除了 `__proto__`……两道防线单独都不是承重的」——**两半都错**。

评审据此给出 CHANGES REQUESTED、拒签验证回执（「passed 会是一句假断言」）、返工到 apply。修复是
一行 `Object.create(null)`，没有去收窄 id pattern 掩盖问题。修完在九个原型名 id 上逐一验过，
并第一次真正验了 F10 的复数情形（六条记录的 v1 存储迁移后仍是六条）。

**被驳回的工作包不能靠改记录翻案。** apply 想直接重新派工，CLI 拒绝并给出正确程序：
`XFORGE_WORK_PACKAGE_NOT_READY` —— 一个被驳回的包要作为**新的执行**重做，绝不能编辑评审人已经读过的
那份记录。于是旧执行记为 `failed`、发新 dispatch、新执行交付。评审人读过的东西不可篡改，这条由 CLI
强制，不靠自觉。

**返工后的决定会自动失效。** clarify 站第一次把 `decidedAt` 写成只有日期，解析成当天零点，早于返工
回执的时间戳，CLI 立即报 `condition:materialQuestions:stale-…`——一个决定不能比它所针对的内容活得更久。

**Agent 六次拒绝给自己写授权。** 六个互不通信的 Agent、三个项目、不同 Stage，独立得出同一结论：
`decidedBy` / `--by` 是人的署名，Agent 不能代填。其中一次 clarify 认出仓库里那个自动化身份正是 Skill
注释中记载的事故原型，拒绝复制。

## 两条被证伪的 finding

记录里也留下 Agent 判断失误的部分。`F12` 声称 `separationOfDuties` 会使 Change 目录的 git 作者
丧失审批资格。前提属实（该策略确实开着，该人确实是作者），但**结论不成立**：以该身份签
`implementation-major` 与 `closing-major` 均被记录，随后的 transition 与 archive 均通过。这条被提出两次，
两次实测证伪——它是推理出来的，不是观察到的。

## 仍然为真的缺陷（代码修好不等于文档变对）

- `specs/credential-store.md` 仍写着 `assertEnvelope` 用于「上面每个测试」，实际八/九。**这份是归档时
  合并进 `xforge/specs/` 的那一份**，所以它比下一条更要紧。
- `proposal.md` 的失败面仍只枚举四个诊断码，从未出现 `INTERNAL_ERROR`，而实现有五个。
- `design.md` D7（id pattern 排除 `__proto__`）与 D5（记录数断言是 REQ-CRED-004 复数的承重点）均不准确，
  且没有任何 finding id 覆盖它们。

三条都需要 `xforge-revise`，而从 `ready-to-archive` 出发需要先 `xforge transition repair`。
