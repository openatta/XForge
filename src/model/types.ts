// design: rule-files §1 — 每种文件的形状，与 schemas/ 一一对应；运行期由 ajv 校验。
export type Risk = 'low' | 'medium' | 'high';
export type Impact = 'interface' | 'security' | 'data-migration' | 'infra';
export type Need = 'spec' | 'interface' | 'assurance';
export type Side = 'spec' | 'impl';
export type ReadContract = 'entries' | 'skeleton' | 'mixed';
export type HumanPoint = 'body' | 'tail' | 'none';
export type ToolAction = 'read' | 'write' | 'edit' | 'shell';
/** provider 的 id：开放集（命令行设计 D14）；认不认得由注册表运行时判。 */
export type Platform = string;
export type Language = 'zh-CN' | 'en';

export interface Manifest {
  version: 1;
  scaffold: { version: string };
  governance: { spec: boolean; interface: boolean };
  flow: { default: string };
  modules: Array<{ id: string; paths: string[] }>;
  platforms: Platform[];
  language: Language;
  verification?: { commands: Record<string, string> };
  selected: { flows: string[]; gates: string[]; policies: string[] };
  /** MCP 审批者：只配服务，配了就是信了；审批人 id 由它自己回。见命令行设计 §2.4。 */
  mcp_approvers?: McpApprover[];
}

export interface McpApprover {
  id: string;
  server: { command: string; args?: string[]; env?: Record<string, string> };
  /** 工具名，缺省 approve。 */
  tool?: string;
  timeout_seconds?: number;
}

export interface Produce {
  id: string;
  path: string;
  side: Side;
  needs: Need[];
  read: ReadContract;
  outline?: string[];
  markers?: Array<{ kind: string; min: number }>;
  instructions?: string;
}

export type ExitCondition =
  | { kind: 'gate'; ref: string }
  | { kind: 'ledger'; ref: string; requires: 'exists' | 'all-resolved' }
  | { kind: 'attested'; ref: string }
  | { kind: 'approval'; policy: string }
  | { kind: 'packages'; requires: 'all-integrated' }
  | { kind: 'unclaimed-changes'; requires: 'none' };

export interface Stage {
  id: string;
  skill: string;
  human: HumanPoint;
  /** 这一站的审批与台账按谁计：`change` = 规格侧共享（clarify），`scheme` = 每个实现方案各一份（缺省）。 */
  scope?: 'change' | 'scheme';
  produces: Produce[];
  ledgers: string[];
  gates: string[];
  exit: ExitCondition[];
  rework_to: string[];
}

export interface Flow {
  name: string;
  title?: string;
  eligibility: { risk: Risk[] };
  stages: Stage[];
  archive: { exit: ExitCondition[] };
  approval_policies: Record<string, { min_approvers: number; separation_of_duties: boolean; allow?: Array<'human' | 'mcp'> }>;
}

export type Builtin = 'structure' | 'ledgers' | 'constitution' | 'spec-delta' | 'interface-delta' | 'interface-compat';

export interface Gate {
  name: string;
  kind: 'command' | 'builtin';
  command?: { from: 'manifest' };
  builtin?: Builtin;
  needs?: Need[];
  accepts?: string[];
  inputs: string[];
  timeout_seconds?: number;
}

export interface PolicyRule {
  effect: 'deny' | 'ask' | 'allow';
  tools: ToolAction[];
  paths?: string[];
  commands?: string[];
  message?: string;
}
export interface Policy {
  name: string;
  rules: PolicyRule[];
}

/** 宿主投影台账（命令行设计 D16）：sync 投了什么、各自的校验和；派生物。 */
export interface HostsLedger {
  version: 1;
  providers: Array<{ id: string; files: HostFileRecord[] }>;
}

export interface HostFileRecord {
  path: string;
  /** owned：整个文件是我们投的，孤儿时删掉；shared：与人共用，孤儿时只摘掉我们那块。 */
  kind: 'owned' | 'shared';
  checksum: string;
}

export interface Hook {
  name: string;
  events: Array<'pre-tool-use'>;
  command: string;
}
export interface Executor {
  name: string;
  description: string;
  tools: ToolAction[];
  prompt_file: string;
}
export interface Integrity {
  scaffold_version: string;
  files: Record<string, string>;
}

export interface BaselineDomains {
  domains: Array<{ id: string; title: string; capabilities: Array<{ id: string; path: string }> }>;
}
export interface BaselineEntries {
  entries: Array<{ id: string; capability: string; title: string; summary?: string; breaking?: boolean }>;
}

export interface ChangeDeclaration {
  id: string;
  title: string;
  flow: string;
  risk: Risk;
  impact: Impact[];
  baseline_commit: string;
}
export interface Scope {
  scheme: string;
  paths: string[];
}
export interface WorkPackage {
  id: string;
  title: string;
  depends_on: string[];
  paths: string[];
  verify: { gate: string };
  criteria: Array<{ id: string; text: string }>;
  review: 'none' | 'required';
}
export interface WorkPackages {
  packages: WorkPackage[];
}

export interface LedgerEntry {
  id: string;
  conclusion: string;
  refs: string[];
  signer?: string;
  at?: string;
  note?: string;
  supersedes?: string;
  package?: string;
  baseline_commit?: string;
  paths_changed?: string[];
  revision?: string;
  criteria?: Array<{ id: string; evidence: string }>;
  remaining?: string[];
}
export interface Ledger {
  kind: string;
  conclusion?: string;
  entries: LedgerEntry[];
}

export interface GateRun {
  gate: string;
  run: number;
  at: string;
  revision: string;
  result: 'passed' | 'failed';
  /** 这次运行绑定的输入 glob（${change}、${impl} 已代入）；包级运行与站级运行各有自己的输入集。 */
  inputs?: string[];
  /** 判定依赖站的内置门（structure / ledgers / constitution）记下是哪一站跑的；「当前」还要站相同。 */
  stage?: string;
  exit_code?: number;
  log?: string;
  accepted?: Array<{ ledger: string; digest: string; verdict: 'accepted' | 'rejected'; reasons?: string[] }>;
}

export type ReceiptKind =
  | 'stage-transition'
  | 'rework'
  | 'package-dispatch'
  | 'package-deliver'
  | 'package-integrate'
  | 'package-review'
  | 'archive';

export interface ReceiptInputs {
  gates?: Array<{ gate: string; run: number; revision: string }>;
  ledgers?: Array<{ kind: string; digest: string }>;
  audit_events?: string[];
  paths?: string[];
}
export interface Receipt {
  id: string;
  seq: number;
  kind: ReceiptKind;
  at: string;
  change: string;
  scheme: string;
  prev: string | null;
  from: string;
  to: string;
  subject: Record<string, unknown>;
  execution?: string;
  workdir?: string;
  inputs?: ReceiptInputs;
  revision?: string;
  hash: string;
}

export interface Projection {
  execution: string;
  kind: 'stage' | 'package';
  change: string;
  scheme: string;
  stage: string;
  package?: string;
  workdir: string;
  opened_by: string;
  closed_by: string | null;
  allow: string[];
}

export type AuditKind =
  | 'approval.decided'
  | 'finding.answered'
  | 'entry.decided'
  | 'receipt.signed'
  | 'delivery.confirmed'
  | 'verification.declared'
  | 'scaffold.upgraded';

export interface AuditActor {
  name: string;
  email: string;
}
export interface AuditEvent {
  seq: number;
  at: string;
  kind: AuditKind;
  change?: string;
  scheme?: string;
  subject: Record<string, unknown>;
  actor: AuditActor;
  decision?: 'approved' | 'rejected';
  refs: string[];
  note?: string;
  /** MCP 审批：`mcp:<approver id>`；人批没有这个字段。 */
  via?: string;
  /** MCP 审批：请求这次审批的人的 git 身份（"name <email>"）。 */
  requested_by?: string;
  /** MCP 审批：MCP 回复的 sha256，事后可对。 */
  evidence?: string;
  prev: string | null;
  hash: string;
  hmac: string | null;
}
export interface AuditIndex {
  events: Array<{ hash: string; kind: string; at: string }>;
}

export interface Diagnostic {
  code: string;
  title: string;
  meaning: string;
  remedy: { command?: string; text: string };
  variants: Array<{ seen: string; note: string }>;
}

export type Severity = 'blocking' | 'warning' | 'info';
export interface EnvelopeDiagnostic {
  code: string;
  severity: Severity;
  message: string;
  remedy?: { command?: string; text: string };
}
export interface Envelope<R = unknown> {
  ok: boolean;
  verb: string;
  change?: string;
  scheme?: string;
  result: R;
  diagnostics: EnvelopeDiagnostic[];
  changed: string[];
  next: Array<{ command: string; why: string }>;
}
