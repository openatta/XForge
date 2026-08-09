import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAuditEvents, recordAudit, retryAuditDelivery, verifyAudit } from '../../src/core/audit.js';
import { loadProject } from '../../src/core/project-loader.js';
import { changeYaml, fixture, runCli, write } from '../helpers.js';

afterEach(() => {
  delete process.env.XFORGE_AUDIT_ENDPOINT;
  delete process.env.XFORGE_AUDIT_TOKEN;
  delete process.env.XFORGE_AUDIT_HMAC_SECRET;
});

describe('enterprise audit', () => {
  it('detects local hash-chain tampering', async () => {
    const root = await fixture();
    const project = await loadProject(root, { exactRoot: true });
    await recordAudit(project, { eventType: 'test.event', change: null, outcome: 'succeeded', input: { secret: 'not-persisted' } });
    expect((await verifyAudit(project)).valid).toBe(true);
    const log = path.join(root, 'xforge', '.audit', 'events.jsonl');
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    const event = JSON.parse(lines[0]!);
    event.reason = 'tampered';
    lines[0] = JSON.stringify(event);
    await writeFile(log, `${lines.join('\n')}\n`);
    const verification = await verifyAudit(project);
    expect(verification.valid).toBe(false);
    expect(verification.diagnostics.map((item) => item.code)).toContain('XFORGE_AUDIT_HASH_INVALID');
  });

  it('spools a failed remote append and clears the per-change debt on retry', async () => {
    let accept = false;
    const received: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'));
        response.statusCode = accept ? 204 : 503;
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('HTTP test server did not bind.');
      process.env.XFORGE_AUDIT_ENDPOINT = `http://127.0.0.1:${address.port}/events`;
      const root = await fixture();
      const project = await loadProject(root, { exactRoot: true });
      await recordAudit(project, { eventType: 'major.test', change: 'major-change', outcome: 'succeeded' });
      expect((await verifyAudit(project, 'major-change')).remotePending).toBe(1);
      expect((await readAuditEvents(project)).some((event) => event.outcome === 'spooled')).toBe(true);
      accept = true;
      expect(await retryAuditDelivery(project)).toMatchObject({ attempted: 1, delivered: 1 });
      expect((await verifyAudit(project, 'major-change')).remotePending).toBe(0);
      expect(received.length).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('makes Major remote debt fail the CI audit verification command', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/major-ci/change.yaml', changeYaml('major'));
    const project = await loadProject(root, { exactRoot: true });
    await recordAudit(project, { eventType: 'stage.entered', change: 'major-ci', flow: 'major', stage: 'propose', outcome: 'succeeded' });
    const result = await runCli(root, ['audit', 'verify', '--change', 'major-ci']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toEqual(expect.arrayContaining(['XFORGE_AUDIT_REMOTE_PENDING', 'XFORGE_AUDIT_EVENT_MISSING']));
  });
});
