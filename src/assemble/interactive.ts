// design: cli §5.4 — 装配的问题：探测本机装了哪些宿主，列出来让人勾；答案与 flag 给出的逐字节等价。
import { PROVIDERS, PLATFORMS, provider } from '../hosts/index.js';
import type { Io } from '../cli/envelope.js';
import { askAll, type Choice, type Question, type View } from '../cli/prompt.js';
import type { Language, Platform } from '../model/types.js';
import { detect, homeOf } from './detect.js';

const LANGUAGES: ReadonlyArray<{ id: Language; label: string; note: string }> = [
  { id: 'zh-CN', label: '中文（简体）', note: 'Skills and the prompts the flow hands to agents, in Chinese' },
  { id: 'en', label: 'English', note: 'Skills and the prompts the flow hands to agents, in English' },
];

export interface InitFlags {
  platforms: Platform[];
  language?: Language;
}

export interface Answers {
  platforms: Platform[];
  language: Language;
}

function toolsQuestion(io: Io, home: string): Question {
  const choices: Choice[] = PLATFORMS.map((id) => {
    const p = provider(id);
    const presence = detect(p, io.env, home);
    return { id, label: p.label, note: `${presence.evidence} · ${p.note}`, available: presence.available };
  });
  const none = choices.every((c) => !c.available);
  return {
    title: 'Select the hosts to install into',
    hint: '(↑/↓ move · space toggle · enter confirm)',
    choices,
    multi: true,
    required: none
      ? `Nothing detected. Install ${PLATFORMS.map((id) => PROVIDERS[id].label).join(' or ')}, or pass --platform <name> to choose anyway.`
      : 'At least one tool must be selected.',
  };
}

function languageQuestion(): Question {
  return {
    title: 'Select the language for generated Skills',
    hint: '(↑/↓ move · enter confirm)',
    choices: LANGUAGES.map((l) => ({ id: l.id, label: l.label, note: l.note, available: true })),
    multi: false,
  };
}

/**
 * 交互式装配：先勾宿主，再选语言。已经用 flag 说出来的答案不再问 ——
 * 提问是替没说的部分服务的，说过的部分再问一遍是噪音。
 */
export async function askInit(io: Io, flags: InitFlags): Promise<Answers> {
  const home = homeOf(io.env);
  const questions: Question[] = [];
  if (flags.platforms.length === 0) questions.push(toolsQuestion(io, home));
  if (!flags.language) questions.push(languageQuestion());
  if (questions.length === 0) return { platforms: flags.platforms, language: flags.language ?? 'zh-CN' };
  const view: View = { dim: !io.env['NO_COLOR'], columns: Math.max(20, io.columns) };
  const asked = [...(await askAll(io, questions, view))];
  // 没问的那一半用 flag 的值；问了的那一半按题目顺序取回来。
  const platforms = flags.platforms.length ? flags.platforms : ((asked.shift() ?? []) as Platform[]);
  const language = flags.language ?? ((asked.shift()?.[0] ?? 'zh-CN') as Language);
  return { platforms, language };
}
