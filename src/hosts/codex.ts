// design: skills §5 — codex 宿主：Skill 到 .codex/skills，AGENTS.md 标记块内一句入口说明，执法钩子到 .codex/hooks.json。
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readText } from '../fs/transaction.js';
import type { Hook, Platform } from '../model/types.js';
import { enforceCommand, generatedNote, HOOK_EVENTS, hasMarkerBlock, mergeMarkerBlock, parseHostJson, SKILL_PREFIX, stripMarkerBlock, type HostCapabilities, type HostFile, type HookEntry, type HostProvider } from './shared.js';

const ID: Platform = 'codex';

const SKILLS_DIR = '.codex/skills';
const HOOKS = '.codex/hooks.json';
const AGENTS = 'AGENTS.md';

/**
 * `AGENTS.md` 标记块里的入口说明。执法那句**由能力推出来**，不写死 ——
 * 否则这个宿主哪天装上钩子了，这段话会继续谎报 `enforcement: unavailable`。
 */
function agentsBlock(caps: HostCapabilities): string {
  return [
    '本项目由 XForge 治理。推进当前 Change 用 `xforge` Skill（.codex/skills/xforge/SKILL.md）；',
    '控制面的回答以 `xforge state` 为准，需要正文用 `xforge show <ref>`。',
    caps.enforcement === 'hook'
      ? '这个宿主装了执法钩子（.codex/hooks.json）：写入范围由权限策略拦。钩子要人在 `/hooks` 里过一遍才会跑，改过之后要再过一遍。'
      : '这个宿主没有执法钩子：写入范围由人复核，`xforge state --orient` 会报 `enforcement: unavailable`。',
  ].join('\n');
}

const CAPABILITIES: HostCapabilities = { enforcement: 'hook', isolation: false };

export const codexProvider: HostProvider = {
  id: ID,
  label: 'Codex CLI',
  note: 'Skills, an AGENTS.md entry point and the enforcement hook; no isolated executor here.',
  capabilities: CAPABILITIES,
  hookFile: HOOKS,
  detection: { binaries: ['codex'], sessionEnv: ['CODEX_SANDBOX', 'CODEX_HOME'], homeConfigDir: '.codex' },

  async files(ctx): Promise<HostFile[]> {
    const out: HostFile[] = [];
    for (const s of ctx.skills) out.push({ path: join(ctx.root, SKILLS_DIR, s.name, 'SKILL.md'), content: generatedNote(s.text) });
    const agentsPath = join(ctx.root, AGENTS);
    out.push({ path: agentsPath, content: mergeMarkerBlock((await readText(agentsPath)) ?? '', agentsBlock(CAPABILITIES)) });
    out.push({ path: join(ctx.root, HOOKS), content: await hooksWithEnforce(join(ctx.root, HOOKS), ctx.hook) });
    return out;
  },

  async ownership(root): Promise<string[]> {
    const out: string[] = [];
    const skills = join(root, SKILLS_DIR);
    if (existsSync(skills)) for (const d of readdirSync(skills)) if (d === SKILL_PREFIX || d.startsWith(`${SKILL_PREFIX}-`)) out.push(join(skills, d));
    return out;
  },

  async detach(root): Promise<string[]> {
    const out: string[] = [];
    const hooksPath = join(root, HOOKS);
    const hooksText = await readText(hooksPath);
    if (hooksText) {
      const config = parseHostJson(hooksText);
      const hooks = config?.['hooks'] as Record<string, HookEntry[]> | undefined;
      const ours = `${enforceCommand(null, ID)}`;
      let touched = false;
      for (const [event, entries] of Object.entries(hooks ?? {})) {
        const kept = entries.filter((e) => !(e.hooks ?? []).some((h) => h.command?.startsWith(ours)));
        if (kept.length !== entries.length) {
          hooks![event] = kept;
          touched = true;
        }
      }
      if (touched && config) {
        writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n');
        out.push(`${relative(root, hooksPath)}#hooks.PreToolUse`);
      }
    }
    const agentsPath = join(root, AGENTS);
    const agentsText = await readText(agentsPath);
    if (agentsText && hasMarkerBlock(agentsText)) {
      writeFileSync(agentsPath, stripMarkerBlock(agentsText));
      out.push(`${relative(root, agentsPath)}#XFORGE`);
    }
    return out;
  },
};

/**
 * 在现有 hooks.json 里加（或保留）执法钩子；其余条目靠命令串识别、逐字节保留。
 * 读不懂的 JSON **不动**（同 claude 的 settings.json）：覆盖它等于把别人的钩子删了；
 * 投影里就没有我们的钩子，`doctor` 的能力检查会说「声明的执法能力兑不了现」（cli §5.5）。
 */
async function hooksWithEnforce(path: string, hook: Hook | null): Promise<string> {
  const text = await readText(path);
  let config: Record<string, unknown> = {};
  if (text) {
    const parsed = parseHostJson(text);
    if (!parsed) return text;
    config = parsed;
  }
  if (hook) {
    const command = enforceCommand(hook, ID);
    const hooks = (config['hooks'] as Record<string, HookEntry[]> | undefined) ?? {};
    for (const event of hook.events) {
      const name = HOOK_EVENTS[event];
      const entries = hooks[name] ?? [];
      // `matcher` 空串 = 每个工具调用都过这道钩子（codex 与 claude 同义）。
      if (!entries.some((e) => e.hooks?.some((h) => h.command === command))) entries.push({ matcher: '', hooks: [{ type: 'command', command, timeout: 30 }] });
      hooks[name] = entries;
    }
    config['hooks'] = hooks;
  }
  return JSON.stringify(config, null, 2) + '\n';
}
