// design: rule-files §3.7 — 构建时生成 scaffold/integrity.yaml；scaffold/ 不存在时什么都不做。
import { access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { computeIntegrity, INTEGRITY_FILE } from '../dist/model/integrity.js';
import { toYaml } from '../dist/model/yaml.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const scaffoldDir = `${root}scaffold`;
try {
  await access(scaffoldDir);
} catch {
  process.exit(0);
}
const { version } = JSON.parse(await (await import('node:fs/promises')).readFile(`${root}package.json`, 'utf8'));
const integrity = await computeIntegrity(scaffoldDir, version);
await writeFile(`${scaffoldDir}/${INTEGRITY_FILE}`, toYaml(integrity));
console.log(`integrity: ${Object.keys(integrity.files).length} files`);
