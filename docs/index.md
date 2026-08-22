# XForge 文档

> 对应实现：`@xforge/cli 0.7.18`、File Protocol 2、`xforge.dev/v1alpha2`。
> 本目录只维护中文版本。

---

## 六份核心文档

| 文档 | 回答什么 | 什么时候读 |
| --- | --- | --- |
| [概念与架构](concepts-and-architecture.md) | XForge 是什么、按什么逻辑运转、我脑子里要装哪几个模型 | **从这里开始** |
| [治理模型](governance-model.md) | 七类治理资源各自能证明什么，为什么不许互相冒充 | 想搞清楚「什么算数」时 |
| [扩展指南](extension-guide.md) | 新增 Skill / Flow / Gate / Rule / Policy / Hook / Approval / Agent / MCP | 要定制时 |
| [仓库与文件布局](repository-layout.md) | 每个中间产物落在哪、归谁写、被谁校验 | 排障或写台账时 |
| [子 Agent 设计](sub-agent-design.md) | 并行工作包与 Worker / Integrator / Reviewer | 要并行交付时 |
| [CLI 用法](cli-tool-usage.md) | 有哪些命令、接什么参数、返回什么、退出码与常见诊断码 | 查命令时 |

---

## 按问题找答案

**「我要开始用它了」**
→ [概念与架构 §2](concepts-and-architecture.md)（两个物件，一个方向）
→ [概念与架构 §5](concepts-and-architecture.md)（Skill 驱动循环）
→ [概念与架构 §9](concepts-and-architecture.md)（日常怎么工作）

**「它卡住了，`blockedBy` 说的这个是什么意思」**
→ [治理模型 §8](governance-model.md)（`blockedBy` 完整词汇表 + 三个带补救提示的 block）

**「所有 Gate 都绿了，Stage 却出不去」**
→ [治理模型 §3.4](governance-model.md)（Gate 时序陷阱）

**「`ready-to-archive` 没有任何可走的 transition，是不是卡死了」**
→ [概念与架构 §4.6](concepts-and-architecture.md)（合成 Stage 与 `transition repair`）

**「升级之后在途 Change 的审批全废了」**
→ [扩展指南 §0.3](extension-guide.md)
→ [仓库与文件布局 §7](repository-layout.md)（归档的不受影响）

**「这个台账要怎么写」**
→ [仓库与文件布局 §3](repository-layout.md)（四份台账的完整契约与身份校验）

**「我想加一道『必须有人拍板』的门」**
→ [扩展指南 §2.4](extension-guide.md)（自定义 exit condition，**不需要写代码**）

**「我想接公司的审批系统」**
→ [扩展指南 §7.5](extension-guide.md)（MCP provider 四步）

**「并行交付要注意什么」**
→ [子 Agent 设计 §6.3](sub-agent-design.md)（`write_paths` 不相交只是必要条件）
→ [子 Agent 设计 §5.3](sub-agent-design.md)（`done_when_evidence` 前缀匹配）

---

## 三条最容易被误解的机制

1. **`separationOfDuties` 不比较角色。** 它要求审批人**不是本 Change 的 implementer**。
   `roles` 是资格过滤器，两者是不同的东西。
   → [治理模型 §4.4](governance-model.md)

2. **`outline` 没有任何人检查。** 真正会让 Change 失败的只有带 `minOccurrences` 的 `markers`。
   → [扩展指南 §2.8](extension-guide.md)

3. **放进 `scaffold/` 不等于启用。** 同步由 `manifest.yaml` 驱动，不是扫描目录。
   → [扩展指南 §0.1](extension-guide.md)

---

## 其它

- **命令的最终依据**：`xforge help --text`，单条命令用 `xforge help <command> --text`。
  CLI 自带的命令列表由实现生成，[CLI 用法](cli-tool-usage.md) 与它有出入时以它为准。
  那份文档提供的是帮助文本给不了的东西——命令之间怎么配合、哪些参数有陷阱、
  某个诊断码出现时该怎么处置。
- **发布流程**：[RELEASING.md](../RELEASING.md)（仅英文）。

产品规格、CLI 设计、测试设计、设计评审与审计报告属于内部材料，**不在本仓库发布**，
本目录也不再保留它们的副本。这六份核心文档就是 XForge 公开文档的全部。

> 六份核心文档以源码为准。发现文档与实现不一致时，以源码为准并提 issue。
