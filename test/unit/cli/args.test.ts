// design: cli §1.2 — CLI-54：两种写法等价、开关不吃后面的词、逗号只在列表取值时拆。
import { describe, expect, it } from 'vitest';
import { flagBool, flagList, flagString, flagValues, parseArgs } from '../../../src/cli/args.js';

describe('参数解析（CLI-54）', () => {
  it('同一个 key 两种写法累加出同一组值', () => {
    const spaced = parseArgs(['sync', '--platform', 'claude', '--platform', 'codex']);
    const equals = parseArgs(['sync', '--platform=claude', '--platform=codex']);
    expect(flagList(spaced, 'platform')).toEqual(['claude', 'codex']);
    // = 形式曾经是覆盖：给两个宿主只投了后一个，而且一声不吭。
    expect(flagList(equals, 'platform')).toEqual(flagList(spaced, 'platform'));
  });

  it('只认开关的 --flag 不吃后面的位置参数', () => {
    const p = parseArgs(['show', '--text', 'receipts']);
    expect(flagBool(p, 'text')).toBe(true);
    expect(p.positional).toEqual(['show', 'receipts']); // receipts 曾经被当成 --text 的值吞掉
  });

  it('逗号只在按列表取值时才拆', () => {
    const p = parseArgs(['attest', 'verification', '--command', 'test=npm run a,b']);
    expect(flagValues(p, 'command')).toEqual(['test=npm run a,b']);
    expect(flagList(p, 'gate')).toEqual([]);
    expect(flagList(parseArgs(['run', '--gate', 'a,b']), 'gate')).toEqual(['a', 'b']);
  });

  it('flagString 取最后一次给的值', () => {
    expect(flagString(parseArgs(['x', '--change', 'a', '--change', 'b']), 'change')).toBe('b');
    expect(flagString(parseArgs(['x', '--text']), 'text')).toBeUndefined();
  });
});
