// design: rule-files §3.1 — RF-06、RF-16、RF-29 与标记解析。
import { describe, expect, it } from 'vitest';
import { constitutionTitles, deltaOps, entriesBlocks, entryBlocks, headings, localZone, stripLocalZone, transplantLocalZone } from '../../../src/model/markdown.js';

describe('headings (RF-29)', () => {
  it('returns exact level-2 titles, skipping fenced code', () => {
    const text = '# T\n## 背景\ntext\n```\n## 不是标题\n```\n### 三级\n## 目标 \n';
    expect(headings(text)).toEqual(['背景', '目标']);
  });
  it('a qualified title is a different title', () => {
    expect(headings('## 背景（补充）')).toEqual(['背景（补充）']);
    expect(headings('## 背景（补充）')).not.toContain('背景');
  });
});

describe('constitutionTitles (RF-06)', () => {
  it('returns ordered titles', () => {
    expect(constitutionTitles('# 章程\n<!-- xforge:constitution -->\n## A\n## B\n')).toEqual(['A', 'B']);
  });
  it('rejects duplicates with XF-MODEL-003', () => {
    expect(() => constitutionTitles('## A\n## A\n')).toThrowError(/XF-MODEL-003|重复/);
  });
});

describe('entriesBlocks', () => {
  it('extracts marked regions by kind', () => {
    const text = 'intro\n<!-- xforge:entries:begin kind=alternatives -->\n- a\n<!-- xforge:entries:end -->\nrest';
    expect(entriesBlocks(text)).toEqual([{ kind: 'alternatives', body: '- a' }]);
  });
  it('rejects an unclosed region', () => {
    expect(() => entriesBlocks('<!-- xforge:entries:begin kind=x -->\n')).toThrow();
  });
});

describe('local zone (RF-16)', () => {
  const file = '## 本项目\n<!-- xforge:local:begin -->\n我们的约定\n<!-- xforge:local:end -->\n';
  it('parses and strips', () => {
    expect(localZone(file)?.zone.trim()).toBe('我们的约定');
    expect(stripLocalZone(file)).toBe('## 本项目\n<!-- xforge:local:begin --><!-- xforge:local:end -->\n');
  });
  it('transplants the project zone into the incoming file', () => {
    const incoming = '## 判断\n新正文\n## 本项目\n<!-- xforge:local:begin --><!-- xforge:local:end -->\n';
    expect(transplantLocalZone(incoming, file)).toBe('## 判断\n新正文\n## 本项目\n<!-- xforge:local:begin -->\n我们的约定\n<!-- xforge:local:end -->\n');
  });
  it('rejects an unpaired marker', () => {
    expect(() => localZone('<!-- xforge:local:begin -->')).toThrow();
  });
});

describe('entry blocks and delta ops', () => {
  it('parses requirements and elements', () => {
    const body = '### Requirement: REQ-auth-login-001 · 登录\n- **WHEN** x\n### Element: fn:createOrder · 创建订单\nsummary: (i) => o\nbreaking: true\n';
    const blocks = entryBlocks(body);
    expect(blocks.map((b) => b.id)).toEqual(['REQ-auth-login-001', 'fn:createOrder']);
    expect(blocks[1]).toMatchObject({ title: '创建订单', summary: '(i) => o', breaking: true });
  });
  it('an element id may contain spaces', () => {
    const blocks = entryBlocks('### Element: cli:invoice list · 列出发票\nsummary: invoice list\n### Element: endpoint:POST /orders\n');
    expect(blocks.map((b) => [b.id, b.title])).toEqual([['cli:invoice list', '列出发票'], ['endpoint:POST /orders', '']]);
  });
  it('tolerates entries markers inside delta operation blocks', () => {
    const text = '# cli\n\n## ADDED\n\n<!-- xforge:entries:begin kind=elements -->\n### Element: cli:payment add · 记录收款\nsummary: payment add\n<!-- xforge:entries:end -->\n\n## MODIFIED\n\n<!-- xforge:entries:begin kind=elements -->\n### Element: cli:invoice list · 列出发票\nbreaking: false\n<!-- xforge:entries:end -->\n';
    const ops = deltaOps(text);
    expect(ops.added.map((b) => b.id)).toEqual(['cli:payment add']);
    expect(ops.added[0]!.body).not.toContain('xforge:entries');
    expect(ops.modified[0]).toMatchObject({ id: 'cli:invoice list', breaking: false });
  });
  it('splits ADDED / MODIFIED / REMOVED', () => {
    const text = '# 登录\n## ADDED\n### Requirement: REQ-a-b-003 · c\nx\n## MODIFIED\n### Requirement: REQ-a-b-002 · d\ny\n## REMOVED\n### Requirement: REQ-a-b-001\n';
    const ops = deltaOps(text);
    expect(ops.added.map((b) => b.id)).toEqual(['REQ-a-b-003']);
    expect(ops.modified.map((b) => b.id)).toEqual(['REQ-a-b-002']);
    expect(ops.removed.map((b) => b.id)).toEqual(['REQ-a-b-001']);
  });
});
