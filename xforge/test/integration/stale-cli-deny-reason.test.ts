import { describe, expect, it } from 'vitest';
import { hookFailureOutput } from '../../src/commands/hook.js';

/**
 * What a hook says when it refuses because the running CLI is not the project's.
 *
 * A CLI too old for a project validates its files against its own older schemas, so the first error
 * it finds is that `lock.yaml` carries fields it does not recognise. That describes the reader, not
 * the project — and as a hook's deny reason it sends an operator to edit a governance file that is
 * not wrong. A live run met it: a 0.7.20 binary on PATH against a 0.8.1 project, every tool call
 * denied, and the stated cause `/paths must NOT have additional properties` on `xforge/lock.yaml`.
 *
 * The identity mismatch explains every other complaint the run makes, so it is what the refusal
 * carries and `cli.ts` picks it ahead of any other error.
 */
describe('the deny reason from a stale CLI', () => {
  const identity = 'Declared CLI npm:@xforge/cli@0.8.1 does not match running CLI npm:@xforge/cli@0.7.20.';

  it('says the version is wrong and that the rest was read with the wrong schemas', () => {
    const output = hookFailureOutput('claude', 'agent.tool.before', identity) as any;
    const reason = output.hookSpecificOutput.permissionDecisionReason as string;
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(reason).toContain('does not match running CLI');
    expect(reason).toContain("read with the wrong version's schemas");
    expect(reason).toContain('xforge update');
  });

  it('leaves an ordinary failure reason alone', () => {
    const output = hookFailureOutput('claude', 'agent.tool.before', '/paths must NOT have additional properties') as any;
    const reason = output.hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain('/paths must NOT have additional properties');
    expect(reason).not.toContain("wrong version's schemas");
  });
});
