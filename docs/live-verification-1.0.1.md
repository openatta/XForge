# 1.0.1 live 验证

> 非大版本的常规验证，按 `docs/design/live-test.md` D13 的小矩阵（`node scripts/live-matrix.mjs --engine A --set small`）加两场 MCP 审批。基线是 `docs/live-baseline-1.0.0.md`。

## 版本

`@xforge/cli` 1.0.1，git 标签 `v1.0.1`。相对 1.0.0 的行为变化：交付即集成（取消逐包人工确认）；审批绑站修订（`approval-stale`）；major 的 clarify 出站审批，Change 级；MCP 审批 `attest approve --via`；oracle 加到 5 / 7 / 7 条并加 Requirement 覆盖检查（LT-07）。

## 六场（引擎 A，2026-09-17，全部归档）

| 场景 | 治理 | 审批 | 结果 | 外层轮 | 内部轮 | 返工 | oracle | REQ 覆盖 | output | cache_read | xforge 调用 | 工具调用 | deny | 用时（分） | 运行目录 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| major | FF | human | archived | 5 | 36 | 0 | 7/7 | 不适用 | 26787 | 780185 | 50 | 60 | 0 | 11 | `2026-09-17T12-09-32-790Z` |
| major | TT | mcp（MCP 批 4 次） | archived | 5 | 46 | 0 | 7/7 | 6/6 | 26812 | 1114054 | 69 | 77 | 0 | 13 | `2026-09-17T12-20-45-398Z` |
| major | TT | human | archived | 5 | 41 | 0 | 7/7 | 7/7 | 31373 | 958326 | 53 | 68 | 0 | 12 | `2026-09-17T12-09-32-063Z` |
| solid | TT | mcp（MCP 批 2 次） | archived | 4 | 36 | 0 | 7/7 | 4/4 | 23770 | 908830 | 49 | 66 | 0 | 11 | `2026-09-17T12-20-42-690Z` |
| solid-rework | FF | human | archived | 5 | 36 | 1 | 7/7 | 不适用 | 27439 | 782866 | 47 | 61 | 0 | 10 | `2026-09-17T12-09-31-322Z` |
| solid-rework | TT | human | archived | 6 | 44 | 1 | 7/7 | 5/5 | 33885 | 989071 | 61 | 79 | 0 | 12 | `2026-09-17T12-09-33-185Z` |

## 与 1.0.0 基线的对比

| 场景 | 1.0.0（轮 / output / 调用） | 1.0.1（轮 / output / 调用） | 变化 |
|---|---|---|---|
| solid-rework TT | 8 / 39.1k / 67 | 6 / 33.9k / 61 | 少 2 轮，output −13% |
| solid-rework FF | 8 / 34.2k / 55 | 5 / 27.4k / 47 | 少 3 轮，output −20% |
| major TT | 8 / 34.8k / 58 | 5 / 31.4k / 53 | 少 3 轮，output −10% |
| major FF | 8 / 29.5k / 51 | 5 / 26.8k / 50 | 少 3 轮，output −9% |
| solid TT，MCP 审批 | 7 / 32–43k / 57–80（人批） | 4 / 23.8k / 49 | 不等人批，少 3 轮 |
| major TT，MCP 审批 | 8 / 34.8k / 58（人批） | 5 / 26.8k / 69 | 不等人批，少 3 轮；clarify 批后改答案触发一次重批 |

读法：轮数下降的原因是 apply 站不再为每个包停下等人确认，MCP 审批模式下连审批也不等人；返工数、oracle、Requirement 覆盖、执法 deny 全部符合预期。oracle 口径是加强后的（5 / 7 / 7 条），比较 oracle 通过数时不与 1.0.0 的 3 / 4 / 4 混看。
