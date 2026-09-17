// design: rule-files §3.4 §3.7 — RF-14、RF-15、RF-16 与升级分类。
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyFile, computeIntegrity, fileChecksum } from '../../../src/model/integrity.js';
import { coversCwd, globCoveredBy, inFlightFor, intersectAllow, isInFlight } from '../../../src/model/projection.js';
import type { Projection } from '../../../src/model/types.js';

const base: Projection = { execution: 'EX-20260915-a7k2q9', kind: 'stage', change: 'C-20260915-x', scheme: 'default', stage: 'apply', workdir: '/w', opened_by: 'R-0001', closed_by: null, allow: ['src/**'] };

describe('projection', () => {
  it('RF-14 in-flight is decided by closed_by alone', () => {
    expect(isInFlight(base)).toBe(true);
    expect(isInFlight({ closed_by: 'R-0002' })).toBe(false);
  });
  it('workdir covers itself and its descendants only', () => {
    expect(coversCwd('/w', '/w')).toBe(true);
    expect(coversCwd('/w', '/w/src')).toBe(true);
    expect(coversCwd('/w', '/other')).toBe(false);
    expect(coversCwd('/w/pkg', '/w')).toBe(false);
  });
  it('intersects allow lists across in-flight projections', () => {
    const pkg: Projection = { ...base, kind: 'package', package: 'P-01', execution: 'EX-20260915-b7k2q9', allow: ['src/core/**'] };
    const inFlight = inFlightFor([base, pkg, { ...pkg, closed_by: 'R-0003' }], '/w/src');
    expect(inFlight).toHaveLength(2);
    const matches = (glob: string, path: string): boolean => globCoveredBy([glob], path);
    const allowed = intersectAllow(inFlight, matches);
    expect(allowed('src/core/a.ts')).toBe(true);
    expect(allowed('src/other/a.ts')).toBe(false);
    expect(intersectAllow([], matches)('anything')).toBe(true);
  });
  it('RF-15 package paths must sit inside the scope', () => {
    expect(globCoveredBy(['src/**', 'test/**'], 'src/core/**')).toBe(true);
    expect(globCoveredBy(['src/**'], 'docs/**')).toBe(false);
    expect(globCoveredBy(['**'], 'anything')).toBe(true);
  });
});

describe('integrity (RF-16)', () => {
  const zone = (text: string): string => `## 本项目\n<!-- xforge:local:begin -->${text}<!-- xforge:local:end -->\n`;
  it('the checksum ignores the local zone', () => {
    expect(fileChecksum(zone(''))).toBe(fileChecksum(zone('\n我们的约定\n')));
    expect(fileChecksum('a')).not.toBe(fileChecksum('b'));
  });
  it('classifies files for the upgrade transaction', () => {
    const shipped = zone('');
    const recorded = fileChecksum(shipped);
    expect(classifyFile(recorded, shipped)).toBe('unchanged');
    expect(classifyFile(recorded, zone('\n'))).toBe('unchanged'); // 出厂的空区域（带换行）不算填过
    expect(classifyFile(recorded, zone('\n加一句\n'))).toBe('local-zone-only');
    expect(classifyFile(recorded, '## 判断\n改了正文\n' + shipped)).toBe('modified');
    expect(classifyFile(undefined, shipped)).toBe('new');
    expect(classifyFile(recorded, undefined)).toBe('missing');
  });
  it('computes a sorted manifest over a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scaffold-'));
    await mkdir(join(dir, 'flows'), { recursive: true });
    await writeFile(join(dir, 'flows', 'solid.yaml'), 'name: solid\n');
    await writeFile(join(dir, 'a.md'), zone('\nlocal\n'));
    await writeFile(join(dir, 'integrity.yaml'), 'ignored\n');
    const integrity = await computeIntegrity(dir, '1.0.0-alpha.1');
    expect(Object.keys(integrity.files)).toEqual(['a.md', 'flows/solid.yaml']);
    expect(integrity.files['a.md']).toBe(fileChecksum(zone('')));
  });
});
