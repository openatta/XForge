# XForge 测试简报（2026-08-09）

## 结论

网络与回环权限恢复后，先前两项环境阻塞均已关闭：完整 `npm run verify`
通过，Audit `503 → spool → retry` 用例已进入并通过业务断言；真实 Claude
Code 引擎在一次语义失败重试后完成 Solid 全流程，最终从规划、实现、验证、
外部审批、工作包交付、Gate、Audit 到 Archive 全部闭环。

Live lane 没有把第一次“测试通过但 Spec 与实现契约不一致”的模型结论伪装成
成功。该轮被分类为 `model_behavior_failure`，未执行归档；收紧 Skill 与评测提示后
从干净样例重跑，最终机器摘要为 `outcome: pass`。

## 环境

- macOS / Asia/Shanghai
- Node.js `v20.20.2`
- npm `10.8.2`
- Claude Code `2.1.198`
- XForge CLI `0.7.6 / Protocol 2`
- `.env`：Anthropic token、Base URL 和模型配置均已设置；值未输出、未复制、未提交

## 结果汇总

| 测试层 | 结果 | 说明 |
|---|---:|---|
| Scaffold integrity/build | PASS | 47 个 payload 文件摘要通过，TypeScript 构建通过 |
| 实现单元/集成 | PASS 70/70 | 17 个 test files；CLI 子进程覆盖率门已启用 |
| 独立产品黑盒 | PASS 14/14 | 3 个 test files；包含 live runner policy 的确定性测试 |
| Task Ledger 预置验收 | PASS 4/4 | 实现前失败，Apply、Verify、Archive 后均通过 |
| 完整 Solid 场景 | PASS | install→plan→Approval→Apply→delivery→Verify→closing Approval→Audit→Archive |
| 真实引擎最终重试 | PASS | 三阶段 98 turns，`$3.674351`，约 504.7 秒 |
| Audit loopback 503→retry | PASS | 完整 `npm run verify` 中通过，不再需要跳过 |
| 环境阻塞 | 0 | 外部 API 与 `127.0.0.1` listen 均可用 |

最终 `npm run verify` 共通过 84 项仓库测试（70 实现 + 14 产品黑盒），另有
4 项隔离样例验收通过。完整 live 成功摘要位于 ignored 文件
`tests/.tmp/live-engine-results/summary.json`。

## 最终 Solid 场景证据

运行项目：`tests/.tmp/live-engine-project`（Git ignored）

- 五 Target install dry-run 和真实安装成功：164 个 rendered files，首次 165 项
  create/record 变更；
- 模型规划生成合法 Solid Change、Proposal、delta Spec、Design 和 T001；CLI 确认
  Stage=`design`、T001=`ready`、planning Approval pending；
- delta Spec 与不可修改验收测试的契约一致：`add/done → data.task`、
  `list → data.tasks`、空列表为 `data.tasks: []`；
- planning 外部 HMAC receipt 由 `owner@example.test` 签发，Design→Apply Transition
  成功；
- T001 dispatch 与 state revision、policy snapshot、Git HEAD、audit correlation 绑定；
- 模型只新增 `src/cli.mjs`，外部 delivery 的真实 Git diff 也仅含该文件；
- Apply 后 work-package verify、structure、unit-tests 全部通过；
- 独立 Verify 模型重跑 `npm test`，生成 Assurance 与 verification receipt，未修改
  实现或测试；
- 提交验证产物后重新生成当前 revision 的 Gate Evidence，成功进入
  `ready-to-archive`；
- closing 外部 HMAC receipt 由 `maintainer@example.test` 签发；
- Change 范围 Audit verify：hash chain valid，286 条事件，35 条 optional remote
  pending，不阻塞 Solid；
- Archive dry-run 计划创建主 Spec 并移动 Change；真实 Archive 创建
  `xforge/specs/task-ledger.md`，原子移动到
  `xforge/changes/archive/2026-08-09-task-ledger`；
- 归档保存 4 条 Transition receipt、2 条 Approval、dispatch/delivery、Gate 与
  verification evidence；active Changes 为 0；
- 归档后 `npm test` 仍为 4/4。

机器摘要再次执行验收与全局 Audit，确认三段引擎均成功、主 Spec/Archive 存在、
4 条 Transition、2 条 Approval、delivery changed paths=`["src/cli.mjs"]`、Audit
chain valid。全局 Audit 在摘要时为 302 条事件、151 条 remote pending；该数包含
所有项目 Hook 事件及其 delivery spool 对，Solid policy 明确不要求远端交付。

## 真实引擎最终重试

| 阶段 | 结果 | duration | turns | input | cache read | output | cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| Plan/Design | PASS | 169,723 ms | 41 | 78,745 | 1,260,288 | 10,878 | `$1.295819` |
| Apply | PASS | 218,708 ms | 23 | 39,007 | 429,952 | 18,181 | `$0.864536` |
| Verify | PASS | 116,300 ms | 34 | 75,246 | 452,224 | 9,679 | `$1.513996` |
| 合计 | PASS | 504,731 ms | 98 | 192,998 | 2,142,464 | 38,738 | `$3.674351` |

每次调用保持 3 美元上限，结果文件不保存 `.env`、token 或原始请求。最终结果分别
为 `01-plan-retry.json`、`02-apply-retry.json`、`03-verify-retry.json`。

## 失败与重试记录

本轮网络恢复后的所有真实引擎调用累计报告费用为 `$10.694313`、330 turns、约
1,540.6 秒引擎 duration。费用包含诊断与失败轮次，不能只报告最终成功轮：

1. Claude runtime 先尝试写用户目录 `.claude/session-env`，被 managed filesystem
   拒绝；调用本身联网成功，57 turns、`$1.459768`。修复为通过
   `CLAUDE_CONFIG_DIR` 把运行时状态放入 `tests/.tmp`。
2. 下一次规划因模型写出有包装层的非法 `change.yaml`，CLI 又在 Schema 错误后
   继续解引用，最终 96 turns 后触发预算上限，报告 `$3.082200`。修复 CLI
   Schema fail-fast、增加回归测试，并在 Propose Skill 中提供最小合法结构。
3. 第一次完整三阶段调用总计 `$2.477994`，验收 4/4；Verify 模型发现 delta Spec
   的 envelope 形状与测试/实现冲突，却错误降级为 warning 并声称 PASS。该轮按
   `model_behavior_failure` 处理，未签 closing Approval、未归档。
4. Propose Skill 增加“不可猜测精确契约、不可修改测试为事实源”约束，Verify
   提示明确任何 Spec/测试/实现矛盾必须 FAIL；随后从全新样例重跑并成功闭环。

## 本轮修复

1. `run-engine.mjs` 使用隔离的 Claude 配置目录，避免用户目录只读导致 Hook 前置
   失败；setup 会清理并重建该目录。
2. `resolveChangeState` 在 Change Schema error 时立即抛出稳定
   `XFORGE_SCHEMA_INVALID`，不再返回 `XFORGE_INTERNAL_ERROR`；新增单元回归。
3. `xforge-propose` 补充最小 `change.yaml` 结构与来源契约规则；Scaffold Lock
   resource digest、CLI integrity 和 `files.sha256` 同步。
4. live planning prompt 明确 `work-packages.yaml` 使用 root-level `packages`，禁止
   多余 `spec` wrapper，并锁定不可修改验收测试的 envelope 形状。
5. `sign-approval.mjs` 与 `record-delivery.mjs` 把相对 root 规范化为绝对路径，避免
   cwd 与 `--root` 重复拼接。
6. `summarize.mjs` 生成机器可读成功摘要，并重新执行 acceptance、state、Audit、
   receipt/delivery/archive 检查。
7. 多 CLI 进程的 control-plane 集成场景在全套并行运行时偶发超过 Vitest 默认
   5 秒；单独运行约 2.17 秒，已为该场景设置显式 15 秒测试上限，未改变断言。
8. 确定性发布门增加 compiled CLI 子进程覆盖率，当前基线约为 statements/lines
   83.7%、branches 72.1%、functions 90.0%，最低门槛为 78/65/80/78。
9. PR CI 增加 Ubuntu Node 20/24、macOS Node 24、Windows Node 24；临时 fixture
   在 suite 结束后统一回收，Python Script runner 支持 Windows 解释器名。
10. Release check 会实际 pack、安装到空消费者并运行安装后 CLI，而非只检查清单。
11. Live runner 增加整场预算、阶段重试、超时、未知费用 fail-closed、最小化环境
    和显式 isolation acknowledgement；机器摘要同时验证 runner policy。

## 剩余风险

1. 最终实现以同目录临时文件加 `rename` 满足本需求的原子替换，但 Design 提到的
   显式 `fsync` 未实现；Verify 将其列为低风险 durability advisory，而非当前
   Requirement blocker。
2. Solid 配置远端 Audit sink 但缺失 endpoint/token 时，每个 runtime 事件都会
   产生本地 spool 对，长模型会话会快速增加 pending；语义透明但有运维容量成本。
3. live 模型输出具有波动性，且本轮证明“测试通过 + 自报 PASS”仍可能掩盖 Spec
   不一致；发布门必须继续依赖确定性 Gate、receipt、真实 diff 和独立语义审查。
4. 本轮 live 调用总费用高于一次成功路径，因为保留并诚实计入了诊断、预算失败和
   语义重试成本。定时 lane 应设置整场预算、重试上限和失败分类统计。

完整测试架构与退出标准见 `docs/TEST_DESIGN.md`。
