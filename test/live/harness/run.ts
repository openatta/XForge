// design: live-test §3 §4 D12 — 循环：一轮模型 → state → 人 → 下一轮；archived 后跑 oracle、篡改检测、写 summary。
// LT-06：stepwise 驱动每轮只点名一个站 Skill，名字来自 harness 自己的 state --orient；每轮记模型有没有报下一步。
// LT-07：归档后核对规格 delta 里的每条 Requirement 都被模型自写的测试或 assurance.md 的覆盖表引用；规格治理开着时缺一条就判失败。
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTurn, type TurnResult } from './engine.js';
import { engineEnv, engineModel, type Engine } from './env.js';
import { assemblyProblems, probeAssembly } from './assembly.js';
import { plantDesignFault, PLANTED_SENTENCE, tamperReceiptAndInspect } from './faults.js';
import { actAsHuman, type Blocker, type HumanContext } from './human.js';
import { runOracle } from './oracle.js';
import { observe, renderSummary, sumUsage, transcriptFiles, type Summary } from './score.js';
import { governanceFlags, runPaths, setupProject, type Governance } from './setup.js';
import { logXforgeTo, repoRoot, useInstalledBin, xforge } from './xforge.js';

export type Scenario = 'quick' | 'solid' | 'major' | 'solid-rework';

export const SCENARIOS: Record<Scenario, { flow: 'quick' | 'solid' | 'major'; request: string; oracle: string; expect: { outcome: 'archived'; reworks: number | { max: number } }; plant?: true }> = {
  quick: { flow: 'quick', request: 'quick.md', oracle: 'test_quick.py', expect: { outcome: 'archived', reworks: 0 } },
  solid: { flow: 'solid', request: 'solid.md', oracle: 'test_solid.py', expect: { outcome: 'archived', reworks: 0 } },
  major: { flow: 'major', request: 'major.md', oracle: 'test_major.py', expect: { outcome: 'archived', reworks: { max: 1 } } },
  'solid-rework': { flow: 'solid', request: 'solid.md', oracle: 'test_solid.py', expect: { outcome: 'archived', reworks: 1 }, plant: true },
};

export type Driver = 'orchestrated' | 'stepwise';

export interface RunOptions {
  engine: Engine;
  scenario: Scenario;
  language: 'zh-CN' | 'en';
  governance?: Governance;
  driver?: Driver;
  approver?: 'human' | 'mcp';
  maxTurns?: number;
  turnTimeoutMs?: number;
}

const FIRST_PROMPT = (request: string): string =>
  `${request.trim()}\n\n---\n用 /xforge 推进这个 Change，直到控制面报 archived 或需要人为止。` +
  `把我当作已经把需求说清的用户：propose 与 clarify 站里拿不准的地方按需求文档里的默认值定，把假设写进提案；不要向我提问，也不要等我。` +
  `需要人做的事（审批、署名、确认交付）我会在你停下之后做，你只要停下并说明。` +
  `治理开关以 xforge/manifest.yaml 里写的为准，那是我定的，不要问我要不要打开；关着的基线对应的影响面不要声明。`;
const NEXT_PROMPT = '/xforge 继续推进当前 Change。人该做的事已经做完；先跑 xforge state 看现在欠什么，从那里继续。';
// D14 mcp：审批由 MCP 审批者给，模型自己跑 state 给的 --via 命令，不问人。
const MCP_POSTURE = '审批不由我给：清单里配了 MCP 审批者，xforge state 的补救命令带 --via 的你直接跑，它回的就是审批结果，不用问我、不用等我。';

// D12 stepwise：模拟用户自己逐站推进 —— 提示只点名一个站 Skill，不提 /xforge。
const POSTURE = `把我当作已经把需求说清的用户：拿不准的地方按需求文档里的默认值定，把假设写进提案；不要向我提问，也不要等我。` +
  `需要人做的事（审批、署名、确认交付）我会在你停下之后做，你只要停下并说明。做完这一站就停下，告诉我下一步该用哪个 Skill 指令。` +
  `治理开关以 xforge/manifest.yaml 里写的为准，那是我定的，不要问我要不要打开；关着的基线对应的影响面不要声明。`;
const STEP_FIRST = (request: string, skill: string): string => `${request.trim()}\n\n---\n/${skill} 做这一站。我自己逐站推进，不用 /xforge。${POSTURE}`;
const STEP_NEXT = (skill: string): string => `/${skill} 继续这一站。人该做的事已经做完；先跑 xforge state --orient 看现在欠什么，从那里继续。${POSTURE}`;
const FIRST_SKILL = 'xforge-propose'; // 没有 Change 时定向里没有站；用户知道第一站是 propose。

/** 结果文本里有没有报下一步的 Skill 指令（SK-13 的 live 观测）。 */
export function mentionsNextSkill(text: string): boolean {
  return /\/xforge-[a-z]+/.test(text);
}

export async function runScenario(opts: RunOptions): Promise<Summary> {
  const spec = SCENARIOS[opts.scenario];
  const scenarioDir = join(repoRoot, 'test', 'live', 'scenarios', 'invoicely');
  const governance: Governance = opts.governance ?? 'TT';
  const driver: Driver = opts.driver ?? 'orchestrated';
  const approver = opts.approver ?? 'human';
  const label = [opts.scenario, ...(governance === 'TT' ? [] : [governance]), ...(driver === 'stepwise' ? ['stepwise'] : []), ...(approver === 'mcp' ? ['mcp'] : [])].join('-');
  const paths = runPaths(repoRoot, opts.engine, label);
  mkdirSync(paths.runDir, { recursive: true });
  logXforgeTo(join(paths.runDir, 'xforge-commands.log'));
  const request = readFileSync(join(scenarioDir, 'requests', spec.request), 'utf8');
  await setupProject(paths, { repoRoot, scenarioDir, flow: spec.flow, language: opts.language, request, engine: opts.engine, governance, approver, mcpLog: join(paths.runDir, 'mcp-requests.log') });
  const baselineBefore = baselineDigest(paths.project);
  useInstalledBin(join(paths.workDir, 'pkg', 'node_modules', '@xforge', 'cli', 'bin', 'xforge.js'));
  const env = engineEnv(opts.engine, repoRoot, paths.claudeConfig, paths.shim);
  const model = engineModel(env);
  const maxTurns = opts.maxTurns ?? (driver === 'stepwise' ? 30 : 15);
  let hinted = 0;
  const turns: TurnResult[] = [];
  const humanActions: Summary['human_actions'] = [];
  const blockedTokens: string[] = [];
  let outcome = 'unknown';
  let stoppedAt: string | null = null;
  let changeId: string | null = null;
  let planted = false;
  let reworked = false;
  let lastBlockerKey = '';
  let stall = 0;

  // solid-rework：设计一落盘、还没出 design 站时就植入矛盾句，模拟设计与 check 之间有人改了设计。
  const tick = spec.plant
    ? (): void => {
        if (planted) return;
        const changes = existsSync(join(paths.project, 'xforge', 'changes')) ? readdirSync(join(paths.project, 'xforge', 'changes')) : [];
        for (const id of changes) {
          const design = join(paths.project, 'xforge', 'changes', id, 'design.md');
          const receipts = join(paths.project, 'xforge', 'changes', id, 'evidence', 'receipts');
          if (!existsSync(design)) continue;
          const leftDesign = existsSync(receipts) && readdirSync(receipts).some((f) => f.endsWith('-stage-transition.yaml') && readFileSync(join(receipts, f), 'utf8').includes('from: design'));
          if (leftDesign) continue;
          if (!readFileSync(design, 'utf8').includes('## 失败模式')) continue;
          planted = plantDesignFault(paths.project, id);
        }
      }
    : undefined;
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    let prompt = turn === 1 ? FIRST_PROMPT(request) : NEXT_PROMPT;
    if (driver === 'stepwise') {
      const skill = await currentSkill(paths.project, changeId);
      if (skill === null) {
        outcome = 'stopped';
        stoppedAt = 'no stage skill to call';
        break;
      }
      prompt = turn === 1 ? STEP_FIRST(request, skill) : STEP_NEXT(skill);
    }
    if (approver === 'mcp') prompt += MCP_POSTURE;
    const t = await runTurn({ turn, prompt, cwd: paths.project, env, transcriptsDir: paths.transcripts, model, timeoutMs: opts.turnTimeoutMs ?? 40 * 60_000, ...(tick ? { tick } : {}) });
    turns.push(t);
    if (driver === 'stepwise' && mentionsNextSkill(t.resultText)) hinted += 1;
    if (t.isError) {
      outcome = 'engine-error';
      stoppedAt = t.resultText.slice(0, 200) || '(no result)';
      break;
    }
    // 归档后不带 --change 的 state 会说 no-change；知道 id 之后一律点名。
    const state = await xforge(paths.project, changeId ? ['state', '--change', changeId] : ['state']);
    const result = state.env.result as { position?: { stage: string | null; status: string }; blockers?: Blocker[]; packages?: Array<{ id: string; state: string }> };
    const status = result.position?.status ?? 'unknown';
    const stage = result.position?.status === 'in-stage' ? (result.position.stage ?? null) : null;
    if (state.env.change) changeId = state.env.change;
    if (status === 'archived') {
      outcome = 'archived';
      break;
    }
    if (status === 'no-change') {
      if (turn >= 3) {
        outcome = 'stopped';
        stoppedAt = 'no-change';
        break;
      }
      continue;
    }
    // 轮询没赶上（设计写完就立刻出站）时的兜底：到了 check 站再植。
    if (spec.plant && !planted && changeId && stage === 'check') {
      planted = plantDesignFault(paths.project, changeId);
      humanActions.push({ turn, action: 'plant design fault (late)', ok: planted });
    }
    const blockers = result.blockers ?? [];
    if (changeId) {
      const ctx: HumanContext = { project: paths.project, changeId, reworked, packages: result.packages ?? [], approver, ...(spec.plant ? { plantedSentence: PLANTED_SENTENCE } : {}) };
      const acted = await actAsHuman(ctx, blockers, stage);
      reworked = ctx.reworked;
      for (const a of acted) humanActions.push({ turn, ...a });
    }
    const after = await xforge(paths.project, changeId ? ['state', '--change', changeId] : ['state']);
    const afterResult = after.env.result as { position?: { status: string; stage: string | null }; blockers?: Blocker[] };
    if (afterResult.position?.status === 'ready-to-archive' && !(afterResult.blockers ?? []).length) {
      const archived = await xforge(paths.project, ['advance', '--archive']);
      if (archived.exit === 0) {
        outcome = 'archived';
        humanActions.push({ turn, action: 'advance --archive', ok: true });
        break;
      }
      // 条件全满足而归档失败，是控制面的缺陷，不是模型能修的：立刻停，不空转。
      humanActions.push({ turn, action: 'advance --archive', ok: false, detail: archived.stderr.split('\n')[0] || JSON.stringify(archived.env.diagnostics) });
      outcome = 'archive-failed';
      stoppedAt = `ready-to-archive: exit ${archived.exit}`;
      break;
    }
    // 停滞 = 连续几轮位置与阻塞都没变；没有阻塞却不动（模型在等一个人回答）也算。
    const key = `${afterResult.position?.stage ?? afterResult.position?.status}|${(afterResult.blockers ?? []).map((b) => b.token).sort().join(',')}`;
    if (key === lastBlockerKey) stall += 1;
    else stall = 0;
    lastBlockerKey = key;
    for (const b of afterResult.blockers ?? []) if (!blockedTokens.includes(b.token)) blockedTokens.push(b.token);
    if (stall >= 3) {
      outcome = 'stalled';
      stoppedAt = `${afterResult.position?.stage ?? afterResult.position?.status}: ${key}`;
      break;
    }
    if (turn === maxTurns) {
      outcome = 'max-turns';
      stoppedAt = `${afterResult.position?.stage ?? afterResult.position?.status}: ${key}`;
    }
  }

  // 收尾：oracle、inspect、篡改、转录、快照。
  const oracle = outcome === 'archived' ? await runOracle(paths.project, join(scenarioDir, 'oracle', spec.oracle)) : { ran: 0, failed: 0, output: '' };
  writeFileSync(join(paths.runDir, 'oracle.txt'), oracle.output);
  const inspect = changeId ? await xforge(paths.project, ['inspect', '--change', changeId, '--hygiene']) : await xforge(paths.project, ['inspect', '--all']);
  const tamper = outcome === 'archived' && changeId ? await tamperReceiptAndInspect(paths.project, changeId) : null;
  // LT-09/10/11：真机上把装配面的「验」与「修」各走一遍 —— 注入一处投影漂移，看 repair 能不能收敛。
  const assembly = await probeAssembly(paths.project, () => {
    const skill = join(paths.project, '.claude', 'skills', 'xforge', 'SKILL.md');
    if (existsSync(skill)) appendFileSync(skill, '\n<!-- live drift -->\n');
  });
  writeFileSync(join(paths.runDir, 'workdir.txt'), paths.workDir + '\n');
  const sessionsSrc = join(paths.claudeConfig, 'projects');
  const sessionsDst = join(paths.runDir, 'sessions');
  if (existsSync(sessionsSrc)) cpSync(sessionsSrc, sessionsDst, { recursive: true });
  if (changeId) cpSync(join(paths.project, 'xforge', 'changes', changeId), join(paths.runDir, 'change'), { recursive: true });
  let reworks = 0;
  if (changeId) {
    const receipts = join(paths.project, 'xforge', 'changes', changeId, 'evidence', 'receipts');
    if (existsSync(receipts)) reworks = readdirSync(receipts).filter((n) => n.endsWith('-rework.yaml')).length;
  }
  const baselineAfter = baselineDigest(paths.project);
  const requirementCoverage = outcome === 'archived' && changeId && governanceFlags(governance).spec ? requirementCoverageOf(paths.project, changeId) : null;
  const summary: Summary = {
    engine: opts.engine,
    scenario: opts.scenario,
    language: opts.language,
    governance,
    driver,
    approver,
    mcp_approvals: countMcpApprovals(paths.project),
    next_skill_hints: driver === 'stepwise' ? { turns: turns.length, hinted } : null,
    requirement_coverage: requirementCoverage,
    baseline_changed: { spec: baselineBefore.spec !== baselineAfter.spec, interface: baselineBefore.interface !== baselineAfter.interface },
    model: turns.find((t) => t.model)?.model ?? model,
    outcome,
    stopped_at: stoppedAt,
    turns: turns.length,
    reworks,
    oracle: { ran: oracle.ran, failed: oracle.failed },
    inspect_exit: inspect.exit,
    assembly,
    tamper,
    tokens: { ...sumUsage(turns), per_turn: turns.map((t) => ({ turn: t.turn, ...t.usage, duration_ms: t.durationMs, num_turns: t.numTurns })) },
    observations: observe(transcriptFiles(paths.transcripts, sessionsDst)),
    human_actions: humanActions,
    blocked_tokens: blockedTokens,
    run_dir: paths.runDir,
  };
  writeFileSync(join(paths.runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(paths.runDir, 'summary.md'), renderSummary(summary));
  return summary;
}

/** stepwise：用户此刻该敲哪个站 Skill —— harness 自己看定向，模型看不到这次调用。 */
async function currentSkill(project: string, changeId: string | null): Promise<string | null> {
  const r = await xforge(project, changeId ? ['state', '--orient', '--change', changeId] : ['state', '--orient']);
  const result = r.env.result as { position?: { status: string }; orient?: { stage: { skill: string } | null } };
  if (result.orient?.stage?.skill) return result.orient.stage.skill;
  if (result.position?.status === 'no-change') return FIRST_SKILL;
  return null;
}

/** LT-08：审计链里带 via 的审批事件数（MCP 批的）。 */
function countMcpApprovals(project: string): number {
  const chain = join(project, 'xforge', '.audit', 'chain.jsonl');
  if (!existsSync(chain)) return 0;
  return readFileSync(chain, 'utf8').split('\n').filter((l) => l.includes('"approval.decided"') && l.includes('"via":"mcp:')).length;
}

/** LT-07：Change 规格 delta 里的 Requirement id，对模型自写的测试（tests/**）与保证说明的覆盖表逐条找引用。 */
function requirementCoverageOf(project: string, changeId: string): { total: number; covered: number; missing: string[] } {
  const specDir = join(project, 'xforge', 'changes', changeId, 'specs');
  const ids = new Set<string>();
  if (existsSync(specDir)) {
    for (const f of readdirSync(specDir, { recursive: true }) as string[]) {
      if (!f.endsWith('.md')) continue;
      for (const m of readFileSync(join(specDir, f), 'utf8').matchAll(/^###\s+Requirement:\s+(REQ-[a-z0-9-]+-\d{3})/gm)) ids.add(m[1]!);
    }
  }
  const haystack: string[] = [];
  const testsDir = join(project, 'tests');
  if (existsSync(testsDir)) for (const f of readdirSync(testsDir, { recursive: true }) as string[]) if (f.endsWith('.py')) haystack.push(readFileSync(join(testsDir, f), 'utf8'));
  const assurance = join(project, 'xforge', 'changes', changeId, 'assurance.md');
  if (existsSync(assurance)) haystack.push(readFileSync(assurance, 'utf8'));
  const text = haystack.join('\n');
  const missing = [...ids].filter((id) => !text.includes(id)).sort();
  return { total: ids.size, covered: ids.size - missing.length, missing };
}

/** 两条基线目录（含索引）的内容摘要，用来判归档到底动没动基线。 */
function baselineDigest(project: string): { spec: string; interface: string } {
  const digest = (dir: string): string => {
    if (!existsSync(dir)) return 'absent';
    const files = readdirSync(dir, { recursive: true }) as string[];
    return files.filter((f) => !f.endsWith('/')).sort().map((f) => { try { return `${f}:${readFileSync(join(dir, f), 'utf8').length}:${readFileSync(join(dir, f), 'utf8')}`; } catch { return f; } }).join('\u0000');
  };
  return { spec: digest(join(project, 'xforge', 'specs')), interface: digest(join(project, 'xforge', 'interfaces')) };
}

export function meetsExpectation(s: Summary, scenario: Scenario): string[] {
  const spec = SCENARIOS[scenario];
  const problems: string[] = [];
  // 治理组合：开着的那条基线归档后必须动了（场景都带 delta），关着的必须一字不变。
  const g = governanceFlags(s.governance);
  if (s.outcome === 'archived') {
    if (g.spec !== s.baseline_changed.spec) problems.push(`规格基线 ${s.baseline_changed.spec ? '动了' : '没动'}，而 governance.spec=${g.spec}`);
    if (g.interface !== s.baseline_changed.interface) problems.push(`接口基线 ${s.baseline_changed.interface ? '动了' : '没动'}，而 governance.interface=${g.interface}`);
  }
  if (s.outcome !== spec.expect.outcome) problems.push(`outcome ${s.outcome} ≠ ${spec.expect.outcome}`);
  const r = spec.expect.reworks;
  if (typeof r === 'number' ? s.reworks !== r : s.reworks > r.max) problems.push(`reworks ${s.reworks} 不符合期望 ${JSON.stringify(r)}`);
  if (s.oracle.failed !== 0 || s.oracle.ran === 0) problems.push(`oracle ${s.oracle.ran - s.oracle.failed}/${s.oracle.ran}`);
  if (s.inspect_exit !== 0) problems.push(`inspect 退出码 ${s.inspect_exit}`);
  if (s.tamper && (s.tamper.exit !== 3 || !s.tamper.codes.includes('XF-INSPECT-001'))) problems.push(`篡改未被检出：${JSON.stringify(s.tamper)}`);
  // LT-09/10/11：装配面在真机上也要干净、doctor 不写盘、注入的漂移被 repair 收敛。
  if (s.assembly) problems.push(...assemblyProblems(s.assembly));
  // LT-07：规格治理开着，delta 里的每条 Requirement 都得有测试或覆盖表引用；一条没有就是「做了却没证明」。
  if (s.requirement_coverage && s.requirement_coverage.missing.length) problems.push(`Requirement 没有测试或覆盖表引用：${s.requirement_coverage.missing.join('、')}`);
  if (s.requirement_coverage && s.requirement_coverage.total === 0) problems.push('规格治理开着却没有任何 Requirement delta');
  // LT-08：mcp 审批模式下，归档的场景每个审批点都该是 MCP 批的。
  const approvalPoints: Record<Scenario, number> = { quick: 1, solid: 2, 'solid-rework': 2, major: 3 };
  if (s.approver === 'mcp' && s.outcome === 'archived' && s.mcp_approvals < approvalPoints[scenario]) problems.push(`MCP 审批 ${s.mcp_approvals} 次，少于流程的审批点数 ${approvalPoints[scenario]}`);
  return problems;
}
